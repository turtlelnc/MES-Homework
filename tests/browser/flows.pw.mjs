import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
const login = async (page, account = "teacher@fixture.test") => {
  await page.goto("/");
  // v0.2.1 起登录入口接受账号名或旧账号邮箱。
  await page.locator('input[name="account"]').fill(account);
  await page.locator('input[name="password"]').fill("ChangeMe123!");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "退出登录", exact: true }),
  ).toBeVisible();
};
const configure = async (page) => {
  const r = await page.request.put("/api/settings/provider", {
    data: { provider: "openai", apiKey: "browser-mock-only" },
  });
  expect(r.status()).toBe(200);
};
const assignments = async (page) =>
  (await page.request.get("/api/assignments")).json();
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
test.beforeEach(async ({ page }, testInfo) => {
  // Model independent clients, so the whole suite does not consume one IP's
  // login allowance. A retry keeps its identity and still exercises throttling.
  const client = createHash("sha256").update(testInfo.testId).digest();
  await page.context().setExtraHTTPHeaders({
    "X-Forwarded-For": `198.18.${client[0]}.${client[1]}`,
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.__errors = errors;
});
test.afterEach(async ({ page }) => {
  expect(page.__errors).toEqual([]);
});

test("registration follows server policy instead of an invented local default", async ({
  page,
}) => {
  await page.route("**/api/capabilities", (route) =>
    route.fulfill({
      json: {
        stages: ["小学", "高中"],
        publicRegistration: false,
        schoolInviteRequired: false,
      },
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "创建学校空间", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "学校", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("tab", { name: "老师", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("tab", { name: "学生", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("tab", { name: "家长", exact: true }),
  ).toBeDisabled();
});

test("school registration asks for a one-time invite code when required", async ({
  page,
}) => {
  await page.route("**/api/capabilities", (route) =>
    route.fulfill({
      json: {
        stages: ["小学", "高中"],
        publicRegistration: true,
        schoolInviteRequired: true,
      },
    }),
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "还没有账户？注册", exact: true })
    .click();
  await expect(page.locator('input[name="inviteCode"]')).toBeVisible();
  await expect(page.locator(".panel-intro")).toContainText("一次性开通码");
});

test("temporary session lookup failures offer retry and preserve the actual login", async ({
  page,
}) => {
  await login(page);
  await page.route("**/api/me", (route) =>
    route.fulfill({ status: 503, json: { error: "fixture temporarily busy" } }),
  );
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("暂时无法读取登录状态");
  await expect(page.locator('input[name="account"]')).toHaveCount(0);
  await page.unroute("**/api/me");
  await page.getByRole("button", { name: "重试登录状态", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "退出登录", exact: true }),
  ).toBeVisible();
});

test("login success without a persisted session explains cookie configuration", async ({
  page,
}) => {
  await page.route("**/api/me", (route) =>
    route.fulfill({ status: 401, json: { error: "请先登录" } }),
  );
  await page.goto("/");
  await page.locator('input[name="account"]').fill("teacher@fixture.test");
  await page.locator('input[name="password"]').fill("ChangeMe123!");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("浏览器未能保持会话");
  await page.unroute("**/api/me");
  await page.getByRole("button", { name: "重试登录状态", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "退出登录", exact: true }),
  ).toBeVisible();
});

test("failed logout retains the real session and reports a retryable error", async ({
  page,
}) => {
  await login(page);
  await page.route("**/api/auth/logout", (route) =>
    route.fulfill({ status: 503, json: { error: "fixture temporarily busy" } }),
  );
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await expect(page.getByText(/退出未完成/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "退出登录", exact: true }),
  ).toBeVisible();
  const response = await page.request.get("/api/me");
  expect(response.status()).toBe(200);
  await page.unroute("**/api/auth/logout");
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await expect(page.locator('input[name="account"]')).toBeVisible();
  expect((await page.request.get("/api/me")).status()).toBe(401);
});

test("a late session refresh cannot undo a completed logout", async ({
  page,
}) => {
  await login(page);
  const before = await (await page.request.get("/api/me")).json();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const gate = deferred(),
    entered = deferred();
  await page.route("**/api/me", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    entered.resolve();
    await gate.promise;
    await route.fulfill({ json: before });
  });
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await entered.promise;
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await expect(page.locator('input[name="account"]')).toBeVisible();
  const response = page.waitForResponse(
    (r) => r.url().endsWith("/api/me") && r.request().method() === "GET",
  );
  gate.resolve();
  await (await response).finished();
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await expect(page.locator('input[name="account"]')).toBeVisible();
  await expect(
    page.getByRole("button", { name: "退出登录", exact: true }),
  ).toHaveCount(0);
});

test("published assignment details show real questions but no student reference answers", async ({
  page,
}) => {
  await login(page, "lin@fixture.test");
  await page.getByRole("button", { name: "我的作业", exact: true }).click();
  const detail = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "作业详情" }) });
  await expect(page.getByText("正在读取题目…")).toHaveCount(0);
  await expect(page.getByText("第 1 题 · 5 分", { exact: true })).toBeVisible();
  await expect(page.getByText("教师参考答案", { exact: true })).toHaveCount(0);
  await page.screenshot({
    path: "test-results/release-student-assignment-details.png",
    fullPage: true,
  });
});

test("a saved paper can be reopened after a page reload", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "错题组卷", exact: true }).click();
  await page.getByLabel("试卷名称", { exact: true }).fill("发布验收历史试卷");
  await page.getByRole("button", { name: "从错题组卷", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "发布验收历史试卷", exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "错题组卷", exact: true }).click();
  await page.getByRole("button", { name: /发布验收历史试卷 ·/ }).click();
  await expect(
    page.getByRole("heading", { name: "发布验收历史试卷", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "打印 / 保存 PDF", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/release-saved-paper.png",
    fullPage: true,
  });
});

test("login and enrollment boundary are visible in the real UI", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("使用账号名或邮箱登录")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "还没有账户？注册" }),
  ).toBeVisible();
  await login(page);
  await expect(page.locator(".account-chip")).toContainText("王老师");
  // v0.2.1：四身份可自助注册，但仍必须提供有效学校代码与合规字段。
  expect(
    (
      await page.request.post("/api/auth/register", {
        data: {
          role: "student",
          schoolCode: "anything",
          username: "browser_student",
          password: "ChangeMe123!",
          name: "浏览器学生",
          stage: "初中",
          className: "other",
        },
      })
    ).status(),
  ).toBe(400);
  await page.screenshot({
    path: "test-results/teacher-login.png",
    fullPage: true,
  });
});

test("two pages form one submission; OCR and manual scores save consistently", async ({
  page,
}) => {
  await login(page);
  await configure(page);
  const a = (await assignments(page)).find((x) => x.title === "浏览器作业 A");
  const student = (await (await page.request.get("/api/students")).json()).find(
    (x) => x.email === "lin@fixture.test",
  );
  await page.getByRole("button", { name: "作业与上传", exact: true }).click();
  await page.getByLabel("对应的正式作业").selectOption(a.id);
  await page.getByLabel("关联学生账户").selectOption(student.id);
  await page.locator(".upload-box input[type=file]").setInputFiles([
    { name: "page-1.png", mimeType: "image/png", buffer: png },
    { name: "page-2.png", mimeType: "image/png", buffer: png },
  ]);
  await expect(page.getByText("同一份答卷：已选择 2 个文件")).toBeVisible();
  const uploaded = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/api/assignments/${a.id}/submissions`) &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "保存并进入识别队列" }).click();
  const response = await uploaded;
  expect(response.status()).toBe(200);
  const created = await response.json();
  expect(created).toHaveLength(1);
  const id = created[0].id;
  await page.getByRole("button", { name: "识别与复核", exact: true }).click();
  // Select the newly uploaded queue entry via its fresh status, not a fixture sibling.
  await page
    .locator(".select-list button")
    .filter({ hasText: "林一" })
    .filter({ hasText: "等待识别" })
    .first()
    .click();
  await expect(page.locator(".review-detail a")).toHaveCount(2);
  await page.getByRole("button", { name: "开始 OCR", exact: true }).click();
  const rows = page.locator("fieldset.review-item");
  await expect(rows).toHaveCount(8);
  await expect(rows.first()).toContainText("教师标准答案：");
  const focus = page.getByLabel(/仅显示需重点复核的存疑题/);
  await focus.check();
  await expect(rows).toHaveCount(0); // mock confidence is 95%, so none need triage.
  await focus.uncheck();
  await expect(rows).toHaveCount(8);
  await rows.first().getByRole("checkbox").check();
  await expect(rows.first().getByRole("spinbutton")).toHaveValue("5");
  await rows.nth(1).getByRole("spinbutton").fill("1");
  await page.screenshot({
    path: "test-results/manual-review.png",
    fullPage: true,
  });
  const reviewed = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/api/submissions/${id}/review`) &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "确认复核并写入错题本" }).click();
  expect((await reviewed).status()).toBe(200);
  const saved = await (await page.request.get(`/api/submissions/${id}`)).json();
  expect(saved.score).toBe(6);
  expect(saved.teacher_reviewed).toBe(1);
  expect(saved.files).toHaveLength(2);
  const completed = page
    .locator(".select-list button")
    .filter({ hasText: "林一" })
    .filter({ hasText: "已完成" })
    .first();
  await expect(completed).toBeVisible();
  await completed.click();
  await page.getByText("批改与复核历史", { exact: true }).click();
  await expect(page.getByText("保存教师复核", { exact: true })).toBeVisible();
});

test("account creation resets its real form and import templates contain no invented credentials", async ({
  page,
}) => {
  await login(page, "admin@fixture.test");
  const form = page.locator("form").filter({
    has: page.getByRole("heading", { name: "注册教师", exact: true }),
  });
  await form.getByLabel("教师姓名", { exact: true }).fill("发布验收教师");
  await form
    .getByLabel("登录账号名", { exact: true })
    .fill("releaseauditteacher");
  await form.getByLabel("初始密码", { exact: true }).fill("ChangeMe123!");
  await form.getByLabel("任教学科", { exact: true }).fill("发布验收学科");
  await form
    .getByLabel("默认班级 / 班主任班级", { exact: true })
    .fill("发布验收班级");
  await form.getByRole("button", { name: "创建教师账户", exact: true }).click();
  await expect(
    page.getByText("教师账户已创建。", { exact: true }),
  ).toBeVisible();
  await expect(form.getByLabel("教师姓名", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "学生管理", exact: true }).click();
  const pending = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "下载 CSV 模板", exact: true })
    .click();
  const download = await pending;
  const fs = await import("node:fs");
  const text = fs.readFileSync(await download.path(), "utf8");
  expect(text.replace(/^\uFEFF/, "").trim()).toBe(
    "姓名,账号名,初始密码,学段,班级",
  );
});

test("late answer-sheet detail cannot replace the selected student", async ({
  page,
}) => {
  await login(page);
  const rows = await (await page.request.get("/api/submissions")).json();
  const a = rows.find((x) => x.student_name === "林一");
  const b = rows.find((x) => x.student_name === "秦二");
  const held = deferred(),
    release = deferred();
  await page.route(`**/api/submissions/${a.id}`, async (route) => {
    const response = await route.fetch();
    held.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "识别与复核", exact: true }).click();
  await page
    .locator(".select-list button")
    .filter({ hasText: "林一" })
    .first()
    .click();
  await held.promise;
  await page
    .locator(".select-list button")
    .filter({ hasText: "秦二" })
    .first()
    .click();
  await expect(page.locator(".review-detail h2")).toHaveText("秦二");
  const delivered = page.waitForResponse((r) =>
    r.url().endsWith(`/api/submissions/${a.id}`),
  );
  release.resolve();
  await (await delivered).finished();
  await page.evaluate(
    () =>
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  await page.unroute(`**/api/submissions/${a.id}`);
  await expect(page.locator(".review-detail h2")).toHaveText("秦二");
});

test("late teaching statistics cannot send another assignment question numbers", async ({
  page,
}) => {
  await login(page);
  const all = await assignments(page),
    a = all.find((x) => x.title === "浏览器作业 A"),
    b = all.find((x) => x.title === "浏览器作业 B");
  const held = deferred(),
    release = deferred();
  await page.route(`**/api/teaching/assignments/${a.id}`, async (route) => {
    const response = await route.fetch();
    held.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "AI 教学分析", exact: true }).click();
  await held.promise;
  await page.getByLabel("教学分析作业", { exact: true }).selectOption(b.id);
  await expect(
    page
      .getByRole("region", { name: "AI 教学分析", exact: true })
      .getByText("B独有题干1", { exact: true }),
  ).toBeVisible();
  const delivered = page.waitForResponse((r) =>
    r.url().endsWith(`/api/teaching/assignments/${a.id}`),
  );
  release.resolve();
  await (await delivered).finished();
  await page.evaluate(
    () =>
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  await page.unroute(`**/api/teaching/assignments/${a.id}`);
  await expect(page.getByLabel("教学分析作业", { exact: true })).toHaveValue(
    b.id,
  );
  await expect(
    page
      .getByRole("region", { name: "AI 教学分析", exact: true })
      .getByText("B独有题干1", { exact: true }),
  ).toBeVisible();
  const submitted = page.waitForRequest((r) =>
    r
      .url()
      .endsWith(`/api/teaching/assignments/${b.id}/mistakes-to-assignment`),
  );
  await page
    .getByRole("button", { name: "一键生成重练作业", exact: true })
    .click();
  const req = await submitted;
  expect(req.postDataJSON().numbers.length).toBeGreaterThan(0);
  await page.screenshot({
    path: "test-results/teaching-selection.png",
    fullPage: true,
  });
});

test("late generated teaching plan cannot appear on another assignment", async ({
  page,
}) => {
  await login(page);
  await configure(page);
  const all = await assignments(page),
    a = all.find((x) => x.title === "浏览器作业 A"),
    b = all.find((x) => x.title === "浏览器作业 B");
  await page.getByRole("button", { name: "AI 教学分析", exact: true }).click();
  await page.getByLabel("教学分析作业", { exact: true }).selectOption(a.id);
  await expect(page.locator(".ta-metrics")).toBeVisible();
  const held = deferred(),
    release = deferred();
  await page.route(
    `**/api/teaching/assignments/${a.id}/analyze`,
    async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      held.resolve();
      await release.promise;
      await route.fulfill({ response });
    },
  );
  await page
    .locator(".ta-head")
    .getByRole("button", { name: "生成 AI 教学方案", exact: true })
    .click();
  await held.promise;
  await page.getByLabel("教学分析作业", { exact: true }).selectOption(b.id);
  await expect(
    page
      .getByRole("region", { name: "AI 教学分析", exact: true })
      .getByText("B独有题干1", { exact: true }),
  ).toBeVisible();
  const delivered = page.waitForResponse((r) =>
    r.url().endsWith(`/api/teaching/assignments/${a.id}/analyze`),
  );
  release.resolve();
  await (await delivered).finished();
  await page.evaluate(
    () =>
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  await page.unroute(`**/api/teaching/assignments/${a.id}/analyze`);
  await expect(page.getByText("MOCK_CLASS_PLAN", { exact: true })).toHaveCount(
    0,
  );
});

test("student UI keeps exercise answers private and exposes only own attachments", async ({
  page,
}) => {
  await login(page, "lin@fixture.test");
  const rows = await (await page.request.get("/api/mistakes")).json();
  expect(rows.length).toBeGreaterThan(0);
  for (const m of rows)
    for (const q of m.practiceQuestions)
      expect(Object.keys(q)).toEqual(["prompt"]);
  await page.getByRole("button", { name: "我的错题", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "我的错题", exact: true }),
  ).toBeVisible();
  const all = await assignments(page);
  const details = await (
    await page.request.get(`/api/assignments/${all[0].id}`)
  ).json();
  expect(
    details.questions.every((q) => !Object.hasOwn(q, "standard_answer")),
  ).toBe(true);
  await expect(
    page.getByRole("button", { name: "识别与复核", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: "test-results/student-notebook.png",
    fullPage: true,
  });
});

test("school administrators can inspect their queue and usage without teaching controls", async ({
  page,
}) => {
  await login(page, "admin@fixture.test");
  await expect(
    page.getByRole("heading", { name: "本校任务运行状态" }),
  ).toBeVisible();
  await expect(page.getByText(/近 24 小时模型调用/)).toBeVisible();
  await expect(page.getByText(/近 15 分钟请求/)).toBeVisible();
  const refreshed = page.waitForResponse((r) =>
    r.url().endsWith("/api/operations"),
  );
  await page.getByRole("button", { name: "刷新状态" }).click();
  expect((await refreshed).status()).toBe(200);
  await expect(
    page.getByRole("button", { name: "识别与复核", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: "test-results/school-operations.png",
    fullPage: true,
  });
});

test("device-side overlapping tiles resume after interruption and preserve original review", async ({
  page,
}) => {
  const { createCanvas } = await import("@napi-rs/canvas");
  const canvas = createCanvas(1800, 1200);
  const context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, 1800, 1200);
  context.fillStyle = "black";
  context.font = "40px sans-serif";
  context.fillText("1 + 1 = 2", 40, 80);
  await login(page);
  await configure(page);
  const a = (await assignments(page)).find((x) => x.title === "浏览器作业 A");
  const student = (await (await page.request.get("/api/students")).json()).find(
    (x) => x.email === "lin@fixture.test",
  );
  await page.getByRole("button", { name: "作业与上传", exact: true }).click();
  await page.getByLabel("对应的正式作业").selectOption(a.id);
  await page.getByLabel("关联学生账户").selectOption(student.id);
  await page.getByLabel(/在设备上切分照片/).check();
  await page.locator(".upload-box input[type=file]").setInputFiles({
    name: "full-page.jpg",
    mimeType: "image/jpeg",
    buffer: canvas.toBuffer("image/jpeg"),
  });
  let originals = 0;
  page.on("request", (request) => {
    if (/\/upload-sessions\/[^/]+\/parts\/0$/.test(request.url())) originals++;
  });
  await page.route("**/api/upload-sessions/*/parts/1", (route) =>
    route.abort("failed"),
  );
  await page
    .getByRole("button", { name: "保存并进入识别队列", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "重试未完成的上传", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "取消本次上传", exact: true }),
  ).toBeVisible();
  await page.unroute("**/api/upload-sessions/*/parts/1");
  const finalized = page.waitForResponse((r) =>
    /\/upload-sessions\/[^/]+\/finalize$/.test(r.url()),
  );
  await page
    .getByRole("button", { name: "重试未完成的上传", exact: true })
    .click();
  const response = await finalized;
  expect(response.status()).toBe(200);
  const { id } = await response.json();
  expect(originals).toBe(1);
  const detail = await (
    await page.request.get(`/api/submissions/${id}`)
  ).json();
  expect(detail.files).toHaveLength(1);
  expect(detail.files[0].name).toBe("full-page.jpg");
  await page.getByRole("button", { name: "识别与复核", exact: true }).click();
  await page
    .locator(".select-list button")
    .filter({ hasText: "林一" })
    .filter({ hasText: "等待识别" })
    .first()
    .click();
  await expect(page.locator(".review-detail a")).toHaveCount(1);
  await page.getByRole("button", { name: "开始 OCR", exact: true }).click();
  await expect(page.locator("fieldset.review-item")).toHaveCount(8);
  await page.screenshot({
    path: "test-results/device-tiling-review.png",
    fullPage: true,
  });
});

test("switching API vendors clears old endpoint and model overrides before saving", async ({
  page,
}) => {
  await login(page);
  await configure(page);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const provider = page.locator('select[name="provider"]');
  await expect(provider).toHaveValue("openai");
  await page.getByText("高级设置：模型名称与接口地址", { exact: true }).click();
  await page
    .locator('input[name="endpoint"]')
    .fill("https://api.openai.com/v1/chat/completions");
  await page.locator('input[name="model"]').fill("gpt-4.1-mini");
  await provider.selectOption("deepseek");
  await expect(page.locator('input[name="endpoint"]')).toHaveValue("");
  await expect(page.locator('input[name="model"]')).toHaveValue("");
  await page.locator('input[name="apiKey"]').fill("browser-mock-only");
  const response = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/settings/provider") &&
      r.request().method() === "PUT",
  );
  await page
    .getByRole("button", { name: "保存并使用 API Key", exact: true })
    .click();
  expect(await (await response).json()).toMatchObject({
    provider: "deepseek",
    model: "deepseek-flash",
    endpoint: "https://api.deepseek.com/chat/completions",
  });
  await page.reload();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(provider).toHaveValue("deepseek");
  await expect(page.locator('input[name="model"]')).toHaveValue(
    "deepseek-flash",
  );
  await expect(page.locator('input[name="endpoint"]')).toHaveValue(
    "https://api.deepseek.com/chat/completions",
  );
  await expect(page.locator('input[name="apiKey"]')).toHaveValue("");
  await page.screenshot({
    path: "test-results/deepseek-provider-settings.png",
    fullPage: true,
  });
});

test("existing model settings reuse the encrypted key and distinguish save from activation", async ({
  page,
}) => {
  await login(page);
  await configure(page);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.locator('select[name="provider"]')).toHaveValue("openai");
  await expect(page.locator('input[name="apiKey"]')).not.toHaveAttribute(
    "required",
  );
  await page.getByText("高级设置：模型名称与接口地址", { exact: true }).click();
  await page.locator('input[name="model"]').fill("custom-fixture-model");
  const saved = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/settings/provider") &&
      r.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "仅保存配置", exact: true }).click();
  expect(await (await saved).json()).toMatchObject({
    model: "custom-fixture-model",
    activated: false,
  });
  const activated = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/settings/provider") &&
      r.request().method() === "PUT",
  );
  await page
    .getByRole("button", { name: "保存并使用 API Key", exact: true })
    .click();
  expect(await (await activated).json()).toMatchObject({ activated: true });
  await expect(page.getByRole("status")).toContainText("已保存并切换");
  await page.screenshot({
    path: "test-results/model-key-reuse.png",
    fullPage: true,
  });
});

test("model settings read failures offer a real retry without overwriting saved credentials", async ({
  page,
}) => {
  await login(page);
  await configure(page);
  await page.route("**/api/settings/provider", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          status: 503,
          json: { error: "fixture temporarily busy" },
        })
      : route.continue(),
  );
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("无法读取模型设置");
  await expect(
    page.getByRole("button", { name: "保存并使用 API Key", exact: true }),
  ).toBeDisabled();
  await page.unroute("**/api/settings/provider");
  await page.getByRole("button", { name: "刷新状态", exact: true }).click();
  await expect(page.locator('select[name="provider"]')).toHaveValue("openai");
  await expect(
    page.getByRole("button", { name: "保存并使用 API Key", exact: true }),
  ).toBeEnabled();
});

test("OAuth is absent from settings and authorization routes are removed", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "模型与授权", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("OAuth 授权方式", { exact: true })).toHaveCount(
    0,
  );
  expect(
    (
      await page.request.post("/api/oauth/chatgpt/browser/start", { data: {} })
    ).status(),
  ).toBe(404);
});

test("teacher chapters preserve assignment drafts and refresh knowledge without replacing the page", async ({
  page,
}) => {
  await login(page);
  const chapters = page.getByRole("navigation", {
    name: "工作台章节",
    exact: true,
  });
  await expect(chapters.getByRole("button")).toHaveCount(7);
  await chapters
    .getByRole("button", { name: "作业与上传", exact: true })
    .click();
  const assignmentsRegion = page.getByRole("region", {
    name: "作业与上传",
    exact: true,
  });
  await assignmentsRegion
    .getByRole("button", { name: "新增作业", exact: true })
    .click();
  await assignmentsRegion
    .getByLabel("作业名称", { exact: true })
    .fill("同页保留的作业草稿");
  await chapters.getByRole("button", { name: "知识库", exact: true }).click();
  const knowledge = page.getByRole("region", { name: "知识库", exact: true });
  await knowledge
    .getByLabel("知识点名称", { exact: true })
    .fill("同页新增知识点");
  await knowledge
    .getByRole("button", { name: "保存知识点", exact: true })
    .click();
  await expect(
    knowledge.getByText("同页新增知识点", { exact: true }),
  ).toBeVisible();
  await chapters.getByRole("button", { name: "错题组卷", exact: true }).click();
  await page
    .getByRole("region", { name: "错题组卷", exact: true })
    .getByLabel("试卷名称", { exact: true })
    .fill("未提交的组卷草稿");
  await chapters
    .getByRole("button", { name: "作业与上传", exact: true })
    .click();
  await expect(
    assignmentsRegion.getByLabel("作业名称", { exact: true }),
  ).toHaveValue("同页保留的作业草稿");
  await expect(
    assignmentsRegion.getByRole("option", {
      name: "同页新增知识点",
      exact: true,
    }),
  ).toHaveCount(1);
  await chapters.getByRole("button", { name: "错题组卷", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "错题组卷", exact: true })
      .getByLabel("试卷名称", { exact: true }),
  ).toHaveValue("未提交的组卷草稿");
  await page.screenshot({
    path: "test-results/teacher-single-workspace.png",
    fullPage: true,
  });
});

test("teacher uploads open the actual answer sheet in the same document", async ({
  page,
}) => {
  await login(page);
  await configure(page);
  await page.getByRole("button", { name: "作业与上传", exact: true }).click();
  const a = (await assignments(page)).find((x) => x.title === "浏览器作业 A");
  const student = (await (await page.request.get("/api/students")).json()).find(
    (x) => x.email === "lin@fixture.test",
  );
  await page.getByLabel("对应的正式作业").selectOption(a.id);
  await page.getByLabel("关联学生账户").selectOption(student.id);
  await page.locator(".upload-box input[type=file]").setInputFiles({
    name: "same-page.png",
    mimeType: "image/png",
    buffer: png,
  });
  const uploaded = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/api/assignments/${a.id}/submissions`) &&
      r.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "保存并进入识别队列", exact: true })
    .click();
  const [result] = await (await uploaded).json();
  const expected = await (
    await page.request.get(`/api/submissions/${result.id}`)
  ).json();
  const region = page.getByRole("region", { name: "识别与复核", exact: true });
  await expect(region.locator(".review-detail a")).toHaveCount(1);
  await expect(region.locator(".review-detail a")).toHaveAttribute(
    "href",
    expected.files[0].url,
  );
  await expect(region.locator(".review-detail")).toBeVisible();
  await expect(
    page.getByRole("region", { name: "作业与上传", exact: true }),
  ).toBeAttached();
  await page.screenshot({
    path: "test-results/same-page-upload-review.png",
    fullPage: true,
  });
});

test("school member forms stay together and model policies share the credential page", async ({
  page,
}) => {
  await login(page, "admin@fixture.test");
  const chapters = page.getByRole("navigation", {
    name: "工作台章节",
    exact: true,
  });
  await page.getByLabel("教师姓名", { exact: true }).fill("保留的教师草稿");
  await chapters.getByRole("button", { name: "学生管理", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "注册单个学生", exact: true }),
  ).toBeVisible();
  await chapters
    .getByRole("button", { name: "学校仪表盘", exact: true })
    .click();
  await expect(page.getByLabel("教师姓名", { exact: true })).toHaveValue(
    "保留的教师草稿",
  );
  await page.getByRole("button", { name: "账户设置", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "模型调用模式", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "模型与授权", exact: true }),
  ).toBeAttached();
  await expect(
    page.getByRole("button", { name: "识别与复核", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: "test-results/school-models-one-page.png",
    fullPage: true,
  });
});

test("student work and mistakes share a page while keeping the chosen upload", async ({
  page,
}) => {
  await login(page, "lin@fixture.test");
  const chapters = page.getByRole("navigation", {
    name: "工作台章节",
    exact: true,
  });
  await chapters.getByRole("button", { name: "我的作业", exact: true }).click();
  await page.locator(".upload-box input[type=file]").setInputFiles({
    name: "draft-answer.png",
    mimeType: "image/png",
    buffer: png,
  });
  await chapters.getByRole("button", { name: "我的错题", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "我的错题", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "刷新错题", exact: true }),
  ).toBeVisible();
  await chapters.getByRole("button", { name: "我的作业", exact: true }).click();
  await expect(
    page.getByText("同一份答卷：已选择 1 个文件", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "识别与复核", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: "test-results/student-single-workspace.png",
    fullPage: true,
  });
});

test("mobile chapter navigation remains available after jumping down the workspace", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const chapters = page.getByRole("navigation", {
    name: "工作台章节",
    exact: true,
  });
  await chapters.getByRole("button", { name: "知识库", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "校本知识库", exact: true }),
  ).toBeInViewport();
  await expect(chapters).toBeInViewport();
  await chapters
    .getByRole("button", { name: "作业与上传", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "作业与上传", exact: true }),
  ).toBeInViewport();
  await expect(chapters).toBeInViewport();
  await page.screenshot({
    path: "test-results/mobile-single-workspace.png",
    fullPage: true,
  });
});

test("saving an account profile stays on the combined settings page", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "模型与授权", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "账户信息", exact: true }),
  ).toBeAttached();
  await expect(page.locator(".rc4-sidebar button.active")).toHaveText("设置");
});

test("printing a saved paper excludes other chapters and restores the page afterwards", async ({
  page,
}) => {
  await login(page);
  const created = await page.request.post("/api/papers/generate", {
    data: { title: "同页打印专用卷", count: 2 },
  });
  expect(created.status()).toBe(200);
  await page.getByRole("button", { name: "作业与上传", exact: true }).click();
  await page.getByRole("button", { name: "学生管理", exact: true }).click();
  await page.getByRole("button", { name: "错题组卷", exact: true }).click();
  await page.getByRole("button", { name: /同页打印专用卷 ·/ }).click();
  await page.evaluate(() => {
    window.print = () => {};
  });
  await page
    .getByRole("button", { name: "打印 / 保存 PDF", exact: true })
    .click();
  await page.emulateMedia({ media: "print" });
  await expect(page.locator(".paper")).toBeVisible();
  await expect(
    page.getByRole("region", { name: "学生管理", exact: true }),
  ).toBeHidden();
  await expect(
    page.getByRole("region", { name: "作业与上传", exact: true }),
  ).toBeHidden();
  await expect(
    page.getByRole("navigation", { name: "工作台章节", exact: true }),
  ).toBeHidden();
  await page.screenshot({
    path: "test-results/workspace-paper-print.png",
    fullPage: true,
  });
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  await page.emulateMedia({ media: "screen" });
  await expect(
    page.getByRole("region", { name: "学生管理", exact: true }),
  ).toBeAttached();
  await expect(page.locator("body")).not.toHaveAttribute("data-print-active");
});

test("changing school policy refreshes permissions without clearing an unsaved key", async ({
  page,
}) => {
  await login(page, "admin@fixture.test");
  const original = (
    await (await page.request.get("/api/school/model-mode")).json()
  ).mode;
  page.on("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "账户设置", exact: true }).click();
  await page
    .locator('input[name="apiKey"]')
    .fill("unsaved-browser-fixture-key");
  const refreshed = page.waitForResponse((r) =>
    r.url().endsWith("/api/model/access"),
  );
  await page.getByRole("button", { name: /全校统一模式/ }).click();
  expect((await refreshed).status()).toBe(200);
  await expect(page.locator('input[name="apiKey"]')).toHaveValue(
    "unsaved-browser-fixture-key",
  );
  const actual = (
    await (await page.request.get("/api/school/model-mode")).json()
  ).mode;
  expect(actual).toBe("school");
  await page.request.put("/api/school/model-mode", {
    data: { mode: original },
  });
});

test("rc1 parent dashboard shows growth, concrete reasons and date controls without removed sections", async ({
  page,
}) => {
  await login(page);
  const current = await (await page.request.get("/api/me")).json();
  await page.route("**/api/me", (route) =>
    route.fulfill({ json: { ...current, role: "parent", is_school_admin: 0 } }),
  );
  await page.route("**/api/parent/children", (route) =>
    route.fulfill({
      json: [
        {
          id: "fixture-child",
          name: "示例学生",
          stage: "初中",
          class_name: "八年级（1）班",
        },
      ],
    }),
  );
  await page.route("**/api/parent/children/fixture-child/insights", (route) =>
    route.fulfill({ json: null }),
  );
  await page.route(
    "**/api/parent/children/fixture-child/dashboard?*",
    (route) =>
      route.fulfill({
        json: {
          summary: { averageScoreRate: 0.8, mistakeCount: 2, masteryRate: 0.5 },
          growth: {
            delta: 0.12,
            previousTitle: "同类前卷",
            basis: "同学科、同满分",
          },
          position: {
            classLevel: "中上水平",
            gradeLevel: "中等水平",
            basis: "同卷真实样本",
          },
          reasons: [
            { label: "分数相加时未先通分，分母直接相加", count: 2, share: 100 },
          ],
          recent: [],
          trend: [],
          knowledge: [],
        },
      }),
  );
  await page.reload();
  await expect(page.getByText("+12 个百分点", { exact: true })).toBeVisible();
  await expect(page.getByText("中上水平", { exact: true })).toBeVisible();
  await expect(
    page.getByText("分数相加时未先通分，分母直接相加", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "学科表现", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("已复核作业", { exact: true })).toHaveCount(0);
  const range = page.getByRole("combobox", { name: "查看范围", exact: true });
  const request = page.waitForRequest(
    (r) => r.url().includes("/dashboard?") && r.url().includes("range=week"),
  );
  await range.selectOption("week");
  await request;
  await range.selectOption("custom");
  await expect(page.getByLabel("开始日期", { exact: true })).toBeVisible();
  await expect(page.getByLabel("结束日期", { exact: true })).toBeVisible();
  await page.screenshot({
    path: "test-results/rc1-parent-dashboard.png",
    fullPage: true,
  });
});

test("rc1 teacher data dashboard uses real records and keeps chapter directory on the left", async ({
  page,
}) => {
  await login(page);
  await expect(
    page.getByRole("heading", { name: "教学数据看板", exact: true }),
  ).toBeVisible();
  const nav = page.getByRole("navigation", {
    name: "工作台章节",
    exact: true,
  });
  const navBox = await nav.boundingBox();
  const contentBox = await page
    .getByRole("heading", { name: "教学数据看板", exact: true })
    .boundingBox();
  expect(navBox.x + navBox.width).toBeLessThan(contentBox.x);
  await page.screenshot({
    path: "test-results/rc1-teacher-dashboard.png",
    fullPage: false,
  });
});

test("question figures can be attached, removed and published without changing other fields", async ({
  page,
}) => {
  await login(page);
  await page
    .getByRole("navigation", { name: "工作台章节", exact: true })
    .getByRole("button", { name: "作业与上传", exact: true })
    .click();
  const region = page.getByRole("region", { name: "作业与上传", exact: true });
  await region.getByRole("button", { name: "新增作业", exact: true }).click();
  const form = region.locator(".assignment-form");
  await form.getByLabel("作业名称", { exact: true }).fill("题图类型回归作业");
  await form
    .getByLabel("真实题干", { exact: true })
    .fill("选择题：根据附图选择答案。");
  await form
    .getByLabel("参考答案（客观题仅填答案）", { exact: true })
    .fill("A");
  await form
    .getByRole("combobox", { name: "知识点", exact: true })
    .selectOption({ index: 1 });
  await form.getByLabel("分值", { exact: true }).fill("5");
  const input = form.locator(
    'input[type="file"][accept="image/png,image/jpeg,image/webp"]',
  );
  const picture = {
    name: "question-figure.png",
    mimeType: "image/png",
    buffer: png,
  };
  await input.setInputFiles(picture);
  await expect(
    form.getByRole("img", { name: "原题附图", exact: true }),
  ).toBeVisible();
  await form.getByRole("button", { name: "移除附图", exact: true }).click();
  await expect(
    form.getByRole("img", { name: "原题附图", exact: true }),
  ).toHaveCount(0);
  await input.setInputFiles(picture);
  await expect(
    form.getByRole("img", { name: "原题附图", exact: true }),
  ).toBeVisible();
  const saved = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/assignments") && r.request().method() === "POST",
  );
  await form
    .getByRole("button", { name: "核对完成并发布", exact: true })
    .click();
  const response = await saved;
  expect(response.status()).toBe(200);
  const { id } = await response.json();
  const detail = await (
    await page.request.get(`/api/assignments/${id}`)
  ).json();
  expect(detail.questions[0]).toMatchObject({
    prompt: "选择题：根据附图选择答案。",
    standard_answer: "A",
    score: 5,
  });
  expect(detail.questions[0].figure.image).toBe(
    `data:image/png;base64,${png.toString("base64")}`,
  );
});
