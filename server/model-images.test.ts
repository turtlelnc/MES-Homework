import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createModelImages } from "./model-images.mjs";

it("reserves aggregate image work atomically before buffering, and releases only once", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-images-"));
  try {
    const file = path.join(dir, "image");
    fs.writeFileSync(file, Buffer.alloc(6));
    const budget = createModelImages({ maxBytes: 12 });
    const attempts = await Promise.allSettled([
      budget.acquire([{ filePath: file }]),
      budget.acquire([{ filePath: file }]),
    ]);
    expect(attempts.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const blocked = attempts.find(
      (x) => x.status === "rejected",
    ) as PromiseRejectedResult;
    expect(blocked.reason).toMatchObject({ code: "MODEL_BUSY", status: 429 });
    expect(budget.snapshot().activeBytes).toBe(8);
    const lease = (
      attempts.find(
        (x) => x.status === "fulfilled",
      ) as PromiseFulfilledResult<any>
    ).value;
    lease.release();
    lease.release();
    expect(budget.snapshot().activeBytes).toBe(0);
    (await budget.acquire([{ base64: "12345678" }])).release();
    await expect(budget.acquire([{ base64: "x".repeat(13) }])).rejects.toThrow(
      /预算/,
    );
    expect(budget.snapshot().activeBytes).toBe(0);
    const controller = new AbortController();
    controller.abort();
    await expect(
      budget.acquire([{ filePath: file }], controller.signal),
    ).rejects.toThrow();
    expect(budget.snapshot().activeBytes).toBe(0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
