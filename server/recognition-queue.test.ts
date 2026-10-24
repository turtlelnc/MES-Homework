import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import { createRecognitionQueue, publicJob } from "./recognition-queue.mjs";
import { seedTeachingFixture } from "./analysis.fixture.mjs";
import { setTimeout as pause } from "node:timers/promises";
let db: DatabaseSync, f: any, submission: any, user: any;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(fs.readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  f = seedTeachingFixture(db);
  submission = db
    .prepare("SELECT * FROM submissions WHERE assignment_id=? LIMIT 1")
    .get(f.assignmentId);
  user = db.prepare("SELECT * FROM users WHERE id=?").get(f.teacherId);
});
afterEach(() => db.close());
const result = { ocrText: "mock", items: [] };
const addSubmission = (id: string) => {
  db.prepare(
    "INSERT INTO submissions(id,assignment_id,student_name,file_path,file_type,status,created_at) VALUES(?,?,?,?,?,?,?)",
  ).run(
    id,
    f.assignmentId,
    "synthetic",
    "/unused.jpg",
    "image/jpeg",
    "uploaded",
    new Date().toISOString(),
  );
  return db.prepare("SELECT * FROM submissions WHERE id=?").get(id);
};
describe("durable recognition", () => {
  it("reduces new claims under pressure without cancelling work already running", async () => {
    let capacity = 1;
    const finish: Array<(r: any) => void> = [];
    const queue = createRecognitionQueue(
      db,
      () => new Promise((resolve) => finish.push(resolve)),
      {
        concurrency: 4,
        userConcurrency: 4,
        availableConcurrency: () => capacity,
      },
    );
    for (let i = 0; i < 4; i++)
      queue.enqueue(addSubmission(`pressure-capacity-${i}`), user);
    const first = queue.tick();
    expect(finish).toHaveLength(1);
    capacity = 0;
    expect(await queue.tick()).toBe(0);
    expect(finish).toHaveLength(1);
    capacity = 4;
    const rest = queue.tick();
    expect(finish).toHaveLength(4);
    finish.forEach((resolve) => resolve(result));
    await Promise.all([first, rest]);
    queue.stop();
    expect(
      Number(
        db
          .prepare(
            "SELECT COUNT(*) n FROM recognition_jobs WHERE status='succeeded'",
          )
          .get()!.n,
      ),
    ).toBe(4);
  });
  it("refills a fast slot without waiting for another slow job, while respecting per-user capacity", async () => {
    const calls: string[] = [];
    const finish = new Map<string, (r: any) => void>();
    const queue = createRecognitionQueue(
      db,
      (job, { signal }) =>
        new Promise((resolve, reject) => {
          calls.push(job.submission_id);
          finish.set(job.submission_id, resolve);
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
      { concurrency: 4, userConcurrency: 2 },
    );
    for (let i = 0; i < 4; i++)
      queue.enqueue(addSubmission(`parallel-${i}`), user);
    const until = async (check: () => boolean) => {
      for (let i = 0; i < 100 && !check(); i++) await pause(10);
      expect(check()).toBe(true);
    };
    queue.start();
    try {
      await until(() => calls.length === 2);
      await pause(30);
      expect(calls).toHaveLength(2);
      const fast = calls[1];
      finish.get(fast)!(result);
      await until(() => calls.length === 3);
      expect(
        db.prepare("SELECT status FROM submissions WHERE id=?").get(calls[0])!
          .status,
      ).toBe("queued");
      expect(
        db
          .prepare("SELECT teacher_reviewed,status FROM submissions WHERE id=?")
          .get(fast),
      ).toMatchObject({ teacher_reviewed: 0, status: "review" });
      expect(
        Number(
          db
            .prepare(
              "SELECT COUNT(*) n FROM recognition_jobs WHERE status='running'",
            )
            .get()!.n,
        ),
      ).toBe(2);
    } finally {
      queue.stop();
      await until(
        () =>
          Number(
            db
              .prepare(
                "SELECT COUNT(*) n FROM recognition_jobs WHERE status='running'",
              )
              .get()!.n,
          ) === 0,
      );
    }
  });
  it("deduplicates, invalidates approval atomically and publishes only to review", async () => {
    const queue = createRecognitionQueue(db, async () => result);
    const job = queue.enqueue(submission, user);
    expect(() => queue.enqueue(submission, user)).toThrow(/正在进行/);
    expect(
      db
        .prepare(
          "SELECT teacher_reviewed,status,score FROM submissions WHERE id=?",
        )
        .get(submission.id),
    ).toMatchObject({ teacher_reviewed: 0, status: "queued", score: null });
    expect(publicJob(job)).not.toHaveProperty("token");
    await queue.tick();
    expect(
      db
        .prepare(
          "SELECT status,teacher_reviewed,ocr_text FROM submissions WHERE id=?",
        )
        .get(submission.id),
    ).toMatchObject({
      status: "review",
      teacher_reviewed: 0,
      ocr_text: "mock",
    });
    expect(db.prepare("SELECT action FROM review_audit").get()).toMatchObject({
      action: "recognition_requested",
    });
  });
  it("bounds pending capacity without invalidating another student's grade", () => {
    const queue = createRecognitionQueue(db, async () => result, {
      maxPending: 1,
    });
    queue.enqueue(submission, user);
    const other = db
      .prepare("SELECT * FROM submissions WHERE id!=? LIMIT 1")
      .get(submission.id)!;
    expect(() => queue.enqueue(other, user)).toThrow(/已满/);
    expect(
      db.prepare("SELECT * FROM submissions WHERE id=?").get(other.id),
    ).toEqual(other);
  });
  it("recovers an expired crash lease and fences off late output", async () => {
    let time = Date.now();
    let resolve!: (result: any) => void;
    const old = createRecognitionQueue(
      db,
      () =>
        new Promise((r) => {
          resolve = r;
        }),
      { now: () => time },
    );
    const job = old.enqueue(submission, user);
    const pending = old.tick();
    time += 160000;
    const restarted = createRecognitionQueue(
      db,
      async () => ({ ocrText: "recovered" }),
      { now: () => time },
    );
    await restarted.tick();
    resolve({ ocrText: "stale" });
    await pending;
    expect(
      db
        .prepare("SELECT ocr_text FROM submissions WHERE id=?")
        .get(submission.id)!.ocr_text,
    ).toBe("recovered");
    expect(
      db
        .prepare("SELECT attempts,status FROM recognition_jobs WHERE id=?")
        .get(job.id),
    ).toMatchObject({ attempts: 2, status: "succeeded" });
  });
  it("retries transient errors only three times, but never retries permanent failures", async () => {
    let time = Date.now(),
      calls = 0;
    const queue = createRecognitionQueue(
      db,
      async () => {
        calls++;
        throw Object.assign(new Error("secret provider response"), {
          retryable: true,
        });
      },
      { now: () => time, retryMs: 1 },
    );
    const job = queue.enqueue(submission, user);
    for (let i = 0; i < 4; i++) {
      await queue.tick();
      time += 100;
    }
    expect(calls).toBe(3);
    expect(
      db
        .prepare("SELECT status,error FROM recognition_jobs WHERE id=?")
        .get(job.id),
    ).toMatchObject({
      status: "failed",
      error: expect.not.stringContaining("secret"),
    });
    const failed = createRecognitionQueue(db, async () => {
      throw new Error("invalid PDF");
    });
    failed.enqueue(submission, user);
    await failed.tick();
    expect(failed.active(submission.id)).toBeUndefined();
  });
  it("waits for model capacity without spending an attempt", async () => {
    const queue = createRecognitionQueue(db, async () => {
      throw Object.assign(new Error("busy"), { code: "MODEL_BUSY" });
    });
    const job = queue.enqueue(submission, user);
    await queue.tick();
    expect(
      db
        .prepare("SELECT attempts,status FROM recognition_jobs WHERE id=?")
        .get(job.id),
    ).toMatchObject({ attempts: 0, status: "queued" });
  });
  it("times out cooperative workers and does not publish their result", async () => {
    const queue = createRecognitionQueue(
      db,
      async (_job, { signal }) => {
        await new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        );
        return result;
      },
      { timeoutMs: 10 },
    );
    queue.enqueue(submission, user);
    await queue.tick();
    expect(
      db
        .prepare("SELECT status FROM submissions WHERE id=?")
        .get(submission.id)!.status,
    ).toBe("failed");
  });
});

it("restores prior reviewed grades when a queued call cannot reserve a budget", async () => {
  const queue = createRecognitionQueue(db, async () => {
    throw Object.assign(new Error("quota"), {
      code: "MODEL_QUOTA",
      status: 429,
    });
  });
  const before = db
    .prepare("SELECT status,teacher_reviewed,score FROM submissions WHERE id=?")
    .get(submission.id);
  queue.enqueue(submission, user);
  await queue.tick();
  expect(
    db
      .prepare(
        "SELECT status,teacher_reviewed,score FROM submissions WHERE id=?",
      )
      .get(submission.id),
  ).toEqual(before);
  expect(
    db
      .prepare(
        "SELECT status,error FROM recognition_jobs WHERE submission_id=?",
      )
      .get(submission.id),
  ).toMatchObject({ status: "failed", error: expect.stringContaining("保留") });
});

it("defers resource pressure without spending an attempt, then resumes", async () => {
  let time = Date.now(),
    pressured = true;
  const queue = createRecognitionQueue(
    db,
    async () => {
      if (pressured)
        throw Object.assign(new Error("memory pressure"), { status: 503 });
      return result;
    },
    { now: () => time, retryMs: 1 },
  );
  const job = queue.enqueue(submission, user);
  await queue.tick();
  expect(
    db
      .prepare("SELECT attempts,status FROM recognition_jobs WHERE id=?")
      .get(job.id),
  ).toMatchObject({ attempts: 0, status: "queued" });
  pressured = false;
  time += 100;
  await queue.tick();
  expect(
    db.prepare("SELECT status FROM recognition_jobs WHERE id=?").get(job.id)!
      .status,
  ).toBe("succeeded");
});

it("keeps interrupted work recoverable during graceful shutdown", async () => {
  let time = Date.now();
  const queue = createRecognitionQueue(
    db,
    async (_job, { signal }) => {
      await new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
      return result;
    },
    { now: () => time },
  );
  const job = queue.enqueue(submission, user);
  const running = queue.tick();
  queue.stop();
  await running;
  expect(
    db
      .prepare("SELECT attempts,status FROM recognition_jobs WHERE id=?")
      .get(job.id),
  ).toMatchObject({ attempts: 0, status: "queued" });
  time += 6000;
  const restarted = createRecognitionQueue(db, async () => result, {
    now: () => time,
  });
  await restarted.tick();
  expect(
    db.prepare("SELECT status FROM recognition_jobs WHERE id=?").get(job.id)!
      .status,
  ).toBe("succeeded");
});
