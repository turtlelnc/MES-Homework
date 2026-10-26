PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS schools(id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN('teacher','student','parent')),
  name TEXT NOT NULL,
  username TEXT,
  email TEXT,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  stage TEXT CHECK(stage IN('小学','初中','高中')),
  subject TEXT,
  class_name TEXT,
  created_at TEXT NOT NULL,
  is_school_admin INTEGER NOT NULL DEFAULT 0,
  review_mode TEXT NOT NULL DEFAULT 'all' CHECK(review_mode IN('all','uncertain','none')),
  model_auth_mode TEXT NOT NULL DEFAULT 'api_key' CHECK(model_auth_mode IN('api_key','oauth')),
  oauth_provider TEXT,
  FOREIGN KEY(school_id) REFERENCES schools(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username) WHERE username IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_email_login ON users(email COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires_at TEXT NOT NULL,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS provider_settings(id TEXT PRIMARY KEY,user_id TEXT NOT NULL UNIQUE,provider TEXT NOT NULL,endpoint TEXT NOT NULL,model TEXT NOT NULL,encrypted_key TEXT NOT NULL,iv TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS knowledge(id TEXT PRIMARY KEY,school_id TEXT NOT NULL,stage TEXT NOT NULL,subject TEXT NOT NULL,title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',created_by TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS assignments(id TEXT PRIMARY KEY,school_id TEXT NOT NULL,teacher_id TEXT NOT NULL,title TEXT NOT NULL,stage TEXT NOT NULL,subject TEXT NOT NULL,class_name TEXT NOT NULL,due_at TEXT,status TEXT NOT NULL DEFAULT 'published',created_at TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',grading_mode TEXT NOT NULL DEFAULT 'bank' CHECK(grading_mode IN('bank','direct')));
CREATE TABLE IF NOT EXISTS questions(id TEXT PRIMARY KEY,assignment_id TEXT NOT NULL,number INTEGER NOT NULL,prompt TEXT NOT NULL,standard_answer TEXT NOT NULL,knowledge_id TEXT,score REAL NOT NULL DEFAULT 0,FOREIGN KEY(assignment_id) REFERENCES assignments(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS submissions(id TEXT PRIMARY KEY,assignment_id TEXT NOT NULL,student_id TEXT,student_name TEXT NOT NULL,file_path TEXT NOT NULL,file_type TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'uploaded',ocr_text TEXT,analysis_json TEXT,teacher_reviewed INTEGER NOT NULL DEFAULT 0,score REAL,created_at TEXT NOT NULL,questions_json TEXT);
-- mistakes carries a per-question snapshot so "direct grading" submissions
-- (no pre-uploaded question bank) can still produce durable mistake records.
CREATE TABLE IF NOT EXISTS mistakes(id TEXT PRIMARY KEY,submission_id TEXT NOT NULL,student_id TEXT,question_id TEXT,knowledge_id TEXT,reason TEXT NOT NULL,student_answer TEXT NOT NULL,correction TEXT NOT NULL,created_at TEXT NOT NULL,explanation TEXT NOT NULL DEFAULT '',practice_json TEXT,mastery INTEGER NOT NULL DEFAULT 0,question_number INTEGER,prompt TEXT NOT NULL DEFAULT '',standard_answer TEXT NOT NULL DEFAULT '',question_score REAL,reasoning TEXT NOT NULL DEFAULT '',guidance_json TEXT);
CREATE TABLE IF NOT EXISTS papers(id TEXT PRIMARY KEY,teacher_id TEXT NOT NULL,title TEXT NOT NULL,filters_json TEXT NOT NULL,content_json TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS teaching_analyses(id TEXT PRIMARY KEY,assignment_id TEXT NOT NULL,scope TEXT NOT NULL CHECK(scope IN('class','student')),student_id TEXT,school_id TEXT NOT NULL,created_by TEXT NOT NULL,model TEXT NOT NULL DEFAULT '',payload_json TEXT NOT NULL,stats_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL,source_revision TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS student_focus(id TEXT PRIMARY KEY,assignment_id TEXT NOT NULL,student_id TEXT NOT NULL,school_id TEXT NOT NULL,teacher_id TEXT NOT NULL,level TEXT NOT NULL DEFAULT 'follow',note TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL,UNIQUE(assignment_id,student_id));
CREATE INDEX IF NOT EXISTS idx_mistakes_submission ON mistakes(submission_id);
CREATE INDEX IF NOT EXISTS idx_questions_assignment ON questions(assignment_id);
CREATE INDEX IF NOT EXISTS idx_submissions_assignment ON submissions(assignment_id);
CREATE INDEX IF NOT EXISTS idx_analyses_assignment ON teaching_analyses(assignment_id,scope);

CREATE TABLE IF NOT EXISTS submission_files(id TEXT PRIMARY KEY,submission_id TEXT NOT NULL,position INTEGER NOT NULL,file_path TEXT NOT NULL UNIQUE,file_type TEXT NOT NULL,original_name TEXT NOT NULL,FOREIGN KEY(submission_id) REFERENCES submissions(id) ON DELETE CASCADE,UNIQUE(submission_id,position));
CREATE INDEX IF NOT EXISTS idx_submission_files_submission ON submission_files(submission_id,position);

CREATE TABLE IF NOT EXISTS model_usage(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,school_id TEXT NOT NULL,created_at INTEGER NOT NULL,finished_at INTEGER,lease_until INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_model_usage_school_time ON model_usage(school_id,created_at);

-- v0.2.1: school-wide credential routing mode + class head teacher mapping.
CREATE TABLE IF NOT EXISTS school_settings(school_id TEXT PRIMARY KEY,model_mode TEXT NOT NULL DEFAULT 'school' CHECK(model_mode IN('school','teacher_class','teacher_parent')),updated_at TEXT NOT NULL,FOREIGN KEY(school_id) REFERENCES schools(id));
CREATE TABLE IF NOT EXISTS class_teachers(id TEXT PRIMARY KEY,school_id TEXT NOT NULL,class_name TEXT NOT NULL,teacher_id TEXT NOT NULL,is_head INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,UNIQUE(school_id,class_name,teacher_id));
CREATE INDEX IF NOT EXISTS idx_class_teachers_class ON class_teachers(school_id,class_name,is_head);
CREATE INDEX IF NOT EXISTS idx_class_teachers_teacher ON class_teachers(teacher_id);

-- v0.2.1: parent accounts are linked to one or more students.
CREATE TABLE IF NOT EXISTS parent_students(id TEXT PRIMARY KEY,parent_id TEXT NOT NULL,student_id TEXT NOT NULL,school_id TEXT NOT NULL,relation TEXT NOT NULL DEFAULT '家长',created_at TEXT NOT NULL,UNIQUE(parent_id,student_id));
CREATE INDEX IF NOT EXISTS idx_parent_students_parent ON parent_students(parent_id);
CREATE INDEX IF NOT EXISTS idx_parent_students_student ON parent_students(student_id);
CREATE TABLE IF NOT EXISTS student_insights(id TEXT PRIMARY KEY,student_id TEXT NOT NULL,school_id TEXT NOT NULL,created_by TEXT NOT NULL,model TEXT NOT NULL DEFAULT '',payload_json TEXT NOT NULL,stats_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_student_insights_student ON student_insights(student_id,created_at DESC);

-- v0.2.1: OAuth model connections. Tokens are AES-256-GCM encrypted at rest.
-- v0.2.1-rc4: meta_json stores provider identity (chatgpt accountId/email,
-- workbuddy uid/enterpriseId/domain/region/nickname) and never tokens.
CREATE TABLE IF NOT EXISTS oauth_connections(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,provider TEXT NOT NULL,account_label TEXT NOT NULL DEFAULT '',encrypted_access TEXT NOT NULL,encrypted_refresh TEXT,iv TEXT NOT NULL,token_type TEXT NOT NULL DEFAULT 'Bearer',scope TEXT NOT NULL DEFAULT '',expires_at INTEGER,status TEXT NOT NULL DEFAULT 'active',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,meta_json TEXT NOT NULL DEFAULT '{}',UNIQUE(user_id,provider));
CREATE TABLE IF NOT EXISTS oauth_states(state TEXT PRIMARY KEY,user_id TEXT NOT NULL,provider TEXT NOT NULL,verifier TEXT NOT NULL,redirect TEXT NOT NULL DEFAULT '/',created_at INTEGER NOT NULL);

-- v0.2.1: guided mistake book progress (hints / retry attempts / reveal).
CREATE TABLE IF NOT EXISTS mistake_progress(mistake_id TEXT NOT NULL,student_id TEXT NOT NULL,hints_used INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,solved INTEGER NOT NULL DEFAULT 0,revealed INTEGER NOT NULL DEFAULT 0,last_feedback TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL,PRIMARY KEY(mistake_id,student_id));

-- Durable recognition queue. Payloads contain references, never uploaded data or keys.
CREATE TABLE IF NOT EXISTS recognition_jobs(
  id TEXT PRIMARY KEY, submission_id TEXT NOT NULL, user_id TEXT NOT NULL,
  school_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued'
    CHECK(status IN('queued','running','succeeded','failed')),
  attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL,
  lease_until INTEGER, token TEXT, error TEXT, error_status INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  FOREIGN KEY(submission_id) REFERENCES submissions(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_active_submission
  ON recognition_jobs(submission_id) WHERE status IN('queued','running');
CREATE INDEX IF NOT EXISTS idx_jobs_schedule ON recognition_jobs(status,available_at);
CREATE INDEX IF NOT EXISTS idx_jobs_school ON recognition_jobs(school_id,status);
CREATE TABLE IF NOT EXISTS review_audit(
  id TEXT PRIMARY KEY, submission_id TEXT NOT NULL, school_id TEXT NOT NULL,
  actor_id TEXT NOT NULL, action TEXT NOT NULL, before_json TEXT NOT NULL,
  after_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_audit_submission ON review_audit(submission_id,created_at);
CREATE INDEX IF NOT EXISTS idx_users_school ON users(school_id,role);
CREATE INDEX IF NOT EXISTS idx_assignments_teacher ON assignments(teacher_id,created_at);
CREATE INDEX IF NOT EXISTS idx_submissions_student ON submissions(student_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_model_usage_active ON model_usage(lease_until) WHERE finished_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_submission_history ON recognition_jobs(submission_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_submissions_file_path ON submissions(file_path);

-- Integer micro-CNY ledger. Uncertain/dispatched requests retain their reservation.
CREATE TABLE IF NOT EXISTS model_costs(
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, school_id TEXT NOT NULL,
 provider TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL,
 reserved INTEGER NOT NULL, charged INTEGER NOT NULL DEFAULT 0,
 input_bound INTEGER NOT NULL, output_bound INTEGER NOT NULL,
 input_rate INTEGER NOT NULL, output_rate INTEGER NOT NULL,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cost_school ON model_costs(school_id,created_at);
CREATE INDEX IF NOT EXISTS idx_cost_user ON model_costs(user_id,created_at);
CREATE TABLE IF NOT EXISTS upload_sessions(
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, school_id TEXT NOT NULL,
 assignment_id TEXT, student_id TEXT, status TEXT NOT NULL,
 plan_json TEXT NOT NULL, reserved_bytes INTEGER NOT NULL, actual_bytes INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, submission_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_upload_user ON upload_sessions(user_id,created_at);
CREATE INDEX IF NOT EXISTS idx_upload_school ON upload_sessions(school_id,created_at);
CREATE TABLE IF NOT EXISTS upload_parts(
 session_id TEXT NOT NULL,index_no INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'empty',
 file_path TEXT,bytes INTEGER,sha256 TEXT,mime TEXT,token TEXT,lease_until INTEGER,
 PRIMARY KEY(session_id,index_no),FOREIGN KEY(session_id) REFERENCES upload_sessions(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS submission_tiles(
 submission_id TEXT NOT NULL,position INTEGER NOT NULL,page_no INTEGER NOT NULL,
 x INTEGER NOT NULL,y INTEGER NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,
 file_path TEXT NOT NULL UNIQUE,file_type TEXT NOT NULL,
 PRIMARY KEY(submission_id,position),FOREIGN KEY(submission_id) REFERENCES submissions(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS provider_files(
 id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,credential_hash TEXT NOT NULL,
 encrypted_key TEXT NOT NULL,iv TEXT NOT NULL,remote_id TEXT,bytes INTEGER NOT NULL,
 status TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
 cleanup_after INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_provider_files_cleanup ON provider_files(status,cleanup_after);
CREATE TABLE IF NOT EXISTS model_cost_receipts(cost_id TEXT PRIMARY KEY,prompt_tokens INTEGER NOT NULL,completion_tokens INTEGER NOT NULL,recorded_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS model_cost_reconciliations(id TEXT PRIMARY KEY,cost_id TEXT NOT NULL,before_charge INTEGER NOT NULL,after_charge INTEGER NOT NULL,note TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS upload_attempts(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,school_id TEXT NOT NULL,bytes_reserved INTEGER NOT NULL,created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_upload_attempt_user ON upload_attempts(user_id,created_at);
CREATE INDEX IF NOT EXISTS idx_upload_attempt_school ON upload_attempts(school_id,created_at);
CREATE INDEX IF NOT EXISTS idx_upload_attempt_time ON upload_attempts(created_at);
CREATE INDEX IF NOT EXISTS idx_upload_session_expiry ON upload_sessions(status,expires_at);
CREATE TABLE IF NOT EXISTS recognition_sources(job_id TEXT PRIMARY KEY,snapshot_json TEXT NOT NULL,FOREIGN KEY(job_id) REFERENCES recognition_jobs(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS system_flags(key TEXT PRIMARY KEY,value TEXT NOT NULL);
-- Only immutable staging paths, registered before opening; never submission paths.
CREATE TABLE IF NOT EXISTS upload_temporary_files(file_path TEXT PRIMARY KEY,expires_at INTEGER NOT NULL);
