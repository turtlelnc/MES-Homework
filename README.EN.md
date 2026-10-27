# Smart Campus Homework Analyzer · 校园作业分析

[![Version](https://img.shields.io/badge/version-v0.2.1--rc4-2ea44f?style=flat)](https://github.com/turtlelnc/MES-Homework/releases)
[![Build](https://img.shields.io/badge/build-26102501-0A84FF?style=flat)](https://github.com/turtlelnc/MES-Homework/releases)
[![Tests](https://img.shields.io/badge/tests-CI%20passing-brightgreen?style=flat&logo=githubactions&logoColor=white)](https://github.com/turtlelnc/MES-Homework/actions)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat)](LICENSE)
[![Security](https://img.shields.io/badge/security-P0%2FP1%20fixed-success?style=flat)](SECURITY_REVIEW.md)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey?style=flat)](tools/deployer/README.md)
[![Deployer](https://img.shields.io/badge/deployer-desktop%20GUI-0A84FF?style=flat)](tools/deployer/README.md)
[![Editions](https://img.shields.io/badge/editions-local%20%7C%20server-555555?style=flat)](tools/deployer/README.md)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-339933?style=flat&logo=nodedotjs&logoColor=white)](package.json)
[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

**v0.2.1-rc4** (build26102501) | MIT License

[中文](README.md) | English

Smart Campus Homework Analyzer: upload homework, AI grades it; teacher review turns it into class insight — mastery rates, error cause statistics, and lesson plans. All numbers come from reviewed data; AI only writes them up for class.

---

This is a full-stack version that can run on school or personal servers. Accounts, schools, students, knowledge bases, homework, OCR, teacher review, mistake notebooks, exam papers, parent dashboards, and AI teaching analysis all use persistent data.

## What's New in v0.2.1 (since v0.2.1-rc1)

1. **Three teacher-selectable review modes**: review every question, review only uncertain items (high-confidence AI verdicts pass automatically), or no review (AI result is published immediately; incomplete model output still falls back to human review).
2. **Explain the grade**: every graded item shows the result, the reference answer, and the AI's reasoning (why it was marked right/wrong). Visible in teacher review and the parent submission detail.
3. **OAuth model links alongside API Keys**: since v0.2.1-rc4 the OAuth login options are ChatGPT (Codex OAuth, browser callback + PKCE or device code), Gemini (Google OAuth + PKCE, configured with a Google Cloud OAuth client) and WorkBuddy (device-code/browser polling, CN or global region). Users simply approve in the browser — no API key to copy. Claude, Qwen, 千问 and DeepSeek (Platform) OAuth entries were removed; those vendors remain available through API keys. ChatGPT/WorkBuddy remain experimental compatibility adapters, without real-account acceptance of this app’s official third-party login. Tokens are AES-256-GCM encrypted, refreshed automatically and can be disconnected. See [docs/oauth-flows.md](docs/oauth-flows.md).
4. **Account-name registration with role selection**: school / teacher / student / parent, login by account name (legacy email logins still work). `ALLOW_PUBLIC_REGISTRATION=0` restores admin-only account creation.
5. **Parent portal**: dashboard of the linked child's reviewed homework, scores, weak knowledge points, error causes, trends and per-question grading detail, plus one-click AI learning analysis.
6. **School-managed model modes**: school-wide credentials, teacher-separate + class-fund (students/parents use the class head teacher's credential), or teacher-separate + parent-separate (students use their linked parent's credential).
7. **Grading without uploading the original questions**: create a "direct AI grading" homework with just a title and an optional content description; AI segments the student's work, derives reference answers, grades and explains.
8. **Guided mistake notebook**: students see a thinking prompt, progressive hints, and a redo box first; the reference answer is revealed only after they get it right (with a fallback after three attempts), followed by similar practice questions.

> Direct-grading homework uses per-submission AI question snapshots, so it does not feed the class-level AI teaching analysis (which aggregates a shared question bank). The parent learning analysis works for both modes.

### OAuth model configuration (deployment admin)

OAuth supports Authorization Code + PKCE and device-code flows; the UI shows "Browser login" / "Device code login" according to each provider's capabilities:

- **ChatGPT**: built-in public Codex PKCE client, no Client ID needed; browser login listens on `http://localhost:1455/auth/callback`, device login shows a one-time code for `https://auth.openai.com/codex/device`.
- **Gemini**: create a Google Cloud Web application OAuth client, register the exact callback URL shown in settings, enable the Generative Language API and set `OAUTH_GEMINI_CLIENT_ID` / `OAUTH_GEMINI_CLIENT_SECRET` / `OAUTH_GEMINI_PROJECT_ID` (scopes are listed in `.env.example`); otherwise the card shows "not configured".
- **WorkBuddy**: built-in official authorization flow with both **Browser login** (opens the authorization page) and **Device login** (shows the authorization link); both use the same official polling flow. `OAUTH_WORKBUDDY_REGION=cn|global` selects the region.

ChatGPT and Gemini are not available in mainland China; the UI warns before redirecting. The API Key path is unaffected. Full interface and security notes: [docs/oauth-flows.md](docs/oauth-flows.md).

![OAuth 登录界面](docs/screenshots-v0.2.1/oauth-settings.png)

## What's New in v0.2.0-rc1: AI Teaching Analysis

A new module for classroom review sessions that directly consumes teacher-reviewed mistakes and turns grading results into teachable content.

- **Class Learning Profile**: Number of reviewed submissions, class scoring rate, mistake counts and error cause breakdowns, with separate alerts for unrecognizable questions.
- **Knowledge Point Mastery Rates**: Aggregated by question number to school knowledge points, sorted from weakest first to highlight gaps to address in class.
- **Error Cause Attribution**: Built-in 12 error categories (concept confusion, misreading the question, careless calculation, missing steps, weak formula recall, omitted conditions, etc.). Keyword rules provide deterministic classification first; teachers can click "AI Re-attribution" for model-assisted review combining question stems and knowledge points. Error causes are strictly divided by question number, and percentages always sum to 100%.
- **High-Frequency Mistake Review Sheets**: Sorted by number of students who made each mistake. Expand to see affected students, reference answers, step-by-step solutions, similar practice problems, and AI-generated prompts for "explain to students / board demonstration / quick check after explanation."
- **Lesson Plan Generator**: Topic, duration, objectives, timeline (what to teach, what the teacher does, what students do), and ready-to-use board design.
- **Differentiated Intervention**: Each error cause comes with a 5-minute actionable classroom activity and a named list of students for targeted support.
- **Follow-Up Homework**: Targets only the knowledge points where mistakes occurred. One-click generation of new practice assignments from selected high-frequency mistakes.
- **Student Follow-Up List**: Tag students as "Observe / Follow Up / Priority." One-click generation of individualized diagnostics (weak knowledge points, error cause analysis, remediation actions, targeted exercises, and a note for parents).
- **Export**: One-click export of Markdown review sheets, or print directly as A4 handouts for class.

**Statistical Note**: Only mistakes confirmed by teachers in "Recognition & Review" enter statistics. Questions marked "Unrecognizable" are listed separately and excluded from student error cause percentages to prevent misjudgment due to poor scan quality.

-  Knowledge point mastery rate: Aggregate the school-based knowledge points by question number, sort them from the weakest, and directly point out the loopholes that need to be filled first in this lesson.
-   - Error attribution: Built-in 12 types of error causes (conceptual confusion, question review deviation, careless calculation, missing steps, poor memory of formulas, omission of conditions, etc.). First use keyword rules to categorically classify. The teacher can then click "AI Re-Attribution" to let the model combine the question stem and knowledge points to review; the error causes are strictly divided according to question numbers, and the sum of the proportions is always 100%.
    -  - Review sheets for frequently mistaken questions: Sort by the number of people who made mistakes, expand to see the students who made the mistakes, reference answers, step-by-step analysis, similar exercises, and the AI-generated "tell to students/demonstrate on the blackboard/check immediately after speaking".
       -  - Classroom lecture and evaluation lesson plan: theme, lesson time, goals, timeline (what to talk about, what the teacher does, what students do) and a blackboard design that can be copied and written on.
          -  - Hierarchical coaching and error cause intervention: Each error cause is assigned a classroom action that can be performed within 5 minutes, and a layered coaching list is given that can be directly named.
             - - After-class homework: Only for the knowledge points that were wrong this time, you can generate new re-practice homework for the selected frequently wrong questions with one click. - Student follow-up list: Mark "Observation/Follow-up/Key Points" to generate an individualized diagnosis of the student (weak knowledge points, analysis of error causes, reinforcement actions, targeted exercises, and an explanation for parents) with one click.
               - - Export: Export Markdown lecture notes with one click, or print them directly into A4 lecture notes and bring them to class.

## One-Click Deployment (desktop app, dependency-free)

![Desktop deployer](docs/screenshots-v0.2.1/deployer-welcome.png)

Starting with v0.2.1-rc4 the project ships a **C++ desktop deployer** (GLFW + Dear ImGui + miniz,
single file, no external runtime dependencies, Apple-style UI with light frosted glass). Pick
**Local** (run on this computer and open the browser) or **Server** (LAN/school server, optional
autostart and firewall rule); the wizard downloads the runtime, verifies SHA-256, extracts, writes
the configuration, starts or registers the service and waits for a health check.

Supported: Windows 10/11 (x64/x86/arm64), Debian/RHEL families and Kylin (x64/x86/arm64), and
macOS on Apple Silicon. The deployer does **not** require Node.js, npm, Git or the VC++ runtime to
be preinstalled: the app runtime bundle and Node binary are downloaded from the GitHub Release
(offline zip is also supported).

Download the single-file deployer for your platform from
[GitHub Releases](https://github.com/turtlelnc/MES-Homework/releases) tag `v0.2.1-rc4`
(e.g. `mes-deployer-windows-x64.exe`) and run it. To build from source:

```powershell
powershell -ExecutionPolicy Bypass -File tools/deployer/build.ps1
# output: dist-deployer/mes-deployer.exe
```

Linux/macOS build instructions, runtime bundle layout, offline install and security notes are in
[tools/deployer/README.md](tools/deployer/README.md).

## Local or Server Run

Requires Node.js 24+.

```powershell
npm install
$env:APP_SECRET="replace-with-at-least-32-char-random-string"
npm run build
npm start
```

For development, run `npm run dev:server` and `npm run dev` separately, then visit `http://127.0.0.1:5173`. Production server listens on `127.0.0.1:8787` by default; use `HOST=0.0.0.0` to allow LAN access. Data is stored in `data/smart-campus.sqlite`, with original files in `data/uploads/`.

## Security update (2026-10-25, v0.2.1-rc4)

Registration is now account-name + password + role selection; teachers/students/parents may self-register with a school code (requirement 4). Set `ALLOW_PUBLIC_REGISTRATION=0` to restore administrator-only account creation. A school code is not an identity credential: students cannot change their own stage/class, teachers only see their own assignments and school knowledge base, parents only see linked children, and every query stays scoped by school and account. Submission files and answers require the submitting student, owning teacher, linked parent, or school administrator; student assignment responses and the guided mistake notebook never expose reference answers directly; re-recognition requires fresh teacher approval (except when the selected review mode auto-completes).

OAuth model links use Authorization Code + PKCE (ChatGPT also supports device code / Codex OAuth; WorkBuddy uses an experimental compatibility browser-polling adapter), with one-time state validation. Tokens use the same AES-256-GCM encryption as API keys, are refreshed on expiry, and can be disconnected. The ChatGPT callback listens only on `127.0.0.1:1455` and authorization URLs are restricted to official domains. Redirects are restricted to `APP_ORIGIN`/`OAUTH_REDIRECT_BASE` with no open redirects. ChatGPT and Gemini are not available in mainland China; the UI warns explicitly before redirecting.

Model endpoints are restricted to the selected vendor's HTTPS origin. Deployment administrators may approve exact custom origins in comma-separated `PROVIDER_ALLOWED_ORIGINS`; existing stored endpoints are also checked on every call. Do not approve user-controlled domains or private-network addresses. Worker/reverse-proxy deployments must set `APP_ORIGIN=https://your-frontend-domain` on the API server, without a path or trailing slash. Client-supplied forwarding headers are not trusted. Production requires a valid `APP_SECRET` and HTTPS (Secure session cookies).

Environment variables must be passed to the process; start with `node --env-file=.env server/index.mjs` when using `.env`. See [SECURITY_REVIEW.md](SECURITY_REVIEW.md) for findings, regression coverage, and remaining limitations.

## Recommended Workflow

1. Register the school, then use "School Dashboard" to choose the model mode, assign class head teachers, and configure school credentials.
2. Teachers/students/parents register with the school code and account name (or the administrator creates accounts / imports students).
3. Parents bind a child from the "Child Dashboard" using the child's account name and password.
4. Maintain your school's actual knowledge points in "Knowledge Base."
5. In "New Homework", either upload originals to generate a question draft, or choose "Direct AI grading" with just a title and an optional description.
6. Choose the review mode, then have students upload answer sheets and start page-by-page OCR.
7. Review all questions or only uncertain ones, or let the system publish the AI result; the grade, reference answer and AI reasoning are shown together.
8. Confirmed mistakes enter the student notebook, where students think → get hints → redo → see the reference answer → practise similar questions.
9. Use "AI Teaching Analysis" for question-bank assignments, and the parent dashboard for AI learning analysis.

## Submission and grading fixes (2026-10-17)

Files selected in one upload now form a single student's answer sheet and are recognized in selection order. Do not mix different students in one upload. Startup adds the `submission_files` table automatically; legacy single-file submissions remain readable. Previously split submissions cannot be reliably regrouped and are left unchanged; re-upload complete answer sheets and review historical statistics where needed.

Review uses canonical question numbers, prompts, maximum points and editable scores; verdicts and scores stay consistent, and totals are calculated on the server. Switching students cannot mix recognition results, and malformed model output can be retried. Student practice APIs omit reference answers and require strict JSON boolean grades. Re-recognized mistakes are excluded from notebooks, practice and paper generation until approved again. Analytics retain perfect-score students and error-free knowledge points and isolate same-name accounts by ID.

## Testing & Verification

```powershell
npm test            # Vitest: error cause classification, class statistics, data isolation, AI attribution fusion
npm run build       # Strict TS checks + production build
npm run verify:teaching   # End-to-end verification of teaching analysis APIs (uses fixture data, no paid model calls)
```

`npm run verify:teaching` generates a fixture database under `.tmp-teaching-verify/` and starts a temporary port, verifying read/write interfaces, statistical standards, and permission boundaries item by item, then cleans up automatically. It only validates deterministic parts; AI generation endpoints return clear error messages when no API key is configured.

## Cloudflare Free Tier

Cloudflare Worker hosts only the static frontend and proxies `/api/*` to your origin server, without depending on D1 or R2. Start the main service on your server first, then use cloudflared to expose port 8787, and write the HTTPS origin URL to `ORIGIN_URL` in `wrangler.jsonc`.

```powershell
cloudflared tunnel --url http://127.0.0.1:8787
npm run build
npx wrangler deploy
```

## Pre-Launch Checklist

- Set up a fixed HTTPS domain, a strong random `APP_SECRET`, and daily offline backups.
- Add email verification, password recovery, and enrollment verification. Login rate limits currently use the source IP; users behind a reverse proxy may share a quota.
- Add virus scanning for uploaded files and define retention/deletion policies for originals, recognized text, and account data.
- Confirm minor data processing terms with OCR providers and evaluate recognition rates with real school samples.
- SQLite suits single-machine or single-writer setups; multi-node deployments require migration to an external database and object storage.

Model capabilities and API formats change over time. Current OCR uses OpenAI-compatible vision message format; providers incompatible with this format require a separate adapter.

## Directory Structure

| Directory | Description |
|-----------|-------------|
| `src/` | Frontend source (React + TypeScript) |
| `server/` | Backend server (Express + SQLite) |
| `public/` | Static assets |
| `tools/` | Deployment tools and scripts |
| `Roadshow PPT - 路演PPT/` | Roadshow deck and assets (Chinese and English PPTX / PDF / HTML sources) |

| Document | Description |
|----------|-------------|
| `README.md` / `README.EN.md` | Project overview (中文 / English) |
| `SAFETY.zh.md` / `SAFETY.md` | Safety statement and responsible use guidelines (中文 / English) |
| `AGENTS.md` | Repository collaboration and coding conventions |
| `Roadshow PPT - 路演PPT/README.md` / `README.EN.md` | Roadshow deck usage guide (中文 / English) |

> **Note**: `src`, `server`, `public`, and `tools` are standard code directories kept with their original names to ensure builds work correctly. Non-code directories use bilingual naming.

## Safety

This project is assisted by DeepSeek V4.1-Flash and Qwen 3.8 Max (running on DeepSeek Harness) and GPT 6 Sol (running on Codex). All AI-generated output has not been carefully reviewed by the developers, who are not responsible for the final code base and documentation.

See [SAFETY.md](SAFETY.md) ([中文](SAFETY.zh.md)) for detailed safety information, responsible use guidelines, and data privacy considerations.

## Background tasks and operations

See [OPERATIONS.md](OPERATIONS.md) for durable OCR jobs, limits, review auditing, backup/restore, and capacity/evaluation tools (Chinese).

Release audit / 发布审核：[PRE_RELEASE_AUDIT.md](PRE_RELEASE_AUDIT.md) · [runtime budgets / 运行预算](RUNTIME_CONFIGURATION.md)

Native installation now uses Windows MSI, Linux DEB/RPM and macOS PKG. The former custom deployment GUI is retired from builds/releases. See [native installer documentation](tools/installer/README.md). Application data and APP_SECRET are retained on removal; migrate legacy paths explicitly before first launch.

OAuth source comparison and verification limits: [2026-10-27 audit](docs/oauth-audit-2026-10-27.md). The ChatGPT adapter remains a Codex compatibility client, not this app’s registered official Sign in with ChatGPT integration. WorkBuddy has not been validated with a real account. Saving API-key settings does not perform paid inference; same-vendor edits can retain the encrypted key, and “save and use” activates it atomically.
