import { randomUUID } from "node:crypto";

// v0.2.1: school-wide model credential routing.
//
// A school chooses one of three modes (see MODEL_MODES). Each model call is
// made with the credential of a resolved "owner":
//   school         -> the school administrator for everyone (admin uses self)
//   teacher_class  -> teacher uses self; student/parent use the head teacher
//   teacher_parent -> teacher/parent use self; student uses the bound parent
// Every function receives the open database and only reads/writes rows scoped
// by school_id / user identity. Routes are registered by the Lead through
// registerModelAccessRoutes(app, ctx); pure helpers are unit-tested directly.

export const MODEL_MODES = [
  {
    id: "school",
    label: "全校统一模式",
    desc: "仅学校管理员配置 API Key / OAuth，全校教师、学生、家长统一使用学校凭证。",
  },
  {
    id: "teacher_class",
    label: "老师分开 + 班费模式",
    desc: "每位老师配置自己的凭证；学生与家长使用本班班主任的凭证。",
  },
  {
    id: "teacher_parent",
    label: "老师分开 + 家长单独模式",
    desc: "老师配置自己的凭证；家长配置自己与孩子的凭证，学生使用其绑定家长的凭证。",
  },
];

const MODEL_MODE_IDS = new Set(MODEL_MODES.map((mode) => mode.id));

export function normalizeModelMode(value) {
  const mode = typeof value === "string" ? value.trim() : "";
  if (!MODEL_MODE_IDS.has(mode)) throw new Error("模型调用模式无效");
  return mode;
}

function classNameOf(value) {
  const name = typeof value === "string" ? value.trim() : "";
  return name && name.length <= 64 ? name : "";
}

export function getSchoolModelMode(db, schoolId) {
  if (!schoolId) return "school";
  const row = db
    .prepare("SELECT model_mode FROM school_settings WHERE school_id=?")
    .get(schoolId);
  return row && MODEL_MODE_IDS.has(row.model_mode) ? row.model_mode : "school";
}

export function findHeadTeacher(db, schoolId, className) {
  const name = classNameOf(className);
  if (!schoolId || !name) return null;
  return (
    db
      .prepare(
        `SELECT u.* FROM class_teachers ct
         JOIN users u ON u.id=ct.teacher_id
         WHERE ct.school_id=? AND ct.class_name=? AND ct.is_head=1
           AND u.role='teacher'
         ORDER BY ct.created_at, u.name LIMIT 1`,
      )
      .get(schoolId, name) || null
  );
}

function findSchoolAdmin(db, schoolId) {
  if (!schoolId) return null;
  return (
    db
      .prepare(
        `SELECT * FROM users
         WHERE school_id=? AND role='teacher' AND is_school_admin=1
         ORDER BY created_at, id LIMIT 1`,
      )
      .get(schoolId) || null
  );
}

function findBoundParent(db, studentId) {
  if (!studentId) return null;
  return (
    db
      .prepare(
        `SELECT u.* FROM parent_students ps
         JOIN users u ON u.id=ps.parent_id
         WHERE ps.student_id=? AND u.role='parent'
         ORDER BY ps.created_at, ps.id LIMIT 1`,
      )
      .get(studentId) || null
  );
}

function findFirstChild(db, parentId) {
  if (!parentId) return null;
  return (
    db
      .prepare(
        `SELECT u.* FROM parent_students ps
         JOIN users u ON u.id=ps.student_id
         WHERE ps.parent_id=? AND u.role='student'
         ORDER BY ps.created_at, ps.id LIMIT 1`,
      )
      .get(parentId) || null
  );
}

function ownerResult(mode, owner, source, fallback) {
  return {
    mode,
    ownerId: owner ? owner.id : null,
    owner: owner || null,
    source,
    fallback: Boolean(fallback),
  };
}

/**
 * Resolve which user's credential (API Key / OAuth connection) serves `user`,
 * following the school's model mode and the role matrix from the spec.
 * A missing head teacher / parent falls back to the school administrator.
 */
export function resolveCredentialOwner(db, user) {
  if (!user) {
    return ownerResult("school", null, "school", false);
  }
  const mode = getSchoolModelMode(db, user.school_id);
  const isAdmin = Number(user.is_school_admin) === 1;
  if (isAdmin) return ownerResult(mode, user, "self", false);

  const admin = findSchoolAdmin(db, user.school_id);
  if (mode === "school") return ownerResult(mode, admin, "school", false);

  if (user.role === "teacher") return ownerResult(mode, user, "self", false);

  if (mode === "teacher_class") {
    const child = user.role === "parent" ? findFirstChild(db, user.id) : null;
    const classSource =
      user.role === "parent" ? child?.class_name : user.class_name;
    const head = findHeadTeacher(db, user.school_id, classSource);
    if (head) return ownerResult(mode, head, "head_teacher", false);
    return ownerResult(mode, admin, "school", true);
  }

  // teacher_parent
  if (user.role === "parent") return ownerResult(mode, user, "self", false);
  const parent = findBoundParent(db, user.id);
  if (parent) return ownerResult(mode, parent, "parent", false);
  const head = findHeadTeacher(db, user.school_id, user.class_name);
  if (head) return ownerResult(mode, head, "head_teacher", true);
  return ownerResult(mode, admin, "school", true);
}

/**
 * Whether `user` is allowed to store their own model credential in the current
 * mode. Students never can; teachers only when the school is split; parents
 * only in the "teacher + parent" mode; the school administrator always can.
 */
export function canConfigureOwnModel(db, user) {
  if (!user) return false;
  if (user.role === "student") return false;
  if (Number(user.is_school_admin) === 1) return true;
  const mode = getSchoolModelMode(db, user.school_id);
  if (mode === "school") return false;
  if (user.role === "teacher") return true;
  if (user.role === "parent") return mode === "teacher_parent";
  return false;
}

const SOURCE_LABELS = {
  school: "学校管理员",
  self: "本人",
  head_teacher: "班主任",
  parent: "家长",
};

export function modelConfigDeniedMessage(db, user) {
  if (!user) return "请先登录";
  if (user.role === "student") return "学生账户不能单独配置模型凭证";
  const mode = getSchoolModelMode(db, user.school_id);
  if (mode === "school")
    return "当前为全校统一模式，模型凭证由学校管理员统一配置，无需单独配置";
  if (user.role === "parent")
    return "当前为「老师分开 + 班费模式」，家长使用本班班主任的凭证，无需单独配置";
  if (user.role === "teacher") return "当前模式不允许教师单独配置模型凭证";
  return "当前账户不能配置模型凭证";
}

function fallbackHint(user, source) {
  if (source === "head_teacher")
    return "学生尚未绑定家长，已回退使用班主任凭证";
  if (source === "school") {
    if (user.role === "parent")
      return "尚未绑定孩子，已回退使用学校管理员凭证";
    if (user.role === "student")
      return "本班尚未指定班主任，已回退使用学校管理员凭证";
    return "已回退使用学校管理员凭证";
  }
  return "";
}

function oauthConnectionState(db, owner) {
  const rows = db
    .prepare(
      `SELECT provider, updated_at FROM oauth_connections
       WHERE user_id=? AND status='active' ORDER BY updated_at DESC`,
    )
    .all(owner.id);
  const wanted = owner.oauth_provider || null;
  const match = wanted ? rows.find((row) => row.provider === wanted) : rows[0];
  return {
    hasOAuth: Boolean(match),
    oauthProvider: match ? match.provider : null,
  };
}

/**
 * Front-end friendly description of the credential that serves `user`.
 * Never returns key/token material.
 */
export function describeModelAccess(db, user) {
  const route = resolveCredentialOwner(db, user);
  const { owner } = route;
  const apiKey = owner
    ? db
        .prepare(
          "SELECT provider, endpoint, model FROM provider_settings WHERE user_id=?",
        )
        .get(owner.id) || null
    : null;
  const oauth = owner ? oauthConnectionState(db, owner) : { hasOAuth: false };
  const authMode = owner?.model_auth_mode === "oauth" ? "oauth" : "api_key";
  const configured =
    authMode === "oauth"
      ? Boolean(owner?.oauth_provider) && oauth.hasOAuth
      : Boolean(apiKey);
  let hint = "";
  if (authMode === "oauth" && !configured) {
    hint = "OAuth 授权已失效，请重新连接或改用 API Key";
  } else if (!configured) {
    if (!owner) hint = "学校尚未创建学校管理员账户，暂时无法使用模型";
    else if (route.source === "self")
      hint = "请先配置 API Key 或完成 OAuth 授权";
    else
      hint = `当前使用${SOURCE_LABELS[route.source] || "其他账户"}的凭证，但该凭证尚未配置，请联系${SOURCE_LABELS[route.source] || "管理员"}配置`;
  } else if (route.fallback) {
    hint = fallbackHint(user, route.source);
  }
  return {
    mode: route.mode,
    ownerId: route.ownerId,
    ownerName: owner?.name || "",
    ownerRole: owner?.role || "",
    hasApiKey: Boolean(apiKey),
    hasOAuth: oauth.hasOAuth,
    authMode,
    provider:
      authMode === "oauth"
        ? oauth.oauthProvider || owner?.oauth_provider || null
        : apiKey?.provider || null,
    configured,
    hint,
    source: route.source,
    fallback: route.fallback,
  };
}

/** Convenience alias used by other server modules (see ctx.resolveModelRoute). */
export function resolveModelRoute(db, user) {
  return resolveCredentialOwner(db, user);
}

/**
 * Bound helpers for a specific database. This keeps the Lead's wiring short:
 *   const access = createModelAccess(db);
 *   ctx.resolveModelRoute = (user) => access.resolveModelRoute(user);
 */
export function createModelAccess(db) {
  return {
    getSchoolModelMode: (schoolId) => getSchoolModelMode(db, schoolId),
    resolveCredentialOwner: (user) => resolveCredentialOwner(db, user),
    resolveModelRoute: (user) => resolveCredentialOwner(db, user),
    describeModelAccess: (user) => describeModelAccess(db, user),
    canConfigureOwnModel: (user) => canConfigureOwnModel(db, user),
  };
}

/** Express middleware: 403 when the current mode/role may not store a credential. */
export function createModelConfigGuard(db) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "请先登录" });
    if (!canConfigureOwnModel(db, req.user))
      return res
        .status(403)
        .json({ error: modelConfigDeniedMessage(db, req.user) });
    next();
  };
}

export function listSchoolTeachers(db, schoolId) {
  return db
    .prepare(
      `SELECT id, name, subject, class_name FROM users
       WHERE school_id=? AND role='teacher' AND is_school_admin=0
       ORDER BY name`,
    )
    .all(schoolId);
}

/**
 * Classes known to a school, with head teacher and subject teachers, for the
 * school administrator's model-mode panel. Classes come from student rows,
 * class_teachers rows and teacher profile rows so legacy data is included.
 */
export function listSchoolClasses(db, schoolId) {
  const names = new Set();
  for (const row of db
    .prepare(
      `SELECT class_name, COUNT(*) total FROM users
       WHERE school_id=? AND role='student'
         AND class_name IS NOT NULL AND TRIM(class_name)<>''
       GROUP BY class_name`,
    )
    .all(schoolId))
    names.add(row.class_name);
  for (const row of db
    .prepare("SELECT DISTINCT class_name FROM class_teachers WHERE school_id=?")
    .all(schoolId))
    if (classNameOf(row.class_name)) names.add(classNameOf(row.class_name));
  for (const row of db
    .prepare(
      `SELECT DISTINCT class_name FROM users
       WHERE school_id=? AND role='teacher' AND is_school_admin=0
         AND class_name IS NOT NULL AND TRIM(class_name)<>''`,
    )
    .all(schoolId))
    if (classNameOf(row.class_name)) names.add(classNameOf(row.class_name));

  return [...names]
    .sort((left, right) => String(left).localeCompare(String(right), "zh-Hans"))
    .map((className) => {
      const studentCount = Number(
        db
          .prepare(
            `SELECT COUNT(*) total FROM users
             WHERE school_id=? AND role='student' AND class_name=?`,
          )
          .get(schoolId, className).total,
      );
      const head = findHeadTeacher(db, schoolId, className);
      const teachers = new Map();
      for (const row of db
        .prepare(
          `SELECT u.id, u.name, u.subject, ct.is_head FROM class_teachers ct
           JOIN users u ON u.id=ct.teacher_id
           WHERE ct.school_id=? AND ct.class_name=? AND u.role='teacher'
           ORDER BY u.name`,
        )
        .all(schoolId, className))
        teachers.set(row.id, row);
      for (const row of db
        .prepare(
          `SELECT id, name, subject FROM users
           WHERE school_id=? AND role='teacher' AND is_school_admin=0
             AND class_name=?`,
        )
        .all(schoolId, className))
        teachers.set(row.id, row);
      const subjectTeachers = [...teachers.values()]
        .filter((row) => !head || row.id !== head.id)
        .map((row) => ({ id: row.id, name: row.name, subject: row.subject }));
      return {
        className,
        studentCount,
        headTeacher: head ? { id: head.id, name: head.name } : null,
        subjectTeachers,
      };
    });
}

function setHeadTeacher(db, schoolId, className, teacherId) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      "UPDATE class_teachers SET is_head=0 WHERE school_id=? AND class_name=?",
    ).run(schoolId, className);
    if (teacherId) {
      db.prepare(
        `INSERT INTO class_teachers(id,school_id,class_name,teacher_id,is_head,created_at)
         VALUES(?,?,?,?,1,?)
         ON CONFLICT(school_id,class_name,teacher_id) DO UPDATE SET is_head=1`,
      ).run(
        randomUUID(),
        schoolId,
        className,
        teacherId,
        new Date().toISOString(),
      );
      db.prepare(
        "UPDATE users SET class_name=? WHERE id=? AND school_id=? AND role='teacher'",
      ).run(className, teacherId, schoolId);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function registerModelAccessRoutes(app, ctx) {
  const { db, auth, schoolAdmin } = ctx;

  app.get("/api/model/access", auth, (req, res) => {
    const access = describeModelAccess(db, req.user);
    res.json({
      ...access,
      modes: MODEL_MODES,
      canConfigure: canConfigureOwnModel(db, req.user),
      schoolMode: getSchoolModelMode(db, req.user.school_id),
    });
  });

  app.get("/api/school/model-mode", auth, schoolAdmin, (req, res) => {
    res.json({
      mode: getSchoolModelMode(db, req.user.school_id),
      modes: MODEL_MODES,
      classes: listSchoolClasses(db, req.user.school_id),
      teachers: listSchoolTeachers(db, req.user.school_id),
    });
  });

  app.put("/api/school/model-mode", auth, schoolAdmin, (req, res) => {
    let mode;
    try {
      mode = normalizeModelMode(req.body?.mode);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    db.prepare(
      `INSERT INTO school_settings(school_id,model_mode,updated_at)
       VALUES(?,?,?)
       ON CONFLICT(school_id) DO UPDATE SET
         model_mode=excluded.model_mode, updated_at=excluded.updated_at`,
    ).run(req.user.school_id, mode, new Date().toISOString());
    res.json({ ok: true, mode });
  });

  app.put(
    "/api/school/classes/:className/head-teacher",
    auth,
    schoolAdmin,
    (req, res) => {
      const className = classNameOf(req.params.className);
      if (!className) return res.status(400).json({ error: "班级名称无效" });
      const raw = req.body?.teacherId;
      const teacherId = raw === null || raw === undefined ? null : String(raw);
      if (teacherId) {
        const teacher = db
          .prepare(
            "SELECT id FROM users WHERE id=? AND school_id=? AND role='teacher'",
          )
          .get(teacherId, req.user.school_id);
        if (!teacher)
          return res.status(400).json({ error: "请选择同校教师担任班主任" });
      }
      try {
        setHeadTeacher(db, req.user.school_id, className, teacherId);
      } catch {
        return res.status(500).json({ error: "保存班主任失败，请重试" });
      }
      res.json({ ok: true, className, teacherId });
    },
  );
}
