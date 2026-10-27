import { runtimeProfile } from "./runtime-profile.mjs";
import { applicationCapabilities } from "./capabilities.mjs";
import {
  providerRequest,
  providerReply,
  providerHttpError,
  assertProviderCompletion,
  modelResponseLimits,
} from "./provider-protocol.mjs";
import { requestAdmission } from "./request-admission.mjs";
import express from "express";
import { limitJsonBodies } from "./body-admission.mjs";
import { requestJson, abortable, storageStatus } from "./io-guards.mjs";
import { createResourcePressure } from "./resource-pressure.mjs";
import { createUploadStorage } from "./upload-storage.mjs";
import {
  requestScope,
  requestSignal,
  cancelRequests,
} from "./request-scope.mjs";
import { createHttpServer, installLifecycle } from "./lifecycle.mjs";
import { createCostBudget } from "./cost-budget.mjs";
import { createUploadAdmission, positive } from "./upload-admission.mjs";
import { registerTiledUploads } from "./tiled-uploads.mjs";
import { createDeepSeekFiles } from "./deepseek-files.mjs";
import { createRequestMetrics } from "./request-metrics.mjs";
import { createRecognitionQueue, publicJob } from "./recognition-queue.mjs";
import { recognitionFiles } from "./recognition-files.mjs";
import multer from "multer";
import { DatabaseSync } from "node:sqlite";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { providers, publicProviders } from "./providers.mjs";
import { cleanModelJson } from "./model-json.mjs";
import { isWordDocument } from "./document-types.mjs";
import { createPasswordHasher } from "./passwords.mjs";
import { cacheStatements } from "./statement-cache.mjs";
import {
  buildAssignmentStats,
  buildStudentStats,
  loadAssignmentData,
  mergeReasonTypes,
  promptPayload,
  reasonTypeCatalog,
  safeParse,
} from "./analysis.mjs";
import { createModelBudget, modelErrorStatus } from "./model-budget.mjs";
import { createModelImages } from "./model-images.mjs";
import { teachingContent } from "./teaching-content.mjs";
import {
  normalizeReview,
  publicPractice,
  studentAnalysis,
  practiceGrade,
} from "./grading.mjs";
import {
  providerEndpoint,
  assertPublicProviderEndpoint,
  sameOriginWrites,
  authRateLimit,
  validPassword,
  validateUploads,
} from "./security.mjs";
import { APP_VERSION, BUILD_NUMBER, VERSION_LABEL } from "./version.mjs";
import { migrateDatabase, deriveUsernameSeed } from "./migrations.mjs";
import { registerAccountsRoutes } from "./accounts.mjs";
import { registerParentRoutes } from "./parent.mjs";
import {
  registerReviewRoutes,
  annotateReviewItems,
  assertReviewModeComplete,
  commitReview,
  isSuspectItem,
} from "./review.mjs";
import {
  buildDirectGradingPrompt,
  normalizeDirectGrading,
  linkQuestions,
} from "./direct-grading.mjs";
import { registerMistakeRoutes } from "./mistakes-guide.mjs";
import {
  registerModelAccessRoutes,
  resolveCredentialOwner,
  describeModelAccess,
  createModelConfigGuard,
  getSchoolModelMode,
} from "./model-access.mjs";
import {
  registerOAuthRoutes,
  oauthChatText,
  getOAuthConnection,
  oauthProvider,
} from "./oauth.mjs";
import { normalizeDirectReview } from "./grading.mjs";

const configuredSecret = process.env.APP_SECRET;
if (
  process.env.NODE_ENV === "production" &&
  (!configuredSecret ||
    configuredSecret.length < 32 ||
    configuredSecret.includes("请替换"))
) {
  throw new Error("生产环境必须配置至少 32 位随机 APP_SECRET");
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const data = path.resolve(process.env.DATA_DIR || path.join(root, "data"));
const files = path.join(data, "uploads");
fs.mkdirSync(files, { recursive: true });
const db = new DatabaseSync(path.join(data, "smart-campus.sqlite"));
const sqliteWait = Number(process.env.SQLITE_BUSY_TIMEOUT_MS ?? 0);
if (!Number.isSafeInteger(sqliteWait) || sqliteWait < 0 || sqliteWait > 1000)
  throw new Error("SQLITE_BUSY_TIMEOUT_MS 必须为 0–1000 的整数");
// A synchronous SQLite wait blocks every reader on this event loop. Default
// to SQLite's immediate busy response; callers receive a retryable 503.
db.exec(`PRAGMA busy_timeout=${sqliteWait}`);
const schemaSql = fs.readFileSync(path.join(root, "server/schema.sql"), "utf8");
// v0.2.1: rebuild users/mistakes where SQLite cannot widen constraints in place,
// then create v0.2.1 tables and derive account names for legacy rows.
migrateDatabase(db, { schemaSql });
const capabilities = applicationCapabilities(db);
db.exec(`
  UPDATE users SET is_school_admin=1
  WHERE id IN (
    SELECT first_teacher.id FROM users first_teacher
    WHERE first_teacher.role='teacher'
      AND first_teacher.created_at=(
        SELECT MIN(candidate.created_at) FROM users candidate
        WHERE candidate.school_id=first_teacher.school_id AND candidate.role='teacher'
      )
      AND NOT EXISTS(
        SELECT 1 FROM users administrator
        WHERE administrator.school_id=first_teacher.school_id AND administrator.is_school_admin=1
      )
  )
`);
// Legacy-column guards kept for deployments that skipped intermediate releases;
// migrateDatabase already performs the structural work.
const mistakeColumns = db.prepare("PRAGMA table_info(mistakes)").all();
if (!mistakeColumns.some((column) => column.name === "explanation"))
  db.exec(
    "ALTER TABLE mistakes ADD COLUMN explanation TEXT NOT NULL DEFAULT ''",
  );
if (!mistakeColumns.some((column) => column.name === "practice_json"))
  db.exec("ALTER TABLE mistakes ADD COLUMN practice_json TEXT");
if (!mistakeColumns.some((column) => column.name === "mastery"))
  db.exec("ALTER TABLE mistakes ADD COLUMN mastery INTEGER NOT NULL DEFAULT 0");
if (
  !db
    .prepare("PRAGMA table_info(teaching_analyses)")
    .all()
    .some((column) => column.name === "source_revision")
)
  db.exec(
    "ALTER TABLE teaching_analyses ADD COLUMN source_revision TEXT NOT NULL DEFAULT ''",
  );
const statements = cacheStatements(db);
const passwords = createPasswordHasher();
const pressure = createResourcePressure(data);
await pressure.ready;
const reserveModel = createModelBudget(db, { pressure });
const costBudget = createCostBudget(db);
const uploadAdmission = createUploadAdmission(db, data, { pressure });
const app = express();
const requestMetrics = createRequestMetrics();
app.disable("x-powered-by");
app.use("/api", requestAdmission());
app.use("/api", requestScope);
app.use("/api", (req, res, next) => {
  const started = performance.now();
  res.once("finish", () =>
    requestMetrics.record(
      req.user?.school_id,
      res.statusCode,
      performance.now() - started,
    ),
  );
  next();
});
app.use(sameOriginWrites);
// Only trust proxy headers when explicitly configured with the trusted proxy
// count; otherwise req.ip (used by authRateLimit) would collapse every client
// behind a CDN/reverse proxy into one shared bucket.
if (process.env.TRUST_PROXY_HOPS) {
  const hops = Number(process.env.TRUST_PROXY_HOPS);
  if (Number.isSafeInteger(hops) && hops > 0) app.set("trust proxy", hops);
}
app.use(limitJsonBodies());
app.use(express.json({ limit: "2mb" }));
app.use(
  ["/api/auth/login", "/api/auth/register", "/api/schools/register"],
  authRateLimit(),
);
app.use("/api", (req, res, next) => {
  if (
    req.method === "PUT" &&
    /^\/upload-sessions\/[^/]+\/parts\/[^/]+$/.test(req.path)
  )
    return next();
  if (
    !req.body &&
    !req.get("content-type") &&
    !Number(req.get("content-length"))
  )
    req.body = {};
  if (
    ["POST", "PUT", "PATCH"].includes(req.method) &&
    !req.is("multipart/form-data") &&
    (!req.body || Array.isArray(req.body) || typeof req.body !== "object")
  )
    return res.status(400).json({ error: "请求须为 JSON 对象" });
  next();
});
const uploadStorage = createUploadStorage(db, files);
app.use((req, res, next) => {
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    void uploadStorage
      .cleanupRequest(req)
      .catch(() => console.error("Upload cleanup pending retry"));
  };
  res.once("finish", cleanup);
  res.once("close", cleanup);
  next();
});
const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: 20 * 1024 * 1024, files: 10, fields: 20, parts: 30 },
  fileFilter: (_r, f, cb) =>
    cb(
      null,
      [
        "image/jpeg",
        "image/png",
        "image/webp",
        "application/pdf",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ].includes(f.mimetype),
    ),
});
const rosterUpload = multer({
  storage: uploadStorage,
  limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 20, parts: 21 },
});
const uid = () => randomUUID(),
  iso = () => new Date().toISOString();
const secret = createHash("sha256")
  .update(process.env.APP_SECRET || "development-only-change-me")
  .digest();
const pass = (password, salt, batch = false) =>
  passwords.hash(password, salt, { signal: requestSignal(), batch });
const parseCookies = (req) =>
  Object.fromEntries(
    (req.headers.cookie || "")
      .split(";")
      .filter(Boolean)
      .map((v) => v.trim().split(/=(.*)/s).slice(0, 2)),
  );
function auth(req, res, next) {
  const sid = parseCookies(req).sc_session;
  const u =
    sid &&
    db
      .prepare(
        "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.expires_at>?",
      )
      .get(sid, iso());
  if (!u) return res.status(401).json({ error: "请先登录" });
  req.user = u;
  next();
}
const teacher = (req, res, next) =>
  req.user.role === "teacher" && !req.user.is_school_admin
    ? next()
    : res.status(403).json({ error: "仅教师可执行此操作" });
const schoolAdmin = (req, res, next) =>
  req.user.is_school_admin
    ? next()
    : res.status(403).json({ error: "仅学校管理员可执行此操作" });
const schoolStaff = (req, res, next) =>
  req.user.role === "teacher"
    ? next()
    : res.status(403).json({ error: "仅学校教职工可执行此操作" });
// 教学分析涉及生成、改判和写入跟进名单，只允许任课教师本人操作；
// 学校管理员可以只读查看全校教学分析，但不参与具体教学动作。
const teachingAuthor = (req, res, next) =>
  req.user.role === "teacher" && !req.user.is_school_admin
    ? next()
    : res.status(403).json({ error: "仅任课教师可执行教学分析操作" });
const tiledUploads = registerTiledUploads(app, {
  db,
  auth,
  accessibleAssignment,
  files,
  data,
  admission: uploadAdmission,
  costBudget,
});
const deepseekFiles = createDeepSeekFiles(db, { decrypt });
function setSession(res, userId) {
  const sid = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
    sid,
    userId,
    new Date(Date.now() + 7 * 864e5).toISOString(),
  );
  // Opportunistically purge expired sessions so the table cannot grow forever;
  // throttled to at most once per minute to avoid a write on every login.
  if (Date.now() - lastSessionSweep > 60_000) {
    lastSessionSweep = Date.now();
    db.prepare("DELETE FROM sessions WHERE expires_at<=?").run(iso());
  }
  res.setHeader(
    "Set-Cookie",
    `sc_session=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${
      process.env.NODE_ENV === "production" ? "; Secure" : ""
    }`,
  );
}
let lastSessionSweep = 0;
function encrypt(text) {
  const iv = randomBytes(12),
    c = createCipheriv("aes-256-gcm", secret, iv);
  const body = Buffer.concat([c.update(text), c.final(), c.getAuthTag()]);
  return [body.toString("base64"), iv.toString("base64")];
}
function decrypt(body, iv) {
  const b = Buffer.from(body, "base64"),
    d = createDecipheriv("aes-256-gcm", secret, Buffer.from(iv, "base64"));
  d.setAuthTag(b.subarray(-16));
  return Buffer.concat([d.update(b.subarray(0, -16)), d.final()]).toString();
}

// Resolve the credential owner for a caller according to the school's model
// mode (school-wide / teacher+class / teacher+parent). All model calls go
// through the owner's own API Key or OAuth connection.
function modelOwnerFor(user) {
  const route = resolveCredentialOwner(db, user);
  return route.owner || user;
}

function modelConfigFor(owner, { vision = false } = {}) {
  if (owner.model_auth_mode === "oauth" && owner.oauth_provider) {
    const connection = getOAuthConnection(db, owner.id, owner.oauth_provider);
    const preset = oauthProvider(owner.oauth_provider);
    if (connection && preset) {
      if (vision && !preset.vision)
        throw new Error(
          "当前 OAuth 模型不支持图片识别，请改用支持视觉的 API Key 模型",
        );
      return { kind: "oauth", connection, preset };
    }
  }
  const config = db
    .prepare("SELECT * FROM provider_settings WHERE user_id=?")
    .get(owner.id);
  if (!config) {
    throw new Error(
      owner.model_auth_mode === "oauth"
        ? "OAuth 授权已失效，请重新连接，或在设置中配置 API Key"
        : "请先在设置中配置模型 API Key 或完成 OAuth 授权",
    );
  }
  const preset = providers[config.provider];
  if (!preset) throw new Error("模型厂商无效");
  if (vision && !preset.vision) throw new Error("请配置支持图片的视觉模型");
  return { kind: "api_key", config, preset };
}

// Throws a user-facing error when the effective credential owner has neither a
// usable API Key nor a live OAuth connection. Returns the owner row.
function assertModelConfigured(user) {
  const owner = modelOwnerFor(user);
  modelConfigFor(owner);
  return owner;
}

const modelImages = createModelImages({
  maxBytes: runtimeProfile().inlineMiB * 1024 ** 2,
});
async function askModel(
  userOrId,
  prompt,
  images = [],
  reservation = null,
  signal = null,
) {
  signal = requestSignal(signal || AbortSignal.timeout(120000));
  signal.throwIfAborted();
  const owner =
    typeof userOrId === "string"
      ? db.prepare("SELECT * FROM users WHERE id=?").get(userOrId)
      : userOrId;
  if (!owner) throw new Error("账户不存在");
  const release = reservation || reserveModel(owner.id);
  let cost, remote, imageLease;
  try {
    // Resolve the effective credential owner (API Key or OAuth) before any
    // DNS, image buffering or outbound I/O.
    const credential = modelConfigFor(owner, { vision: images.length > 0 });
    release.renew();
    let text;
    if (credential.kind === "oauth") {
      imageLease = await modelImages.acquire(images, signal);
      let bytes = 0;
      const oauthImages = [];
      for (const image of images) {
        signal.throwIfAborted();
        pressure.assertMemory();
        const base64 =
          image.base64 ||
          (await fs.promises.readFile(image.filePath, { signal })).toString(
            "base64",
          );
        bytes += base64.length;
        if (bytes > imageLease.maxBytes)
          throw new Error("图片大小在读取期间发生变化，请重试");
        oauthImages.push({ ...image, base64 });
      }
      text = await oauthChatText({
        user: owner,
        provider: credential.preset,
        connection: credential.connection,
        prompt,
        images: oauthImages,
        signal,
        decrypt,
        encrypt,
        db,
      });
    } else {
      const { config, preset } = credential;
      const endpoint = providerEndpoint(config.endpoint, preset);
      // Revalidate DNS on every request while bounding its lifetime and
      // concurrent lookups too.
      await abortable(assertPublicProviderEndpoint(endpoint), signal);
      pressure.assertMemory();
      cost = costBudget.reserve(owner.id, config, prompt, images.length);
      let imageBlocks;
      if (
        images.length &&
        config.provider === "deepseek" &&
        process.env.DEEPSEEK_FILES_ENABLED === "1"
      ) {
        if (!costBudget.enabled)
          throw new Error("Files API 需要先配置费用预算");
        remote = await deepseekFiles.prepare(images, config, signal);
        imageBlocks = remote.blocks;
      } else {
        imageLease = await modelImages.acquire(images, signal);
        let bytes = 0;
        imageBlocks = [];
        for (const image of images) {
          signal.throwIfAborted();
          pressure.assertMemory();
          if (!image.base64) {
            const stat = await fs.promises.stat(image.filePath);
            if (bytes + 4 * Math.ceil(stat.size / 3) > 44 * 1024 * 1024)
              throw new Error("内联图片合计过大，请减少页数或启用 Files API");
          }
          const base64 =
            image.base64 ||
            (await fs.promises.readFile(image.filePath, { signal })).toString(
              "base64",
            );
          bytes += base64.length;
          if (bytes > imageLease.maxBytes)
            throw new Error("图片大小在读取期间发生变化，请重试");
          if (bytes > 44 * 1024 * 1024)
            throw new Error("内联图片合计过大，请减少页数或启用 Files API");
          imageBlocks.push({
            type: "image_url",
            image_url: {
              url: `data:${image.mimeType};base64,${base64}`,
              detail: "high",
            },
          });
        }
      }
      const content = [{ type: "text", text: prompt }];
      imageBlocks.forEach((block, index) => {
        const image = images[index];
        content.push({
          type: "text",
          text:
            image.page === undefined
              ? `第 ${index + 1} 页：`
              : `第 ${image.page + 1} 页，区域(${image.x},${image.y},${image.width},${image.height})。与相邻块有重叠，同一题只返回一次，不得重复计分。`,
        });
        content.push(block);
      });
      release.renew();
      signal.throwIfAborted();
      cost?.dispatch();
      const request = providerRequest(
        config,
        images.length ? content : prompt,
        decrypt(config.encrypted_key, config.iv),
        cost?.maxTokens ||
          Math.min(positive("MODEL_MAX_OUTPUT_TOKENS", 8192), 32768),
      );
      const { response: rr, body: raw } = await requestJson(
        endpoint,
        {
          redirect: "error",
          signal,
          method: "POST",
          headers: request.headers,
          body: JSON.stringify(request.body),
        },
        modelResponseLimits(),
      );
      if (!rr.ok) throw providerHttpError(rr.status, raw);
      const reply = providerReply(config, raw);
      cost?.settle(reply.usage);
      assertProviderCompletion(config, raw);
      text = reply.text;
    }
    if (!text) throw new Error("模型没有返回识别内容");
    return cleanModelJson(text);
  } finally {
    remote?.release();
    imageLease?.release();
    cost?.close();
    release();
  }
}

// High-level entry point used by feature modules: resolves the credential
// owner, enforces the school's model mode, and parses the JSON reply.
// Rate/quota accounting stays on the *caller* (student/parent/teacher) so a
// shared school credential cannot bypass per-student or per-staff budgets.
async function callModel(
  user,
  prompt,
  images = [],
  signal = null,
  reservation = null,
) {
  const owner = modelOwnerFor(user);
  return askModel(
    owner,
    prompt,
    images,
    reservation || reserveModel(user.id),
    signal,
  );
}

// Route modules receive the shared application context. Keeping persistence
// helpers here (instead of importing index.mjs from modules) avoids cycles.
const ctx = {
  db,
  uid,
  iso,
  pass,
  encrypt,
  decrypt,
  auth,
  teacher,
  schoolAdmin,
  schoolStaff,
  teachingAuthor,
  validPassword,
  callModel,
  askModel,
  reserveModel,
  modelErrorStatus,
  publicPractice,
  safeParse,
  setSession,
  providers,
  publicProviders,
  // Module-facing model route: the credential owner plus the model label that
  // the owner actually uses (API Key model or OAuth provider id).
  resolveModelRoute: (user) => {
    const route = resolveCredentialOwner(db, user);
    const owner = route.owner;
    const config = owner
      ? db
          .prepare(
            "SELECT provider,model FROM provider_settings WHERE user_id=?",
          )
          .get(owner.id) || null
      : null;
    return {
      ...route,
      owner: owner
        ? {
            ...owner,
            model: config?.model || owner.oauth_provider || "",
            provider: config?.provider || owner.oauth_provider || "",
          }
        : null,
      model: config?.model || owner?.oauth_provider || "",
      provider: config?.provider || owner?.oauth_provider || "",
    };
  },
  getSchoolModelMode: (schoolId) => getSchoolModelMode(db, schoolId),
};
registerAccountsRoutes(app, ctx);
registerParentRoutes(app, ctx);
registerReviewRoutes(app, ctx);
registerMistakeRoutes(app, ctx);
registerModelAccessRoutes(app, ctx);
registerOAuthRoutes(app, ctx);

const modelConfigGuard = createModelConfigGuard(db);
app.get("/api/health", (_q, r) =>
  r.json({
    ok: true,
    version: APP_VERSION,
    build: BUILD_NUMBER,
    versionLabel: VERSION_LABEL,
    storage: "SQLite + local filesystem",
  }),
);
app.get("/api/providers", (_q, r) => r.json(publicProviders()));
app.get("/api/capabilities", (_q, r) => r.json(capabilities));

app.post("/api/auth/logout", auth, (req, res) => {
  db.prepare("DELETE FROM sessions WHERE user_id=?").run(req.user.id);
  res.setHeader("Set-Cookie", "sc_session=; Path=/; Max-Age=0");
  res.json({ ok: true });
});
app.get("/api/me", auth, (req, res) => {
  const { password_hash, salt, ...u } = req.user;
  res.json(u);
});
app.patch("/api/me", auth, (req, res) => {
  const x = req.body;
  // 学生与家长的学段/班级/学科由学校与班主任维护，不能自行改动。
  if (
    req.user.role !== "teacher" &&
    (x.stage !== undefined ||
      x.className !== undefined ||
      x.subject !== undefined)
  )
    return res.status(403).json({ error: "学生与家长不能自行更改学段或班级" });
  if (x.stage && !capabilities.stages.includes(x.stage))
    return res.status(400).json({ error: "学段无效" });
  db.prepare(
    "UPDATE users SET stage=COALESCE(?,stage),subject=COALESCE(?,subject),class_name=COALESCE(?,class_name),name=COALESCE(?,name) WHERE id=?",
  ).run(
    x.stage || null,
    x.subject || null,
    x.className || null,
    x.name || null,
    req.user.id,
  );
  res.json({ ok: true });
});
app.get("/api/settings/provider", auth, (req, res) =>
  res.json(
    db
      .prepare(
        "SELECT provider,endpoint,model,updated_at FROM provider_settings WHERE user_id=?",
      )
      .get(req.user.id) || null,
  ),
);
app.put(
  "/api/settings/provider",
  auth,
  (req, res, next) => modelConfigGuard(req, res, next),
  async (req, res) => {
    const p =
      Object.hasOwn(providers, req.body.provider) &&
      providers[req.body.provider];
    if (!p || !req.body.apiKey)
      return res.status(400).json({ error: "请选择厂商并填写 API Key" });
    let endpoint;
    try {
      endpoint = providerEndpoint(req.body.endpoint || p.endpoint, p);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    if (
      typeof req.body.apiKey !== "string" ||
      req.body.apiKey.length > 8192 ||
      !req.body.apiKey.trim() ||
      /[\r\n]/.test(req.body.apiKey.trim())
    )
      return res.status(400).json({ error: "API Key 格式无效" });
    // Reject endpoints whose DNS resolves to internal addresses before saving,
    // so a rebinding target cannot be persisted and used with the stored key.
    try {
      await assertPublicProviderEndpoint(endpoint);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    if (
      req.body.model != null &&
      (typeof req.body.model !== "string" || req.body.model.length > 256)
    )
      return res.status(400).json({ error: "模型名称格式无效" });
    const [key, iv] = encrypt(req.body.apiKey.trim());
    const model = req.body.model?.trim() || p.model;
    db.prepare(
      "INSERT INTO provider_settings(id,user_id,provider,endpoint,model,encrypted_key,iv,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET provider=excluded.provider,endpoint=excluded.endpoint,model=excluded.model,encrypted_key=excluded.encrypted_key,iv=excluded.iv,updated_at=excluded.updated_at",
    ).run(
      uid(),
      req.user.id,
      req.body.provider,
      endpoint,
      model,
      key,
      iv,
      iso(),
    );
    res.json({ ok: true, provider: req.body.provider, endpoint, model });
  },
);
app.get("/api/knowledge", auth, (req, res) =>
  res.json(
    db
      .prepare(
        "SELECT * FROM knowledge WHERE school_id=? ORDER BY created_at DESC",
      )
      .all(req.user.school_id),
  ),
);
app.get("/api/school/summary", auth, schoolAdmin, (req, res) => {
  const school = db
    .prepare("SELECT id,name,created_at FROM schools WHERE id=?")
    .get(req.user.school_id);
  const teachers = db
    .prepare(
      "SELECT COUNT(*) total FROM users WHERE school_id=? AND role='teacher' AND is_school_admin=0",
    )
    .get(req.user.school_id).total;
  const students = db
    .prepare(
      "SELECT COUNT(*) total FROM users WHERE school_id=? AND role='student'",
    )
    .get(req.user.school_id).total;
  const parents = db
    .prepare(
      "SELECT COUNT(*) total FROM users WHERE school_id=? AND role='parent'",
    )
    .get(req.user.school_id).total;
  const classes = db
    .prepare(
      "SELECT COUNT(DISTINCT class_name) total FROM users WHERE school_id=? AND role='student' AND class_name IS NOT NULL AND class_name<>''",
    )
    .get(req.user.school_id).total;
  const assignments = db
    .prepare("SELECT COUNT(*) total FROM assignments WHERE school_id=?")
    .get(req.user.school_id).total;
  res.json({
    school,
    teachers,
    students,
    parents,
    classes,
    assignments,
    modelMode: getSchoolModelMode(db, req.user.school_id),
  });
});
app.post(
  "/api/students/import",
  auth,
  schoolStaff,
  uploadAdmission.legacy,
  rosterUpload.single("file"),
  async (req, res) => {
    if (!req.file)
      return res.status(400).json({ error: "请选择 CSV 或 XLSX 文件" });
    try {
      const isCsv = req.file.originalname.toLowerCase().endsWith(".csv");
      pressure.assertMemory();
      const signal = requestSignal();
      const { table } = await recognitionFiles(
        [
          {
            file_type: "application/x-mes-roster",
            file_path: req.file.path,
            isCsv,
          },
        ],
        signal,
        { admission: () => pressure.assertParser() },
      );
      const headers = (table[0] || []).map((value) =>
        String(value || "").trim(),
      );
      const rows = table
        .slice(1)
        .map((values) =>
          Object.fromEntries(
            headers.map((header, index) => [
              header,
              String(values[index] || "").trim(),
            ]),
          ),
        )
        .filter((item) => Object.values(item).some(Boolean));
      if (!rows.length)
        return res.status(400).json({ error: "文件中没有学生数据" });
      if (rows.length > 500)
        return res.status(400).json({ error: "单次最多导入 500 名学生" });
      const created = [];
      const errors = [];
      const insert = db.prepare(
        "INSERT INTO users(id,school_id,role,name,username,email,password_hash,salt,stage,subject,class_name,created_at,is_school_admin) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0)",
      );
      const usernameTaken = db.prepare(
        "SELECT 1 present FROM users WHERE username=?",
      );
      const uniqueUsername = (base) => {
        const cleaned = String(base || "")
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9_.\-\u4e00-\u9fa5]/g, "")
          .slice(0, 28);
        let seed =
          cleaned.length >= 2
            ? cleaned
            : `stu_${randomBytes(4).toString("hex")}`;
        let candidate = seed;
        for (let n = 2; usernameTaken.get(candidate); n += 1)
          candidate = `${seed.slice(0, 27)}_${n}`;
        return candidate;
      };
      for (const [index, row] of rows.entries()) {
        signal.throwIfAborted();
        const name = String(row["姓名"] || row.name || "").trim();
        const email = String(row["邮箱"] || row.email || "")
          .trim()
          .toLowerCase();
        const rawUsername = String(
          row["账号名"] || row["账号"] || row.username || row.account || "",
        ).trim();
        const initialPassword = String(
          row["初始密码"] ||
            row.password ||
            `Sc${randomBytes(5).toString("hex")}!`,
        );
        const stage = String(
          row["学段"] || row.stage || req.user.stage || "",
        ).trim();
        const className = String(
          row["班级"] ||
            row.className ||
            row.class ||
            req.user.class_name ||
            "",
        ).trim();
        try {
          if (
            !name ||
            !capabilities.stages.includes(stage) ||
            !validPassword(initialPassword)
          )
            throw new Error("姓名、学段或密码格式无效");
          const username = uniqueUsername(
            rawUsername || deriveUsernameSeed(email || name, name),
          );
          const id = uid();
          const salt = randomBytes(16).toString("hex");
          insert.run(
            id,
            req.user.school_id,
            "student",
            name,
            username,
            email || null,
            await pass(initialPassword, salt, true),
            salt,
            stage,
            null,
            className,
            iso(),
          );
          created.push({
            row: index + 2,
            id,
            name,
            username,
            email,
            initialPassword,
          });
        } catch (error) {
          if (error.status === 503 || signal.aborted) throw error;
          errors.push({
            row: index + 2,
            name,
            email,
            error: String(error).includes("UNIQUE")
              ? "账号名或邮箱已注册"
              : error.message,
          });
        }
      }
      res.json({ total: rows.length, created, errors });
    } catch (error) {
      res
        .status(error.status || 400)
        .json({ error: `无法读取学生名单：${error.message}` });
    }
  },
);
app.post("/api/knowledge", auth, teacher, (req, res) => {
  const x = req.body;
  if (!x.title) return res.status(400).json({ error: "名称不能为空" });
  const id = uid();
  db.prepare("INSERT INTO knowledge VALUES(?,?,?,?,?,?,?,?)").run(
    id,
    req.user.school_id,
    x.stage || req.user.stage,
    x.subject || req.user.subject,
    x.title,
    x.description || "",
    req.user.id,
    iso(),
  );
  res.json({ id });
});
app.get("/api/assignments", auth, (req, res) => {
  const sql =
    req.user.role === "teacher"
      ? "SELECT a.*,COUNT(q.id) question_count FROM assignments a LEFT JOIN questions q ON q.assignment_id=a.id WHERE teacher_id=? GROUP BY a.id ORDER BY a.created_at DESC"
      : "SELECT a.*,COUNT(q.id) question_count FROM assignments a LEFT JOIN questions q ON q.assignment_id=a.id WHERE a.school_id=? AND a.stage=? AND a.class_name=? GROUP BY a.id ORDER BY a.created_at DESC";
  res.json(
    req.user.role === "teacher"
      ? db.prepare(sql).all(req.user.id)
      : db
          .prepare(sql)
          .all(req.user.school_id, req.user.stage, req.user.class_name),
  );
});
app.post(
  "/api/assignments/import",
  auth,
  teacher,
  uploadAdmission.legacy,
  upload.single("file"),
  validateUploads,
  async (req, res) => {
    if (!req.file)
      return res
        .status(400)
        .json({ error: "请选择作业图片、PDF、DOCX 或 DOC" });
    try {
      assertModelConfigured(req.user);
      const signal = requestSignal();
      const { images, documentText, warnings } = await recognitionFiles(
        [{ file_path: req.file.path, file_type: req.file.mimetype }],
        signal,
        { admission: () => pressure.assertParser() },
      );
      const word = isWordDocument(req.file.mimetype, req.file.originalname)
        ? { text: documentText, warnings }
        : null;
      const knowledge = db
        .prepare(
          "SELECT id,title,description FROM knowledge WHERE school_id=? AND stage=? AND subject=? ORDER BY title",
        )
        .all(req.user.school_id, req.user.stage, req.user.subject);
      const prompt = `你是学校作业数字化助手。请忠实解析这份教师上传的作业原件，并整理为可直接发布的草稿。\n教师设置：学段=${req.user.stage}，学科=${req.user.subject}，班级=${req.user.class_name}。\n${word ? `Word 文档已提取文字：\n${word.text}\n` : "图片/PDF 已按页面附在消息中。"}\n现有校本知识库=${JSON.stringify(knowledge)}。\n规则：1. 只能提取原件中实际出现的题目，按原顺序，不得补题或改题；2. 无法辨认的部分写[无法辨认]；3. 原件没有答案时，根据题目自行推导标准答案与简明评分要点，并在 answerGenerated 标记 true；4. 优先使用现有知识点；没有匹配项时生成一个符合该学段教材的简洁知识点名称，并在 knowledgeGenerated 标记 true；5. 原件未标分值时，根据题型和难度给出合理分值。\n只返回 JSON：{"title":"原件标题或文件名","questions":[{"prompt":"完整题干","standardAnswer":"答案与评分要点","score":10,"knowledgeTitle":"知识点","answerGenerated":true,"knowledgeGenerated":false}],"warnings":["确实需要教师注意的识别问题"]}`;
      const parsed = await callModel(req.user, prompt, images, signal);
      if (!Array.isArray(parsed.questions) || !parsed.questions.length)
        throw new Error("未从文件中识别到题目，请检查图片清晰度或模型配置");
      const knowledgeMap = new Map(
        knowledge.map((item) => [item.title, item.id]),
      );
      const generatedKnowledge = [];
      for (const item of parsed.questions) {
        const title = String(item.knowledgeTitle || "").trim();
        if (!title || knowledgeMap.has(title)) continue;
        const id = uid();
        db.prepare("INSERT INTO knowledge VALUES(?,?,?,?,?,?,?,?)").run(
          id,
          req.user.school_id,
          req.user.stage,
          req.user.subject,
          title,
          "由作业解析自动生成，教师可在知识库中补充说明与边界。",
          req.user.id,
          iso(),
        );
        knowledgeMap.set(title, id);
        generatedKnowledge.push(title);
      }
      res.json({
        title: parsed.title || path.parse(req.file.originalname).name,
        questions: parsed.questions.map((item) => ({
          prompt: String(item.prompt || "").trim(),
          standardAnswer: String(item.standardAnswer || "").trim(),
          score: Number(item.score) || 0,
          knowledgeId:
            knowledgeMap.get(String(item.knowledgeTitle || "").trim()) || "",
          knowledgeTitle: String(item.knowledgeTitle || "").trim(),
          answerGenerated: Boolean(item.answerGenerated),
          knowledgeGenerated: Boolean(item.knowledgeGenerated),
        })),
        warnings: [
          ...(word?.warnings || []),
          ...(Array.isArray(parsed.warnings) ? parsed.warnings : []),
        ],
        generatedKnowledge,
        pageCount: word ? 1 : images.length,
      });
    } catch (error) {
      res
        .status(modelErrorStatus(error))
        .json({ error: error.message || "作业解析失败" });
    } finally {
      // The registered staging-file janitor also covers disconnect/error paths.
    }
  },
);
app.post("/api/assignments", auth, teacher, (req, res) => {
  const x = req.body;
  const gradingMode = x.gradingMode === "direct" ? "direct" : "bank";
  const description =
    typeof x.description === "string"
      ? x.description.trim().slice(0, 2000)
      : "";
  if (!x.title || typeof x.title !== "string" || !x.title.trim())
    return res.status(400).json({ error: "请填写作业名称" });
  if (gradingMode === "direct") {
    // v0.2.1: 无需先上传原题，教师只需给出作业名称与可选的内容描述，
    // 学生答卷上传后由模型直接切题、给参考答案并批改。
    const id = uid();
    try {
      db.prepare(
        "INSERT INTO assignments(id,school_id,teacher_id,title,stage,subject,class_name,due_at,status,created_at,description,grading_mode) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        id,
        req.user.school_id,
        req.user.id,
        String(x.title).trim(),
        x.stage || req.user.stage,
        x.subject || req.user.subject,
        x.className || req.user.class_name,
        x.dueAt || null,
        "published",
        iso(),
        description,
        "direct",
      );
      return res.json({ id, gradingMode: "direct" });
    } catch {
      return res.status(400).json({ error: "保存失败" });
    }
  }
  if (!x.questions?.length)
    return res.status(400).json({ error: "请至少录入一道真实题目" });
  if (
    !Array.isArray(x.questions) ||
    x.questions.length > 500 ||
    x.questions.some(
      (q) =>
        !q ||
        typeof q.prompt !== "string" ||
        !q.prompt.trim() ||
        typeof q.standardAnswer !== "string" ||
        !q.standardAnswer.trim() ||
        !Number.isFinite(Number(q.score)) ||
        Number(q.score) < 0 ||
        (q.knowledgeId &&
          !db
            .prepare("SELECT id FROM knowledge WHERE id=? AND school_id=?")
            .get(q.knowledgeId, req.user.school_id)),
    )
  )
    return res.status(400).json({ error: "题目或知识点无效" });
  const id = uid();
  db.exec("BEGIN");
  try {
    db.prepare(
      "INSERT INTO assignments(id,school_id,teacher_id,title,stage,subject,class_name,due_at,status,created_at,description,grading_mode) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      id,
      req.user.school_id,
      req.user.id,
      String(x.title).trim(),
      x.stage || req.user.stage,
      x.subject || req.user.subject,
      x.className || req.user.class_name,
      x.dueAt || null,
      "published",
      iso(),
      description,
      "bank",
    );
    const q = db.prepare("INSERT INTO questions VALUES(?,?,?,?,?,?,?)");
    x.questions.forEach((v, i) =>
      q.run(
        uid(),
        id,
        i + 1,
        v.prompt,
        v.standardAnswer,
        v.knowledgeId || null,
        Number(v.score) || 0,
      ),
    );
    db.exec("COMMIT");
    res.json({ id, gradingMode: "bank" });
  } catch (e) {
    db.exec("ROLLBACK");
    res.status(400).json({ error: "保存失败" });
  }
});
function accessibleAssignment(req) {
  const a = db
    .prepare("SELECT * FROM assignments WHERE id=? AND school_id=?")
    .get(req.params.id, req.user.school_id);
  if (!a) return null;
  if (req.user.role === "teacher")
    return req.user.is_school_admin || a.teacher_id === req.user.id ? a : null;
  return a.status === "published" &&
    a.stage === req.user.stage &&
    a.class_name === req.user.class_name
    ? a
    : null;
}

function submissionFor(req) {
  const s = db
    .prepare(
      "SELECT s.*,a.school_id,a.teacher_id FROM submissions s JOIN assignments a ON a.id=s.assignment_id WHERE s.id=? AND a.school_id=?",
    )
    .get(req.params.id, req.user.school_id);
  if (!s) return null;
  return req.user.role === "teacher"
    ? req.user.is_school_admin || s.teacher_id === req.user.id
      ? s
      : null
    : s.student_id === req.user.id
      ? s
      : null;
}

function submissionFiles(submission) {
  const rows = db
    .prepare(
      "SELECT * FROM submission_files WHERE submission_id=? ORDER BY position",
    )
    .all(submission.id);
  return rows.length
    ? rows
    : [
        {
          file_path: submission.file_path,
          file_type: submission.file_type,
          original_name: path.basename(submission.file_path),
          position: 0,
        },
      ];
}

// Uploaded student work is private, including legacy /uploads URLs.
app.get("/uploads/:name", auth, (req, res) => {
  const s = db
    .prepare(
      "SELECT id FROM submissions WHERE file_path=? UNION SELECT submission_id AS id FROM submission_files WHERE file_path=?",
    )
    .get(path.join(files, req.params.name), path.join(files, req.params.name));
  if (!s || !submissionFor({ ...req, params: { id: s.id } }))
    return res.status(404).json({ error: "文件不存在" });
  res.setHeader("Content-Disposition", "attachment");
  res.setHeader("Cache-Control", "private, no-store");
  res.sendFile(path.join(files, req.params.name));
});

app.get("/api/assignments/:id", auth, (req, res) => {
  const a = accessibleAssignment(req);
  if (!a) return res.status(404).json({ error: "作业不存在" });
  res.json({
    ...a,
    questions: db
      .prepare(
        "SELECT q.*,k.title knowledge_title FROM questions q LEFT JOIN knowledge k ON k.id=q.knowledge_id WHERE assignment_id=? ORDER BY number",
      )
      .all(a.id)
      .map((question) => {
        if (req.user.role === "student") {
          const { standard_answer, ...visible } = question;
          return visible;
        }
        return question;
      }),
  });
});
app.post(
  "/api/assignments/:id/submissions",
  auth,
  (req, res, next) => {
    const a = accessibleAssignment(req);
    if (!a || req.user.is_school_admin)
      return res.status(404).json({ error: "作业不存在" });
    req.assignment = a;
    next();
  },
  uploadAdmission.legacy,
  upload.array("files", 10),
  validateUploads,
  (req, res) => {
    const a = req.assignment;
    if (!a) return res.status(404).json({ error: "作业不存在" });
    const linkedStudent =
      req.user.role === "student"
        ? req.user
        : req.body.studentId
          ? db
              .prepare(
                "SELECT * FROM users WHERE id=? AND school_id=? AND role='student'",
              )
              .get(req.body.studentId, req.user.school_id)
          : null;
    if (req.user.role === "teacher" && req.body.studentId && !linkedStudent)
      return res.status(400).json({ error: "学生账户不存在或不属于本校" });
    if (
      linkedStudent &&
      (linkedStudent.stage !== a.stage ||
        linkedStudent.class_name !== a.class_name)
    )
      return res.status(400).json({ error: "学生不属于作业班级" });
    if (!req.files?.length)
      return res.status(400).json({ error: "请选择支持的作业文件" });
    const id = uid();
    const saved = [];
    db.exec("BEGIN");
    try {
      const attachments = req.files.map((file, index) => ({
        file,
        target: path.join(files, `${uid()}${file.safeExtension}`),
        index,
      }));
      db.prepare(
        "INSERT INTO submissions(id,assignment_id,student_id,student_name,file_path,file_type,status,created_at) VALUES(?,?,?,?,?,?,?,?)",
      ).run(
        id,
        a.id,
        linkedStudent?.id || null,
        linkedStudent?.name || req.body.studentName || req.user.name,
        attachments[0].target,
        attachments[0].file.mimetype,
        "uploaded",
        iso(),
      );
      const insertFile = db.prepare(
        "INSERT INTO submission_files VALUES(?,?,?,?,?,?)",
      );
      for (const { file, target, index } of attachments) {
        fs.renameSync(file.path, target);
        saved.push(target);
        insertFile.run(
          uid(),
          id,
          index,
          target,
          file.mimetype,
          file.originalname,
        );
      }
      db.exec("COMMIT");
      res.json([
        { id, name: req.files[0].originalname, fileCount: attachments.length },
      ]);
    } catch (error) {
      db.exec("ROLLBACK");
      saved.forEach((file) => fs.rmSync(file, { force: true }));
      throw error;
    }
  },
);
app.get("/api/submissions", auth, teacher, (req, res) =>
  res.json(
    db
      .prepare(
        "SELECT s.id,s.student_name,s.status,s.teacher_reviewed,s.score,s.created_at,a.title assignment_title,a.grading_mode,a.description assignment_description FROM submissions s JOIN assignments a ON a.id=s.assignment_id WHERE a.teacher_id=? ORDER BY s.created_at DESC",
      )
      .all(req.user.id),
  ),
);
function assignmentForSubmission(submission) {
  return db
    .prepare("SELECT * FROM assignments WHERE id=?")
    .get(submission.assignment_id);
}
function questionsForAssignment(assignmentId) {
  return db
    .prepare(
      "SELECT q.*,k.title knowledge_title FROM questions q LEFT JOIN knowledge k ON k.id=q.knowledge_id WHERE q.assignment_id=? ORDER BY q.number",
    )
    .all(assignmentId);
}
// Direct-grading submissions carry their own AI-derived question list; the
// review UI and mistake records use the same shape as question-bank assignments.
function questionsForSubmission(submission, assignment) {
  if (assignment?.grading_mode === "direct" && submission.questions_json) {
    const parsed = safeParse(submission.questions_json, []);
    if (Array.isArray(parsed) && parsed.length)
      return parsed.map((question, index) => ({
        id: String(question.id || `dq${question.number || index + 1}`),
        number: Number(question.number) || index + 1,
        prompt: String(question.prompt || ""),
        standard_answer: String(
          question.standardAnswer ?? question.standard_answer ?? "",
        ),
        knowledge_id: question.knowledgeId || question.knowledge_id || null,
        score: Number(question.score) || 0,
        knowledge_title: String(
          question.knowledgeTitle ?? question.knowledge_title ?? "",
        ),
      }));
  }
  return questionsForAssignment(submission.assignment_id);
}
function submissionWithAssignment(req) {
  const submission = submissionFor(req);
  if (!submission) return null;
  const assignment = assignmentForSubmission(submission);
  if (!assignment) return null;
  return { submission, assignment };
}
app.get("/api/submissions/:id", auth, (req, res) => {
  const found = submissionWithAssignment(req);
  if (!found) return res.status(404).json({ error: "提交不存在" });
  const { submission: s, assignment } = found;
  const student = req.user.role === "student";
  const visible = !student || s.teacher_reviewed;
  const parsed =
    visible && s.analysis_json ? safeParse(s.analysis_json, null) : null;
  const questions = questionsForSubmission(s, assignment);
  let analysis = student ? studentAnalysis(parsed) : parsed;
  if (!student && analysis?.items)
    analysis = {
      ...analysis,
      items: annotateReviewItems(analysis.items, questions),
    };
  res.json({
    ...s,
    file_path: undefined,
    assignment_title: assignment.title,
    assignment_description: assignment.description || "",
    grading_mode: assignment.grading_mode || "bank",
    review_mode: req.user.review_mode || "all",
    files: submissionFiles(s).map((file) => ({
      name: file.original_name,
      mimeType: file.file_type,
      url: `/uploads/${encodeURIComponent(path.basename(file.file_path))}`,
    })),
    questions: questions.map((question) => {
      const visibleQuestion = {
        id: question.id,
        number: question.number,
        prompt: question.prompt,
        score: question.score,
        knowledge_id: question.knowledge_id,
      };
      return student
        ? visibleQuestion
        : { ...visibleQuestion, standard_answer: question.standard_answer };
    }),
    analysis_json: analysis ? JSON.stringify(analysis) : null,
    ocr_text: visible ? s.ocr_text : null,
    analysis,
    recognitionJob: student
      ? undefined
      : publicJob(
          db
            .prepare(
              "SELECT * FROM recognition_jobs WHERE submission_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
            )
            .get(s.id),
        ),
  });
});
function auditReview(submission, actorId, action, after) {
  const assignment = db
    .prepare("SELECT school_id FROM assignments WHERE id=?")
    .get(submission.assignment_id);
  const summary = (row) => ({
    status: row.status,
    reviewed: row.teacher_reviewed,
    score: row.score,
  });
  db.prepare("INSERT INTO review_audit VALUES(?,?,?,?,?,?,?,?)").run(
    uid(),
    submission.id,
    assignment.school_id,
    actorId,
    action,
    JSON.stringify(summary(submission)),
    JSON.stringify(after),
    iso(),
  );
}

const bankRecognitionPrompt = (submission, questions, documentText) =>
  `学校作业 OCR、自动批改与个性化练习。学段=${submission.stage}，学科=${submission.subject}，作业=${submission.title}。\n教师已经录入的正式题目=${JSON.stringify(questions)}。\n${documentText ? `答卷文字（按附件顺序）：\n${documentText}\n` : "学生答卷页面已附在消息中。"}\n规则：1. 忠实识别学生实际填写内容；2. 只能按 questionId 对齐正式题目；3. 无法辨认写[无法辨认]且 confidence 低于0.5；4. 自动判断正误和得分；5. 错题必须生成分步解析、错误原因、订正答案，以及2道同知识点同题型但数值或情境不同的练习题；6. 每个正式题目恰好返回一项；7. 每题必须给出 reasoning：说明判分依据（对照参考答案/评分要点的哪一部分、为什么判对或判错），不能只写“答案错误”；8. 错题给出 guidance：keyQuestion 是引导学生思考的关键问题（不能包含最终答案），hints 是 3 条递进提示（尽量不直接给最终答案），selfCheck 是 2-3 个自检问题。\n只返回 JSON：{"ocrText":"完整识别原文","items":[{"questionId":"题目id","knowledgeId":"知识点id","studentAnswer":"学生答案","isCorrect":false,"score":0,"reason":"错误原因","correction":"正确答案","explanation":"分步题目解析","reasoning":"AI 判断逻辑","confidence":0.0,"practiceQuestions":[{"prompt":"同类题","answer":"答案","explanation":"解析"}],"guidance":{"keyQuestion":"引导问题","hints":["提示1","提示2","提示3"],"selfCheck":["自检1"]}}]}`;

// Tolerant normalization of bank-mode AI output. A structurally valid but
// imperfect reply is still shown to the teacher for review instead of losing
// the whole OCR result; only a completely unusable reply fails the job.
function normalizeAiReviewItems(questions, rawItems) {
  const byId = new Map(
    (Array.isArray(rawItems) ? rawItems : [])
      .filter((item) => item && typeof item.questionId === "string")
      .map((item) => [item.questionId, item]),
  );
  let complete = true;
  const items = questions.map((question) => {
    const raw = byId.get(question.id);
    const max = Number(question.score) || 0;
    if (!raw) complete = false;
    const scoreValue = Number(raw?.score);
    const isCorrect = raw?.isCorrect === true;
    const score = Number.isFinite(scoreValue)
      ? Math.max(0, Math.min(max, scoreValue))
      : isCorrect
        ? max
        : 0;
    return {
      questionId: question.id,
      studentAnswer: String(raw?.studentAnswer ?? (raw ? "" : "[无法辨认]")),
      correction: String(raw?.correction || ""),
      explanation: String(raw?.explanation || raw?.correction || ""),
      reason: String(raw?.reason || ""),
      reasoning: String(raw?.reasoning || ""),
      confidence: Number.isFinite(Number(raw?.confidence))
        ? Math.max(0, Math.min(1, Number(raw.confidence)))
        : -1,
      isCorrect,
      score:
        isCorrect && max > 0
          ? max
          : !isCorrect && max > 0 && score === max
            ? max - 0.5 > 0
              ? max - 0.5
              : 0
            : score,
      practiceQuestions: Array.isArray(raw?.practiceQuestions)
        ? raw.practiceQuestions.slice(0, 5)
        : [],
      guidance:
        raw?.guidance && typeof raw.guidance === "object"
          ? raw.guidance
          : undefined,
    };
  });
  return {
    items,
    complete,
    score:
      Math.round(items.reduce((sum, item) => sum + item.score, 0) * 1e8) / 1e8,
  };
}

async function recognizeSubmission(
  submission,
  user,
  signal,
  assertLease = () => {},
  reservation = null,
) {
  const assignment = assignmentForSubmission(submission);
  if (!assignment) throw new Error("作业不存在");
  // Tiled uploads supply pre-cut regions; legacy uploads are read as pages.
  const tiles = db
    .prepare(
      "SELECT * FROM submission_tiles WHERE submission_id=? ORDER BY position",
    )
    .all(submission.id);
  const { images, documentText } = tiles.length
    ? {
        images: tiles.map((tile) => ({
          filePath: tile.file_path,
          mimeType: tile.file_type,
          page: tile.page_no,
          x: tile.x,
          y: tile.y,
          width: tile.width,
          height: tile.height,
        })),
        documentText: "",
      }
    : await recognitionFiles(submissionFiles(submission), signal, {
        admission: () => pressure.assertParser(),
      });
  assertLease();
  if (assignment.grading_mode === "direct") {
    const prompt = buildDirectGradingPrompt({
      assignment,
      userId: user.id,
      documentText,
      imageCount: images.length,
    });
    const parsed = await callModel(user, prompt, images, signal, reservation);
    return { kind: "direct", assignment, parsed, documentText };
  }
  const qs = questionsForAssignment(submission.assignment_id);
  const prompt = bankRecognitionPrompt(
    {
      stage: assignment.stage,
      subject: assignment.subject,
      title: assignment.title,
    },
    qs,
    documentText,
  );
  const parsed = await callModel(user, prompt, images, signal, reservation);
  if (tiles.length) {
    const returnedIds = new Set(
      Array.isArray(parsed?.items)
        ? parsed.items.map((item) => item?.questionId)
        : [],
    );
    if (
      !Array.isArray(parsed?.items) ||
      parsed.items.length !== qs.length ||
      returnedIds.size !== qs.length ||
      qs.some((q) => !returnedIds.has(q.id))
    )
      throw new Error("切片识别题号缺失或重复，请重新识别或由教师检查原件");
  }
  return { kind: "bank", assignment, parsed, questions: qs, documentText };
}

// Turn raw model output into the durable shape stored in submissions and used
// by commitReview. Throws only when the model output is unusable.
function prepareRecognition(user, result) {
  const assignment = result.assignment;
  if (result.kind === "direct") {
    const normalized = normalizeDirectGrading(result.parsed);
    const questions = linkQuestions(ctx, {
      assignment,
      questions: normalized.questions,
      teacherId: user.id,
    });
    let reviewed;
    try {
      reviewed = normalizeDirectReview(normalized.items, questions);
    } catch (error) {
      throw Object.assign(new Error("模型返回的批改结果格式无效，请重新识别"), {
        status: 502,
      });
    }
    const analysis = {
      ocrText: normalized.ocrText,
      warnings: normalized.warnings,
      items: reviewed.items,
      score: reviewed.score,
      scoreTotal: questions.reduce(
        (sum, question) => sum + (Number(question.score) || 0),
        0,
      ),
      // Parents read the per-submission question snapshot from the analysis
      // payload; keep it there as well as in submissions.questions_json.
      questions: questions.map((question) => ({
        id: question.id,
        number: question.number,
        prompt: question.prompt,
        standardAnswer: question.standardAnswer,
        score: question.score,
        knowledgeId: question.knowledgeId || null,
        knowledgeTitle: question.knowledgeTitle || "",
      })),
      direct: true,
    };
    return {
      kind: "direct",
      assignment,
      questions,
      analysis,
      ocrText: normalized.ocrText,
      questionsJson: JSON.stringify(questions),
      complete: true,
      score: reviewed.score,
    };
  }
  const normalized = normalizeAiReviewItems(
    result.questions,
    result.parsed?.items,
  );
  const analysis = {
    ...result.parsed,
    items: normalized.items,
    score: normalized.score,
    scoreTotal: result.questions.reduce(
      (sum, question) => sum + (Number(question.score) || 0),
      0,
    ),
  };
  return {
    kind: "bank",
    assignment,
    questions: result.questions,
    analysis,
    ocrText: String(result.parsed?.ocrText || ""),
    questionsJson: null,
    complete: normalized.complete,
    score: normalized.score,
  };
}

function submissionForJob(job) {
  return db
    .prepare(
      "SELECT s.*,a.teacher_id FROM submissions s JOIN assignments a ON a.id=s.assignment_id WHERE s.id=?",
    )
    .get(job.submission_id);
}

function persistRecognition(job, prepared) {
  db.prepare(
    "UPDATE submissions SET status='review',teacher_reviewed=0,score=NULL,ocr_text=?,analysis_json=?,questions_json=? WHERE id=?",
  ).run(
    prepared.ocrText || "",
    JSON.stringify(prepared.analysis),
    prepared.questionsJson,
    job.submission_id,
  );
  db.prepare(
    "UPDATE recognition_jobs SET status='succeeded',token=NULL,lease_until=NULL,error=NULL,error_status=NULL,updated_at=? WHERE id=?",
  ).run(Date.now(), job.id);
}

// "不复核" mode: publish the AI verdict immediately. If the reply was not
// structurally complete we deliberately leave the submission in review so a
// human still sees it; nothing is silently dropped.
function autoReviewAfterRecognition(job, prepared) {
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(job.user_id);
  if (!user || user.review_mode !== "none" || !prepared.complete) return;
  const submission = submissionForJob(job);
  if (!submission) return;
  try {
    const outcome = commitReview(ctx, {
      submission,
      assignment: prepared.assignment,
      questions: prepared.questions,
      items: prepared.analysis.items,
      actorId: user.id,
      reviewMode: "none",
      auto: true,
    });
    db.prepare("UPDATE submissions SET analysis_json=? WHERE id=?").run(
      JSON.stringify({
        ...prepared.analysis,
        items: outcome.items || prepared.analysis.items,
        score: outcome.score,
      }),
      submission.id,
    );
  } catch (error) {
    // Keep the AI grading for teacher review rather than failing the job.
    db.prepare(
      "UPDATE submissions SET status='review',teacher_reviewed=0 WHERE id=?",
    ).run(submission.id);
    console.error("auto review skipped:", error.message);
  }
}

const recognitionJobs = new Set();
const recognitionQueue = createRecognitionQueue(
  db,
  async (job, { signal, assertLease }) => {
    const submission = db
      .prepare(
        "SELECT s.*,a.teacher_id FROM submissions s JOIN assignments a ON a.id=s.assignment_id WHERE s.id=? AND a.teacher_id=?",
      )
      .get(job.submission_id, job.user_id);
    if (!submission) throw new Error("提交不存在");
    const user = db.prepare("SELECT * FROM users WHERE id=?").get(job.user_id);
    if (!user) throw new Error("账户不存在");
    assertModelConfigured(user);
    assertLease();
    const reservation = reserveModel(user.id);
    try {
      db.prepare("UPDATE submissions SET status='recognizing' WHERE id=?").run(
        submission.id,
      );
      const result = await recognizeSubmission(
        submission,
        user,
        signal,
        assertLease,
        reservation,
      );
      return prepareRecognition(user, result);
    } finally {
      reservation();
    }
  },
  {
    canStart: () => pressure.limit(1) > 0,
    availableConcurrency: () => pressure.limit(runtimeProfile().ocrConcurrency),
    publish(job, prepared) {
      persistRecognition(job, prepared);
    },
    afterPublish(job, prepared) {
      autoReviewAfterRecognition(job, prepared);
    },
  },
);
app.post("/api/submissions/:id/recognition-jobs", auth, teacher, (req, res) => {
  const submission = db
    .prepare(
      "SELECT s.* FROM submissions s JOIN assignments a ON a.id=s.assignment_id WHERE s.id=? AND a.teacher_id=?",
    )
    .get(req.params.id, req.user.id);
  if (!submission) return res.status(404).json({ error: "提交不存在" });
  if (recognitionJobs.has(submission.id))
    return res.status(409).json({ error: "识别正在进行中" });
  try {
    assertModelConfigured(req.user);
    const job = recognitionQueue.enqueue(submission, req.user);
    res.status(202).json(publicJob(job));
  } catch (e) {
    if ([429, 503].includes(modelErrorStatus(e))) res.set("Retry-After", "5");
    res.status(modelErrorStatus(e)).json({ error: e.message });
  }
});
app.get(
  "/api/submissions/:id/review-history",
  auth,
  schoolStaff,
  (req, res) => {
    const submission = submissionFor(req);
    if (!submission) return res.status(404).json({ error: "提交不存在" });
    res.json(
      db
        .prepare(
          "SELECT id,actor_id,action,before_json,after_json,created_at FROM review_audit WHERE submission_id=? ORDER BY created_at DESC,id DESC LIMIT 100",
        )
        .all(submission.id),
    );
  },
);
app.get("/api/operations", auth, schoolAdmin, (req, res) => {
  const jobs = db
    .prepare(
      "SELECT status,COUNT(*) count,MIN(created_at) oldest FROM recognition_jobs WHERE school_id=? GROUP BY status",
    )
    .all(req.user.school_id);
  const time = Date.now();
  const usage = db
    .prepare(
      `SELECT COUNT(*) callsLastDay,
    COALESCE(SUM(created_at>?),0) callsLastHour,
    COALESCE(SUM(finished_at IS NULL AND lease_until>?),0) active
    FROM model_usage WHERE school_id=? AND created_at>?`,
    )
    .get(time - 3600000, time, req.user.school_id, time - 86400000);
  res.json({
    jobs,
    modelUsage: usage,
    uptimeSeconds: Math.floor(process.uptime()),
    requestsLast15Minutes: requestMetrics.snapshot(req.user.school_id),
    costBudget: costBudget.summary(req.user.school_id),
    resources: pressure.snapshot(),
    passwordWork: passwords.snapshot(),
    statementCache: statements.snapshot(),
    modelImages: modelImages.snapshot(),
    runtime: runtimeProfile(),
  });
});
// Synchronous legacy endpoint kept for older clients; it shares the queue's
// recognition and persistence helpers so behaviour cannot drift.
app.post("/api/submissions/:id/recognize", auth, teacher, async (req, res) => {
  const s = db
    .prepare(
      "SELECT s.*,a.teacher_id FROM submissions s JOIN assignments a ON a.id=s.assignment_id WHERE s.id=? AND a.teacher_id=?",
    )
    .get(req.params.id, req.user.id);
  if (!s) return res.status(404).json({ error: "提交不存在" });
  if (recognitionJobs.has(s.id) || recognitionQueue.active(s.id))
    return res.status(409).json({ error: "识别正在进行中" });
  recognitionJobs.add(s.id);
  let started = false;
  let reservation;
  const job = {
    id: `sync-${s.id}`,
    submission_id: s.id,
    user_id: req.user.id,
  };
  try {
    assertModelConfigured(req.user);
    reservation = reserveModel(req.user.id);
    db.prepare(
      "UPDATE submissions SET status='recognizing',teacher_reviewed=0,score=NULL WHERE id=?",
    ).run(s.id);
    auditReview(s, req.user.id, "recognition_requested", {
      status: "recognizing",
      reviewed: 0,
      score: null,
    });
    started = true;
    const result = await recognizeSubmission(
      s,
      req.user,
      requestSignal(),
      () => {},
      reservation,
    );
    const prepared = prepareRecognition(req.user, result);
    persistRecognition(job, prepared);
    autoReviewAfterRecognition(job, prepared);
    res.json(prepared.analysis);
  } catch (e) {
    if (started) {
      if (e.code === "MODEL_QUOTA")
        db.prepare(
          "UPDATE submissions SET status=?,teacher_reviewed=?,score=? WHERE id=?",
        ).run(s.status, s.teacher_reviewed, s.score, s.id);
      else
        db.prepare("UPDATE submissions SET status='failed' WHERE id=?").run(
          s.id,
        );
    }
    res.status(modelErrorStatus(e)).json({ error: String(e.message || e) });
  } finally {
    reservation?.();
    recognitionJobs.delete(s.id);
  }
});
app.post("/api/submissions/:id/review", auth, teacher, (req, res) => {
  const s = db
    .prepare(
      "SELECT s.*,a.teacher_id FROM submissions s JOIN assignments a ON a.id=s.assignment_id WHERE s.id=? AND a.teacher_id=?",
    )
    .get(req.params.id, req.user.id);
  if (!s) return res.status(404).json({ error: "提交不存在" });
  if (recognitionJobs.has(s.id) || recognitionQueue.active(s.id))
    return res.status(409).json({ error: "请等待识别完成后再复核" });
  const assignment = assignmentForSubmission(s);
  if (!assignment) return res.status(404).json({ error: "作业不存在" });
  const questions = questionsForSubmission(s, assignment);
  const isDirect = assignment.grading_mode === "direct";
  let reviewed;
  try {
    reviewed = (isDirect ? normalizeDirectReview : normalizeReview)(
      req.body.items,
      questions,
    );
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  const reviewMode = req.user.review_mode || "all";
  const modeError = assertReviewModeComplete(
    reviewMode,
    reviewed.items,
    questions,
  );
  if (modeError) return res.status(400).json({ error: modeError });
  try {
    const outcome = commitReview(ctx, {
      submission: s,
      assignment,
      questions,
      items: reviewed.items,
      actorId: req.user.id,
      reviewMode,
      auto: false,
    });
    const previous = safeParse(s.analysis_json, {});
    db.prepare("UPDATE submissions SET analysis_json=? WHERE id=?").run(
      JSON.stringify({
        ...previous,
        ...(req.body.ocrText ? { ocrText: req.body.ocrText } : {}),
        items: outcome.items || reviewed.items,
        score: outcome.score,
      }),
      s.id,
    );
    res.json({ ok: true, score: outcome.score });
  } catch (e) {
    res
      .status(storageStatus(e) || 400)
      .json({ error: e.message || "复核保存失败" });
  }
});
app.post("/api/papers/generate", auth, teacher, (req, res) => {
  const rows = db
    .prepare(
      "SELECT DISTINCT m.id,COALESCE(q.prompt,m.prompt) prompt,COALESCE(q.standard_answer,m.standard_answer) standard_answer,k.title knowledge_title FROM mistakes m LEFT JOIN questions q ON q.id=m.question_id JOIN submissions s ON s.id=m.submission_id JOIN assignments a ON a.id=s.assignment_id LEFT JOIN knowledge k ON k.id=m.knowledge_id WHERE a.teacher_id=? AND s.teacher_reviewed=1 AND COALESCE(q.prompt,m.prompt)<>'' ORDER BY RANDOM() LIMIT ?",
    )
    .all(
      req.user.id,
      Math.max(1, Math.min(Math.floor(Number(req.body.count)) || 10, 50)),
    );
  const id = uid(),
    rawTitle = req.body.title;
  if (
    rawTitle !== undefined &&
    (typeof rawTitle !== "string" || !rawTitle.trim() || rawTitle.length > 120)
  )
    return res.status(400).json({ error: "试卷名称无效" });
  const title = typeof rawTitle === "string" ? rawTitle.trim() : "错题巩固卷";
  // Store only whitelisted fields instead of the raw request body to prevent
  // unbounded payloads and latent injection when content is later rendered.
  db.prepare("INSERT INTO papers VALUES(?,?,?,?,?,?)").run(
    id,
    req.user.id,
    title,
    JSON.stringify({ title, count: rows.length }),
    JSON.stringify(rows),
    iso(),
  );
  res.json({ id, title, questions: rows });
});
app.get("/api/papers", auth, teacher, (req, res) =>
  res.json(
    db
      .prepare(
        "SELECT * FROM papers WHERE teacher_id=? ORDER BY created_at DESC",
      )
      .all(req.user.id)
      .map((x) => ({ ...x, content: JSON.parse(x.content_json) })),
  ),
);

/* ---------- v0.2.0 教学分析：把已复核错题换算成可讲评的课堂内容 ---------- */

function loadTeachingStats(assignmentId, userId) {
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(userId);
  const data = user?.is_school_admin
    ? loadAssignmentData(db, { schoolId: user.school_id, assignmentId })
    : loadAssignmentData(db, { teacherId: userId, assignmentId });
  if (!data) return null;
  return buildAssignmentStats(data);
}

function teachingRevision(assignmentId) {
  const assignment = db
    .prepare("SELECT school_id,stage,subject FROM assignments WHERE id=?")
    .get(assignmentId);
  if (!assignment) return "";
  const source = loadAssignmentData(db, {
    schoolId: assignment.school_id,
    assignmentId,
  });
  const labels = db
    .prepare(
      "SELECT id,title FROM knowledge WHERE school_id=? AND stage=? AND subject=? ORDER BY id",
    )
    .all(assignment.school_id, assignment.stage, assignment.subject);
  return createHash("sha256")
    .update(JSON.stringify({ source, labels }))
    .digest("hex");
}

function ensureTeachingRevision(assignmentId, revision) {
  if (teachingRevision(assignmentId) !== revision)
    throw Object.assign(new Error("复核数据已变化，请刷新后重新生成分析"), {
      status: 409,
    });
}

// Read statistics and their revision from the same SQLite snapshot. Never hold
// this transaction open across a provider request.
function loadTeachingSnapshot(assignmentId, userId) {
  db.exec("BEGIN");
  try {
    const stats = loadTeachingStats(assignmentId, userId);
    const revision = stats ? teachingRevision(assignmentId) : "";
    db.exec("COMMIT");
    return { stats, revision };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function saveTeachingAnalysis({
  assignmentId,
  scope,
  studentId,
  user,
  revision,
  content,
  stats,
}) {
  db.exec("BEGIN IMMEDIATE");
  try {
    ensureTeachingRevision(assignmentId, revision);
    const model =
      db
        .prepare("SELECT model FROM provider_settings WHERE user_id=?")
        .get(user.id)?.model || "";
    const analysis = { id: uid(), model, created_at: iso(), content };
    db.prepare(
      "INSERT INTO teaching_analyses(id,assignment_id,scope,student_id,school_id,created_by,model,payload_json,stats_json,created_at,source_revision) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      analysis.id,
      assignmentId,
      scope,
      studentId,
      user.school_id,
      user.id,
      model,
      JSON.stringify(content),
      JSON.stringify(stats),
      analysis.created_at,
      revision,
    );
    db.exec("COMMIT");
    return analysis;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function latestAnalysis(assignmentId, scope, studentId, userId) {
  const row = db
    .prepare(
      `SELECT * FROM teaching_analyses
       WHERE assignment_id=? AND scope=? AND created_by=? AND source_revision=?
         AND ${studentId ? "student_id=?" : "student_id IS NULL"}
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(
      ...(studentId
        ? [
            assignmentId,
            scope,
            userId,
            teachingRevision(assignmentId),
            studentId,
          ]
        : [assignmentId, scope, userId, teachingRevision(assignmentId)]),
    );
  if (!row) return null;
  let content;
  try {
    content = teachingContent(safeParse(row.payload_json, null), scope);
  } catch {
    return null; // Legacy malformed model output must not crash the client.
  }
  return {
    id: row.id,
    model: row.model,
    created_at: row.created_at,
    content,
  };
}

function courseKnowledgeLabels(stats) {
  return db
    .prepare(
      "SELECT title FROM knowledge WHERE school_id=(SELECT school_id FROM assignments WHERE id=?) AND stage=? AND subject=? ORDER BY title",
    )
    .all(stats.assignment.id, stats.assignment.stage, stats.assignment.subject)
    .map((row) => row.title);
}

app.get("/api/teaching/assignments", auth, schoolStaff, (req, res) => {
  const rows = req.user.is_school_admin
    ? db
        .prepare(
          "SELECT a.*,u.name teacher_name,COUNT(q.id) question_count FROM assignments a LEFT JOIN questions q ON q.assignment_id=a.id LEFT JOIN users u ON u.id=a.teacher_id WHERE a.school_id=? AND a.grading_mode='bank' GROUP BY a.id ORDER BY a.created_at DESC",
        )
        .all(req.user.school_id)
    : db
        .prepare(
          "SELECT a.*,u.name teacher_name,COUNT(q.id) question_count FROM assignments a LEFT JOIN questions q ON q.assignment_id=a.id LEFT JOIN users u ON u.id=a.teacher_id WHERE a.teacher_id=? AND a.grading_mode='bank' GROUP BY a.id ORDER BY a.created_at DESC",
        )
        .all(req.user.id);
  const countMistakes = db.prepare(
    "SELECT COUNT(*) total FROM mistakes m JOIN submissions s ON s.id=m.submission_id WHERE s.assignment_id=?",
  );
  res.json(
    rows.map((row) => {
      const analysis = latestAnalysis(row.id, "class", null, req.user.id);
      return {
        ...row,
        mistake_count: countMistakes.get(row.id).total,
        analysis: analysis
          ? { created_at: analysis.created_at, model: analysis.model }
          : null,
      };
    }),
  );
});

app.get("/api/teaching/assignments/:id", auth, schoolStaff, (req, res) => {
  const stats = loadTeachingStats(req.params.id, req.user.id);
  if (!stats)
    return res.status(404).json({ error: "作业不存在或不属于你的账户" });
  res.json({
    stats,
    analysis: latestAnalysis(req.params.id, "class", null, req.user.id),
    focus: db
      .prepare(
        "SELECT student_id,level,note FROM student_focus WHERE assignment_id=?",
      )
      .all(req.params.id),
    history: db
      .prepare(
        "SELECT id,model,created_at FROM teaching_analyses WHERE assignment_id=? AND scope='class' AND created_by=? AND source_revision=? ORDER BY created_at DESC LIMIT 8",
      )
      .all(req.params.id, req.user.id, teachingRevision(req.params.id)),
  });
});

app.post(
  "/api/teaching/assignments/:id/analyze",
  auth,
  teachingAuthor,
  async (req, res) => {
    const { stats, revision } = loadTeachingSnapshot(
      req.params.id,
      req.user.id,
    );
    if (!stats)
      return res.status(404).json({ error: "作业不存在或不属于你的账户" });
    if (!stats.overview.mistakeCount)
      return res.status(400).json({
        error: "这份作业还没有已复核错题，先完成识别与复核再生成分析",
      });
    try {
      const payload = promptPayload(stats, {
        knowledgeLabels: courseKnowledgeLabels(stats),
      });
      const raw = await callModel(
        req.user,
        `你是该学段的一线教研组长，正在把一次真实作业的复核数据转写成教师可以直接拿去上课的讲评方案。学段=${stats.assignment.stage}，学科=${stats.assignment.subject}，班级=${stats.assignment.className}，作业名称=${stats.assignment.title}。
统计与错题数据（已由教师复核确认，请勿更改其中的数字、题号、知识点和错因结论）：${JSON.stringify(payload)}
写作要求：
1. 只使用给定数据，不得编造题目、学生、分数或比例；引用比例时使用数据中的原始数字；
2. 全部用课堂口语化中文，面向教师，可执行、可照读，不要空话套话；
3. 讲评建议必须给到“讲什么、怎么讲、讲多久、用什么方法”，能直接放进一节课；
4. 板书设计给出教师可以照着写的结构，而不是泛泛而谈；
5. 分层辅导要能对应到具体学生姓名或具体知识点；
6. 每个错因都要配一个课堂动作，让老师知道 5 分钟内怎么纠这个毛病；
7. 课后作业只针对本次出错的知识点，题量少而准。
只返回 JSON：{"brief":"两句话点出本次作业最要命的结论，包含具体比例或题号","keyFindings":[{"title":"结论标题","detail":"支撑这个结论的数据与判断","action":"教师下一步动作"}],"boardPlan":{"title":"讲评课主题","duration":"课时安排","goal":"本课目标","steps":[{"minutes":5,"title":"环节名称","teacher":"教师做什么","students":"学生做什么"}],"blackboard":["板书逐行内容"]},"questionReviews":[{"number":1,"knowledge":"知识点","whyWrong":"出错原因","explainToStudents":"讲给学生听的完整讲解","boardWork":"板书演示内容","quickCheck":"讲完立刻检查是否听懂的一个小问题","wrongStudents":["需要点名的学生"]}],"reasonInsights":[{"id":"错因id","label":"错因名称","diagnosis":"这个错因在本次作业里的真实表现","teachingMove":"课堂上一句话或一个动作怎么纠","followUp":"课后怎么巩固"}],"groups":[{"name":"分层名称","studentNames":["学生姓名"],"strategy":"这一层的辅导策略","materials":"需要准备的材料或题目"}],"homework":{"title":"作业名称","targets":["覆盖的知识点"],"items":[{"prompt":"题目","source":"来源题号","difficulty":"易/中/难","expectation":"期望学生达到的效果"}]},"teacherScript":"教师上课可以直接照读的讲评开场稿，150字以内"}`,
      );
      const content = teachingContent(raw, "class");
      const analysis = saveTeachingAnalysis({
        assignmentId: req.params.id,
        scope: "class",
        studentId: null,
        user: req.user,
        revision,
        content,
        stats: {
          overview: stats.overview,
          knowledgePoints: stats.knowledgePoints,
        },
      });
      res.json({ analysis, stats });
    } catch (error) {
      res
        .status(modelErrorStatus(error))
        .json({ error: error.message || "教学分析生成失败" });
    }
  },
);

app.post(
  "/api/teaching/assignments/:id/reasons",
  auth,
  teachingAuthor,
  async (req, res) => {
    const { stats, revision } = loadTeachingSnapshot(
      req.params.id,
      req.user.id,
    );
    if (!stats)
      return res.status(404).json({ error: "作业不存在或不属于你的账户" });
    if (!stats.overview.mistakeCount)
      return res.status(400).json({ error: "暂无已复核错题，无法归因" });
    try {
      const raw = await callModel(
        req.user,
        `你是学科教研员，请把下面这份作业的错题归因到统一的错因分类体系，便于教师做班级统计。学段=${stats.assignment.stage}，学科=${stats.assignment.subject}。
统一错因体系（id 只能取以下之一）：${JSON.stringify(reasonTypeCatalog)}。
错题明细（含有题号、知识点、教师复核后的错因文本）：${JSON.stringify(
          stats.highFrequencyQuestions.map((question) => ({
            number: question.number,
            knowledge: question.knowledgeTitle,
            reasons: question.reasons,
          })),
        )}
。
规则：1. 逐题给出最贴切的错因 id；2. 题号必须来自上面的明细，不要遗漏；3. 不要把“无法辨认”判成学生的知识性错误，这类题号可以不返回；4. 不编造不存在的题号；5. 只返回判断依据充分的题号，拿不准的题号不返回，系统会保留原来的关键词归因。
只返回 JSON：{"reasonTypes":[{"id":"错因id","questionNumbers":[1,2],"evidence":"判断依据"}]}`,
      );
      ensureTeachingRevision(req.params.id, revision);
      const distribution = mergeReasonTypes(
        stats.reasonDistribution,
        raw.reasonTypes,
      );
      res.json({ reasonDistribution: distribution });
    } catch (error) {
      res
        .status(modelErrorStatus(error))
        .json({ error: error.message || "错因归因失败" });
    }
  },
);

app.post(
  "/api/teaching/assignments/:id/students/:studentId/analyze",
  auth,
  teachingAuthor,
  async (req, res) => {
    const { stats, revision } = loadTeachingSnapshot(
      req.params.id,
      req.user.id,
    );
    if (!stats)
      return res.status(404).json({ error: "作业不存在或不属于你的账户" });
    const student = buildStudentStats(stats, req.params.studentId);
    if (!student || !student.student)
      return res
        .status(404)
        .json({ error: "这位学生在这份作业中没有已复核错题" });
    try {
      const payload = promptPayload(stats, { student: student.student });
      const raw = await callModel(
        req.user,
        `你是${stats.assignment.stage}${stats.assignment.subject}老师，正在给一位学生写作业后的个别化诊断，目的是让老师能在课堂上或课后直接照着帮这个学生补上漏洞，同时让学生自己看懂“我为什么错、下一步做什么”。学生=${student.student.name}，作业=${stats.assignment.title}。
该生的复核错题数据：${JSON.stringify(payload)}
要求：1. 只使用给定数据，不编造题目或分数；2. 指出知识漏洞时要说清是哪一个知识点、对应哪几题；3. 动作要具体到“今晚做什么、明天课堂做什么”；4. 语气对教师专业、对学生温和，不贴标签、不打击；5. 练习题要针对该生出错的知识点，给出参考答案要点。
只返回 JSON：{"brief":"一句话说清这位学生这次的核心问题","diagnosis":"结合题号与知识点的具体诊断，150字以内","weakKnowledge":[{"title":"知识点","questionNumbers":[1,2],"evidence":"判断依据","mastery":"掌握程度描述"}],"causes":[{"label":"错因名称","detail":"这位学生的具体表现","fix":"怎么改"}],"actions":[{"when":"时间点","what":"具体动作","who":"老师做/学生做","check":"怎么检验做到了"}],"practice":[{"prompt":"针对性练习题","knowledge":"知识点","answer":"参考答案要点","difficulty":"易/中/难"}],"encouragement":"给这位学生的一句正向反馈","parentNote":"可以发给家长的一段简短说明"}`,
      );
      const content = teachingContent(raw, "student");
      const analysis = saveTeachingAnalysis({
        assignmentId: req.params.id,
        scope: "student",
        studentId: student.student.studentId || `name:${student.student.name}`,
        user: req.user,
        revision,
        content,
        stats: {
          student: student.student,
          knowledgePoints: student.knowledgePoints,
        },
      });
      res.json({ analysis });
    } catch (error) {
      res
        .status(modelErrorStatus(error))
        .json({ error: error.message || "学生诊断生成失败" });
    }
  },
);

app.get(
  "/api/teaching/assignments/:id/students/:studentId",
  auth,
  schoolStaff,
  (req, res) => {
    const stats = loadTeachingStats(req.params.id, req.user.id);
    if (!stats)
      return res.status(404).json({ error: "作业不存在或不属于你的账户" });
    const student = buildStudentStats(stats, req.params.studentId);
    if (!student || !student.student)
      return res
        .status(404)
        .json({ error: "这位学生在这份作业中没有已复核错题" });
    res.json({
      ...student,
      analysis: latestAnalysis(
        req.params.id,
        "student",
        student.student.studentId || `name:${student.student.name}`,
        req.user.id,
      ),
    });
  },
);

app.put(
  "/api/teaching/assignments/:id/focus/:studentId",
  auth,
  teachingAuthor,
  (req, res) => {
    const assignment = db
      .prepare("SELECT id FROM assignments WHERE id=? AND teacher_id=?")
      .get(req.params.id, req.user.id);
    if (!assignment) return res.status(404).json({ error: "作业不存在" });
    const student = db
      .prepare(
        "SELECT id FROM users WHERE id=? AND school_id=? AND role='student' AND stage=(SELECT stage FROM assignments WHERE id=?) AND class_name=(SELECT class_name FROM assignments WHERE id=?)",
      )
      .get(
        req.params.studentId,
        req.user.school_id,
        req.params.id,
        req.params.id,
      );
    if (!student) return res.status(404).json({ error: "学生不属于作业班级" });
    const level = ["watch", "follow", "priority"].includes(req.body.level)
      ? req.body.level
      : "follow";
    const note = String(req.body.note || "").slice(0, 300);
    if (req.body.level === "none") {
      db.prepare(
        "DELETE FROM student_focus WHERE assignment_id=? AND student_id=?",
      ).run(req.params.id, req.params.studentId);
      return res.json({ ok: true, level: null });
    }
    db.prepare(
      "INSERT INTO student_focus(id,assignment_id,student_id,school_id,teacher_id,level,note,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(assignment_id,student_id) DO UPDATE SET level=excluded.level,note=excluded.note,updated_at=excluded.updated_at",
    ).run(
      uid(),
      req.params.id,
      req.params.studentId,
      req.user.school_id,
      req.user.id,
      level,
      note,
      iso(),
    );
    res.json({ ok: true, level, note });
  },
);

app.post(
  "/api/teaching/assignments/:id/mistakes-to-assignment",
  auth,
  teachingAuthor,
  (req, res) => {
    const stats = loadTeachingStats(req.params.id, req.user.id);
    if (!stats)
      return res.status(404).json({ error: "作业不存在或不属于你的账户" });
    const wanted = Array.isArray(req.body.numbers)
      ? req.body.numbers.map(Number)
      : [];
    const source = stats.highFrequencyQuestions.filter(
      (question) => !wanted.length || wanted.includes(question.number),
    );
    if (!source.length)
      return res.status(400).json({ error: "请选择要重新布置的错题" });
    const id = uid();
    const title = String(
      req.body.title ||
        `${stats.assignment.title} · 高频错题重练（${source.length}题）`,
    ).slice(0, 80);
    db.exec("BEGIN");
    try {
      db.prepare(
        "INSERT INTO assignments(id,school_id,teacher_id,title,stage,subject,class_name,due_at,status,created_at,description,grading_mode) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        id,
        req.user.school_id,
        req.user.id,
        title,
        stats.assignment.stage,
        stats.assignment.subject,
        stats.assignment.className,
        null,
        "published",
        iso(),
        "由 AI 教学分析的高频错题重新布置",
        "bank",
      );
      const insert = db.prepare("INSERT INTO questions VALUES(?,?,?,?,?,?,?)");
      source.forEach((question, index) =>
        insert.run(
          uid(),
          id,
          index + 1,
          question.prompt,
          question.standardAnswer || question.corrections[0] || "",
          question.knowledgeId || null,
          Number(question.score) || 0,
        ),
      );
      db.exec("COMMIT");
      res.json({
        id,
        title,
        questionCount: source.length,
        knowledgePoints: [
          ...new Set(source.map((question) => question.knowledgeTitle)),
        ],
      });
    } catch (error) {
      db.exec("ROLLBACK");
      res.status(400).json({ error: error.message || "重新布置失败" });
    }
  },
);
if (fs.existsSync(path.join(root, "dist"))) {
  app.use(express.static(path.join(root, "dist")));
  app.get("/{*path}", (_q, r) =>
    r.sendFile(path.join(root, "dist/index.html")),
  );
}
app.use((e, _q, r, next) => {
  if (r.headersSent) return next(e);
  if (r.destroyed) return;
  const databaseBusy =
    e.errcode === 5 ||
    e.errcode === 6 ||
    e.code === "SQLITE_BUSY" ||
    e.code === "SQLITE_LOCKED";
  const diskStatus = databaseBusy ? 503 : storageStatus(e);
  const status =
    diskStatus || (e.code === "LIMIT_FILE_SIZE" ? 413 : e.status || 400);
  if ([429, 503, 507].includes(status)) r.set("Retry-After", "5");
  r.status(status).json({
    error: databaseBusy
      ? "数据库繁忙，请稍后重试"
      : diskStatus
        ? "存储暂不可用，请稍后重试"
        : e.message || "请求失败",
  });
});
const port = Number(process.env.PORT || 8787);
// 默认只监听本机；部署脚本在内网/隧道模式下通过 HOST=0.0.0.0 放开监听。
const host = process.env.HOST || "127.0.0.1";
const shownHost = host === "0.0.0.0" ? "127.0.0.1" : host;
const server = createHttpServer(app);
server.listen(port, host, () =>
  console.log(
    `Smart Campus ${APP_VERSION}: http://${shownHost}:${port}${host === "0.0.0.0" ? "（已监听全部网卡，可供局域网访问）" : ""}`,
  ),
);

recognitionQueue.start();
installLifecycle(server, () => {
  cancelRequests();
  recognitionQueue.stop();
  deepseekFiles.stop();
  tiledUploads.stop();
  uploadStorage.stop();
  uploadAdmission.stop();
});
