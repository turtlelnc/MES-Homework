const translations = {
  zh: {
    "a11y.skip":"跳到正文","a11y.copy":"复制命令",
    "nav.product":"产品","nav.workflow":"工作流","nav.cli":"MSH CLI","nav.docs":"文档","nav.open":"进入系统 ↗",
    "hero.eyebrow":"面向学校的 AI 作业分析平台","hero.title":"让作业不止于<br><span class=\"gradient-text\">批改完成。</span>","hero.lede":"从答卷识别、教师复核，到知识点掌握率、错因统计与讲评课方案。把零散的作业数据，变成下一堂课真正用得上的线索。","hero.primary":"开始使用","hero.secondary":"查看源代码",
    "visual.window":"教师工作台 · 班级学情","visual.overview":"班级总览","visual.assignments":"作业管理","visual.review":"识别与复核","visual.analytics":"AI 教学分析","visual.connected":"数据已同步","visual.term":"九年级 · 数学","visual.class":"七班学情概览","visual.reviewed":"已复核答卷","visual.score":"班级得分率","visual.errors":"待关注错因","visual.categories":"类主要问题","visual.mastery":"知识点掌握情况","visual.reviewedonly":"仅统计已复核数据","visual.algebra":"代数运算","visual.geometry":"几何证明","visual.functions":"函数图像","visual.insight":"本周教学建议","visual.insightcopy":"优先回顾几何证明中的条件遗漏。","visual.secure":"教师已确认","visual.note1":"教师复核","visual.note1sub":"结果可信，再进入统计","visual.note2":"从数据到课堂","visual.note2sub":"讲评方案一键生成",
    "proof.caption":"一个闭环，连接四种角色","proof.school":"学校管理","proof.teacher":"教师复核","proof.student":"学生巩固","proof.parent":"家长陪伴",
    "product.eyebrow":"PRODUCT / 产品能力","product.title":"把批改流程，<br>变成教学反馈系统。","product.lede":"不是再加一个聊天框。MES Homework 将识别、复核、练习和分析串成可追溯的工作流。",
    "feature.ocr.kind":"识别 · 批改","feature.ocr.title":"从纸面答卷<br>到结构化结果。","feature.ocr.copy":"支持图片、PDF 与 Word 作业材料。逐题提取答案、评分与判断依据，教师可以核对、改分，再决定哪些结果进入后续统计。",
    "feature.review.kind":"教师在环","feature.review.title":"复核权，始终在老师手中。","feature.review.copy":"全部复核、仅复核存疑题，或按学校策略自动完成。AI 结果附带参考答案与判分理由；结构异常仍回退人工处理。","feature.review.chip1":"全部复核","feature.review.chip2":"仅存疑","feature.review.chip3":"不复核",
    "feature.mistake.kind":"自主巩固","feature.mistake.title":"错题本不急着给答案。","feature.mistake.copy":"先提出思考问题，再给分步提示；学生重做后，才对照参考答案并完成同类练习。让掌握发生在解题过程中。",
    "feature.analytics.kind":"课堂决策","feature.analytics.title":"看见全班的薄弱点。","feature.analytics.copy":"按题号聚合知识点掌握率与错因分布，找出高频错题，生成讲评提纲、板书设计、分层辅导动作和课后练习。",
    "feature.parent.kind":"家校协同","feature.parent.title":"让家长看到成长，而不只是分数。","feature.parent.copy":"家长看板呈现学习趋势、薄弱知识点和近期答卷细节，并可生成个性化学情分析与家庭配合建议。",
    "feature.school.kind":"学校级管理","feature.school.title":"权限、数据与模型配置分层管理。","feature.school.copy":"学校、教师、学生和家长按角色与学校范围隔离访问；模型 API Key 由服务端加密保存，并支持学校统一或分角色的调用策略。",
    "product.note":"统计口径：只有教师确认过的错题进入班级教学分析；无法辨认的题目单独列出，不计入错因占比。直接 AI 批改采用答卷级题目快照，不进入基于共享题库的班级讲评统计。",
    "workflow.eyebrow":"A CLEAR WORKFLOW / 清晰的工作流","workflow.title":"每一步都有来处，<br><span class=\"muted-heading\">每个结论都有依据。</span>","workflow.lede":"让 AI 做擅长的识别与整理，让教师决定教学事实。",
    "workflow.step1.title":"收集作业","workflow.step1.copy":"上传学生答卷；可基于原题库，也可选择无需原题的 AI 直接批改。","workflow.step2.title":"识别与批改","workflow.step2.copy":"OCR 提取题目与作答，模型给出逐题得分、参考答案和判分理由。","workflow.step3.title":"教师复核","workflow.step3.copy":"按学校选定的复核方式确认结果；存疑题与无法辨认内容可单独处理。","workflow.step4.title":"形成学情","workflow.step4.copy":"确定性统计复核数据，计算知识点掌握率与错因分布，不让模型编造数字。","workflow.step5.title":"回到课堂","workflow.step5.copy":"生成讲评课方案、分层辅导动作与课后练习，学生和家长继续跟进。",
    "workflow.principle.title":"数据由程序计算，AI 负责表达。","workflow.principle.copy":"班级数字来自已复核记录的确定性聚合。AI 可以帮助把结论写成课堂语言，但不会替代数据计算或教师判断。",
    "cli.eyebrow":"THE OPERATOR TOOLKIT / 运维命令行","cli.title":"把部署与日常管理，<br>收进一个命令。","cli.lede":"<code>@turtlelnc/msh</code> 是 MES Homework 的便携服务器 CLI。它管理本机运行时、Cloudflare Tunnel、学校开通码、模型凭证、管理员控制台和 MCP 接口。","cli.npm":"在 npm 查看软件包 ↗","cli.terminalhint":"# 安装 CLI（需要 Node.js 24+）","cli.terminalhint2":"# 在本机启动并打开浏览器","cli.terminalhint3":"# 运行完整环境自检","cli.ready":"就绪。你的服务器，你来掌控。",
    "cli.cmd.local":"仅本机启动","cli.cmd.all":"监听所有网卡","cli.cmd.cf":"启动服务与 Cloudflare Tunnel","cli.cmd.cfset":"交互配置隧道和域名","cli.cmd.code":"签发一次性学校开通码","cli.cmd.api":"配置学校模型 API Key","cli.cmd.manager":"打开服务器管理网页","cli.cmd.mcp":"启动 MCP stdio 服务","cli.note":"提示：<code>--all</code> 会监听所有网卡。公开部署前请配置 HTTPS、APP_ORIGIN、防火墙和安全密钥；不要直接把未保护的服务暴露到公网。",
    "docs.eyebrow":"DOCUMENTATION / 使用文档","docs.title":"从第一次启动开始。","docs.lede":"部署、使用和维护的关键步骤都整理在这里。完整实现与历史变更仍以仓库文档为准。","docs.rail.title":"在本页阅读","docs.rail.quick":"快速开始","docs.rail.use":"使用流程","docs.rail.deploy":"部署与 Worker","docs.rail.care":"安全与运维",
    "docs.quick.title":"启动你的第一套实例","docs.quick.copy":"MES Homework 是需要自托管的全栈应用。准备 Node.js 24 或更新版本，安装依赖、复制环境模板，编辑 APP_SECRET（至少 32 位随机值）与 DATA_DIR，再构建并启动：","docs.quick.secret":"生产环境必须设置 APP_SECRET。","docs.quick.secretcopy":"请使用密码管理器生成至少 32 字符的随机值，并妥善备份；现有加密凭证依赖同一密钥解密。","docs.quick.more":"阅读完整安装说明 ↗","docs.quick.installer":"原生安装器指南 ↗","docs.quick.release":"下载发行版 ↗",
    "docs.usage.title":"一次作业，如何走完整个闭环","docs.usage.1t":"建立学校与角色","docs.usage.1c":"管理员使用一次性开通码创建学校，再由学校/教师管理员按权限建立成员、班级与教师关系。","docs.usage.2t":"配置知识库与模型","docs.usage.2c":"维护校本知识点，在学校设置中选择模型调用模式并配置服务端 API Key。","docs.usage.3t":"创建作业","docs.usage.3c":"上传原题生成题目草稿，或使用“无需原题 · AI 直接批改”创建答卷级题目快照。","docs.usage.4t":"上传答卷并复核","docs.usage.4c":"学生上传答卷；教师选择全部复核、仅存疑复核或不复核，并核对异常识别结果。","docs.usage.5t":"分析与巩固","docs.usage.5c":"教师查看班级教学分析；学生按思考、提示、重做、对照答案、同类练习的顺序订正；家长跟进孩子学情。","docs.usage.more":"查看同页工作流说明 ↗","docs.usage.runtime":"运行时容量与配置 ↗","docs.usage.ops":"查看运行与备份指南 ↗",
    "docs.deploy.title":"官网静态托管，API 回到你的源站。","docs.deploy.copy":"Worker 将 <code>website/</code> 作为静态官网，<code>/app</code> 跳转到源站应用，并把 <code>/api</code>、<code>/api/*</code>、<code>/uploads</code> 与 <code>/uploads/*</code> 代理到 <code>ORIGIN_URL</code>。SQLite、上传原件和模型调用仍由你自己的 Node 服务负责；不依赖 D1 或 R2.","docs.deploy.warning":"不要把临时 Quick Tunnel 当生产入口。","docs.deploy.warningcopy":"生产环境建议使用持久命名隧道和固定 HTTPS 域名；API 服务端的 APP_ORIGIN 必须设置为浏览器访问的精确官网源（含 https://，不带路径或尾部斜杠）。","docs.deploy.cloudflare":"Cloudflare Static Assets 官方文档 ↗",
    "docs.care.title":"上线前，先把边界讲清楚。","docs.care.data":"数据与规模","docs.care.datacopy":"当前使用单机 SQLite 与本地附件目录，适合单机或单写节点。不要把 DATA_DIR 放在网络文件系统，也不要把它当成已验证的多节点集群。","docs.care.review":"人工复核","docs.care.reviewcopy":"AI OCR 与评分可能出错。模型结果和课堂分析不等于准确性保证，学校应由教师复核，并使用授权样本验证识别效果。","docs.care.secrets":"密钥与访问","docs.care.secretscopy":"保持 HTTPS、使用有效 APP_SECRET、限制可信模型 API Origin，并按学校/角色控制答卷访问。不要公开 API Key 或管理员令牌。","docs.care.backup":"备份与隐私","docs.care.backupcopy":"定期进行 SQLite 在线备份和隔离恢复演练。备份包含学生相关数据与加密凭证，应限制权限、加密异地保存并按制度清理。","docs.care.security":"安全审查与剩余限制 ↗","docs.care.backupdoc":"备份与恢复文档 ↗","docs.care.wiki":"GitHub Wiki ↗",
    "faq.eyebrow":"FAQ / 常见问题","faq.title":"部署前，先看这几件事。","faq.q1":"它是 SaaS 服务，还是需要自己部署？","faq.a1":"这是可自托管的全栈项目。你需要准备 Node.js 24+ 的服务器或本机环境、持久化数据目录、APP_SECRET，以及模型供应商 API Key。Worker 只负责官网静态资源和 API 反向代理。","faq.q2":"AI 批改后，结果会自动成为班级统计吗？","faq.a2":"不会无条件纳入。班级教学分析只统计教师已复核确认的数据；无法辨认的题目单独显示。直接 AI 批改的答卷级题目快照不进入共享题库的班级讲评统计。","faq.q3":"是否包含模型额度或 API Key？","faq.a3":"不包含。模型调用使用学校或部署方配置的 API Key，费用与速率限制由对应供应商账户及部署策略决定。","faq.q4":"现在能否直接横向扩展到多台服务器？","faq.a4":"目前不能把它视为开箱即用的多节点集群。现阶段基于单机 SQLite 与本地文件；多节点部署前需要 PostgreSQL、对象存储、共享队列及迁移/恢复方案。",
    "closing.eyebrow":"OPEN SOURCE · BUILT FOR REAL CLASSROOMS","closing.title":"让每一份作业，<br>都多一点教学价值。","closing.copy":"从仓库开始，按学校的节奏部署。代码、版本与完整文档都公开在 GitHub。","closing.github":"打开 GitHub 仓库","closing.npm":"安装 MSH CLI","footer.copy":"校园作业分析 · 让数据回到教学现场。","footer.license":"MIT License · 开源项目","footer.safety":"安全与隐私说明 ↗","toast.copied":"已复制到剪贴板","toast.failed":"复制失败，请手动选择命令"
  },
  en: {
    "a11y.skip":"Skip to content","a11y.copy":"Copy command",
    "nav.product":"Product","nav.workflow":"Workflow","nav.cli":"MSH CLI","nav.docs":"Docs","nav.open":"Launch app ↗",
    "hero.eyebrow":"AI-assisted homework analysis for schools","hero.title":"Homework should do<br><span class=\"gradient-text\">more than get graded.</span>","hero.lede":"From answer-sheet recognition and teacher review to knowledge mastery, error patterns and lesson plans. Turn scattered homework data into signals teachers can actually use.","hero.primary":"Get started","hero.secondary":"Explore the source",
    "visual.window":"Teacher workspace · Class insights","visual.overview":"Class overview","visual.assignments":"Assignments","visual.review":"Recognition & review","visual.analytics":"AI teaching analysis","visual.connected":"Data synchronized","visual.term":"Grade 9 · Mathematics","visual.class":"Class 7 learning overview","visual.reviewed":"Reviewed sheets","visual.score":"Class score rate","visual.errors":"Error patterns","visual.categories":"key categories","visual.mastery":"Knowledge mastery","visual.reviewedonly":"Reviewed data only","visual.algebra":"Algebra","visual.geometry":"Geometry proofs","visual.functions":"Functions","visual.insight":"Teaching focus this week","visual.insightcopy":"Revisit omitted conditions in geometry proofs.","visual.secure":"Teacher confirmed","visual.note1":"Teacher review","visual.note1sub":"Reviewed first. Counted next.","visual.note2":"From data to teaching","visual.note2sub":"Generate a lesson plan",
    "proof.caption":"One loop, four roles","proof.school":"School admin","proof.teacher":"Teacher review","proof.student":"Student practice","proof.parent":"Parent insight",
    "product.eyebrow":"PRODUCT / CAPABILITIES","product.title":"Turn grading into<br>a teaching feedback loop.","product.lede":"More than another chat box. MES Homework connects recognition, review, practice and analytics in one traceable workflow.",
    "feature.ocr.kind":"RECOGNITION · GRADING","feature.ocr.title":"From paper answers<br>to structured results.","feature.ocr.copy":"Process images, PDFs and Word documents. Extract answers, scores and reasoning question by question. Teachers can verify, edit scores and decide what enters analytics.",
    "feature.review.kind":"HUMAN IN THE LOOP","feature.review.title":"Teachers stay in control.","feature.review.copy":"Review every question, review uncertain items only, or use the school's selected auto-completion mode. AI results include reference answers and grading rationale; malformed output falls back to human review.","feature.review.chip1":"Review all","feature.review.chip2":"Uncertain only","feature.review.chip3":"No review",
    "feature.mistake.kind":"GUIDED PRACTICE","feature.mistake.title":"A mistake notebook that doesn't rush to reveal answers.","feature.mistake.copy":"Start with a thinking prompt, then progressive hints. Students retry before seeing the reference answer and similar exercises. Understanding happens during the process.",
    "feature.analytics.kind":"CLASSROOM DECISIONS","feature.analytics.title":"See where the whole class gets stuck.","feature.analytics.copy":"Aggregate mastery and error patterns by question, surface frequently missed items, and generate lesson outlines, board plans, differentiated support and follow-up practice.",
    "feature.parent.kind":"SCHOOL–HOME COLLABORATION","feature.parent.title":"Help parents see growth, not just scores.","feature.parent.copy":"The parent dashboard presents learning trends, weak knowledge points and recent answer-sheet details, with AI learning analysis and practical ways families can help.",
    "feature.school.kind":"SCHOOL-WIDE ADMIN","feature.school.title":"Separate access, data and model settings by role.","feature.school.copy":"School, teacher, student and parent access is scoped by role and school. Model API keys are encrypted server-side, with school-wide or role-based credential strategies.",
    "product.note":"Analytics policy: only teacher-confirmed mistakes enter class teaching analysis; unrecognizable questions are listed separately and excluded from error percentages. Direct-grading homework uses per-submission question snapshots and does not feed shared-question-bank class analytics.",
    "workflow.eyebrow":"A CLEAR WORKFLOW / FROM ANSWERS TO ACTION","workflow.title":"Every step has a source.<br><span class=\"muted-heading\">Every conclusion has evidence.</span>","workflow.lede":"Let AI help recognize and organize. Let teachers decide what is true for the classroom.",
    "workflow.step1.title":"Collect homework","workflow.step1.copy":"Upload student answer sheets using a shared question bank or direct AI grading without original questions.","workflow.step2.title":"Recognize & grade","workflow.step2.copy":"OCR extracts questions and answers. Models return per-question scores, reference answers and grading rationale.","workflow.step3.title":"Teacher review","workflow.step3.copy":"Confirm results under the school's review policy. Uncertain and unrecognizable items can be handled separately.","workflow.step4.title":"Build learning insights","workflow.step4.copy":"Deterministic aggregation calculates mastery and error patterns from reviewed data. Models do not invent the numbers.","workflow.step5.title":"Bring it back to class","workflow.step5.copy":"Generate lesson plans, differentiated interventions and follow-up exercises for students and parents.",
    "workflow.principle.title":"Code calculates the data. AI helps explain it.","workflow.principle.copy":"Class metrics come from deterministic aggregation of reviewed records. AI can turn findings into classroom language, but does not replace data calculation or teacher judgment.",
    "cli.eyebrow":"THE OPERATOR TOOLKIT / SERVER CLI","cli.title":"Deployment and daily operations,<br>one command away.","cli.lede":"<code>@turtlelnc/msh</code> is the portable server CLI for MES Homework. It manages the local runtime, Cloudflare Tunnel, school invite codes, model credentials, admin console and MCP interface.","cli.npm":"View the package on npm ↗","cli.terminalhint":"# Install the CLI (Node.js 24+)","cli.terminalhint2":"# Start locally and open the browser","cli.terminalhint3":"# Run the environment self-check","cli.ready":"Ready. Your server, your control.",
    "cli.cmd.local":"Local-only server","cli.cmd.all":"Listen on all interfaces","cli.cmd.cf":"Start server with Cloudflare Tunnel","cli.cmd.cfset":"Configure tunnel and domain","cli.cmd.code":"Issue a one-time school invite","cli.cmd.api":"Configure a school's model API key","cli.cmd.manager":"Open the server admin console","cli.cmd.mcp":"Start MCP over stdio","cli.note":"Note: <code>--all</code> listens on every network interface. Before public deployment, configure HTTPS, APP_ORIGIN, firewall rules and a strong secret. Never expose an unprotected service directly to the internet.",
    "docs.eyebrow":"DOCUMENTATION / GET STARTED","docs.title":"Start with the first launch.","docs.lede":"Key steps for setup, everyday use and operations are collected here. The repository documentation remains the source of truth for full implementation details and history.","docs.rail.title":"On this page","docs.rail.quick":"Quick start","docs.rail.use":"Workflow","docs.rail.deploy":"Deployment & Worker","docs.rail.care":"Security & operations",
    "docs.quick.title":"Launch your first instance","docs.quick.copy":"MES Homework is a self-hosted full-stack application. Prepare Node.js 24 or later, install dependencies, copy the environment template and set APP_SECRET (32+ random characters) and DATA_DIR before building and starting:","docs.quick.secret":"Set APP_SECRET before production use.","docs.quick.secretcopy":"Generate a random value of at least 32 characters with a password manager and back it up securely. Existing encrypted credentials require the same secret to decrypt.","docs.quick.more":"Read the full installation guide ↗","docs.quick.installer":"Native installer guide ↗","docs.quick.release":"Browse releases ↗",
    "docs.usage.title":"How one assignment moves through the full loop","docs.usage.1t":"Create the school and roles","docs.usage.1c":"An administrator creates a school with a one-time invite code, then provisions members, classes and teacher assignments within the school's permissions.","docs.usage.2t":"Configure knowledge and models","docs.usage.2c":"Maintain school knowledge points, select a model access mode and configure server-side API keys in school settings.","docs.usage.3t":"Create an assignment","docs.usage.3c":"Upload original questions to create a draft, or choose direct AI grading without original questions to create per-submission question snapshots.","docs.usage.4t":"Upload sheets and review","docs.usage.4c":"Students upload answer sheets. Teachers choose review-all, uncertain-only or no-review mode, while checking recognition anomalies.","docs.usage.5t":"Analyze and reinforce","docs.usage.5c":"Teachers review class insights; students think, use hints, retry, compare answers and practise similar questions; parents follow learning progress.","docs.usage.more":"Read the integrated workflow guide ↗","docs.usage.runtime":"Runtime capacity and configuration ↗","docs.usage.ops":"Read operations and backup guide ↗",
    "docs.deploy.title":"Static site on the edge. APIs at your origin.","docs.deploy.copy":"The Worker serves static assets from <code>website/</code>, redirects <code>/app</code> to the application origin, and proxies <code>/api</code>, <code>/api/*</code>, <code>/uploads</code> and <code>/uploads/*</code> to <code>ORIGIN_URL</code>. SQLite, uploads and model execution remain on your Node server. No D1 or R2 is required.","docs.deploy.warning":"Do not use a temporary Quick Tunnel as your production endpoint.","docs.deploy.warningcopy":"Use a persistent named tunnel and a fixed HTTPS domain for production. Set the API server's APP_ORIGIN to the exact public site origin, including https:// and without a path or trailing slash.","docs.deploy.cloudflare":"Cloudflare Static Assets documentation ↗",
    "docs.care.title":"Be explicit about operational boundaries.","docs.care.data":"Data and scale","docs.care.datacopy":"The current deployment uses single-machine SQLite and local attachment storage. Keep DATA_DIR off network filesystems; this is not a verified multi-node cluster.","docs.care.review":"Human review","docs.care.reviewcopy":"AI OCR and grading can be wrong. Model output and classroom analysis are not an accuracy guarantee. Teachers should review results and evaluate recognition with authorized samples.","docs.care.secrets":"Secrets and access","docs.care.secretscopy":"Use HTTPS and a valid APP_SECRET, restrict trusted model API origins, and enforce school/role-scoped access to submissions. Never publish API keys or admin tokens.","docs.care.backup":"Backup and privacy","docs.care.backupcopy":"Run SQLite online backups and isolated restore drills. Backups contain student-related data and encrypted credentials; restrict access, encrypt off-site copies and follow retention rules.","docs.care.security":"Security review and remaining limitations ↗","docs.care.backupdoc":"Backup and restore guide ↗","docs.care.wiki":"GitHub Wiki ↗",
    "faq.eyebrow":"FAQ / BEFORE YOU DEPLOY","faq.title":"A few things to know first.","faq.q1":"Is this a hosted SaaS, or do I deploy it myself?","faq.a1":"This is a self-hosted full-stack project. You provide a Node.js 24+ host, persistent data directory, APP_SECRET and a model-provider API key. The Worker handles the public site's static assets and reverse-proxies API traffic.","faq.q2":"Does every AI grade automatically enter class analytics?","faq.a2":"No. Class teaching analysis includes only teacher-reviewed and confirmed data. Unrecognizable questions are shown separately. Direct-grading question snapshots do not feed shared-question-bank class analytics.","faq.q3":"Are model credits or API keys included?","faq.a3":"No. Model calls use API keys configured by the school or deployment operator. Billing and rate limits depend on the provider account and deployment policy.","faq.q4":"Can I scale horizontally across multiple servers today?","faq.a4":"Do not treat the current setup as a ready-made multi-node cluster. It uses local SQLite and files; multi-node deployment requires PostgreSQL, object storage, a shared queue and migration/restore procedures.",
    "closing.eyebrow":"OPEN SOURCE · BUILT FOR REAL CLASSROOMS","closing.title":"Give every assignment<br>a little more teaching value.","closing.copy":"Start from the repository and deploy at your school's pace. Source code, releases and full documentation are public on GitHub.","closing.github":"Open the GitHub repository","closing.npm":"Install MSH CLI","footer.copy":"Smart campus homework analysis · Put data back into teaching.","footer.license":"MIT License · Open source","footer.safety":"Safety & privacy ↗","toast.copied":"Copied to clipboard","toast.failed":"Copy failed. Please select the command manually"
  }
};

let currentLang = "zh";
const langButton = document.getElementById("lang-toggle");
const menuButton = document.getElementById("menu-toggle");
const mobileNav = document.getElementById("mobile-nav");
const toast = document.getElementById("toast");
let toastTimer = 0;

function applyLanguage(language) {
  currentLang = language === "en" ? "en" : "zh";
  const dictionary = translations[currentLang];
  document.documentElement.lang = currentLang === "en" ? "en" : "zh-CN";
  document.title = currentLang === "en"
    ? "MES Homework — From grading to learning insight"
    : "MES Homework — 从作业到学情";

  document.querySelectorAll("[data-i18n]").forEach((element) => {
    const key = element.getAttribute("data-i18n");
    if (Object.prototype.hasOwnProperty.call(dictionary, key)) {
      element.innerHTML = dictionary[key];
    }
  });
  document.querySelectorAll("[data-i18n-aria]").forEach((element) => {
    const key = element.getAttribute("data-i18n-aria");
    if (Object.prototype.hasOwnProperty.call(dictionary, key)) {
      element.setAttribute("aria-label", dictionary[key]);
    }
  });

  const description = currentLang === "en"
    ? "AI-assisted homework recognition, teacher review, student practice and class learning analytics."
    : "校园作业分析器：AI 识别批改、教师复核、错题巩固与班级学情分析。";
  document.querySelector('meta[name="description"]')?.setAttribute("content", description);
  langButton.textContent = currentLang === "zh" ? "EN" : "中";
  langButton.setAttribute("aria-pressed", currentLang === "en" ? "true" : "false");

  try {
    localStorage.setItem("mes-homework-language", currentLang);
  } catch {
    // Language switching still works when browser storage is unavailable.
  }
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 2100);
}

langButton.addEventListener("click", () => {
  applyLanguage(currentLang === "zh" ? "en" : "zh");
});

menuButton.addEventListener("click", () => {
  const expanded = menuButton.getAttribute("aria-expanded") === "true";
  menuButton.setAttribute("aria-expanded", expanded ? "false" : "true");
  menuButton.setAttribute("aria-label", expanded ? "Open menu" : "Close menu");
  mobileNav.hidden = expanded;
});

mobileNav.querySelectorAll("a").forEach((link) => {
  link.addEventListener("click", () => {
    mobileNav.hidden = true;
    menuButton.setAttribute("aria-expanded", "false");
    menuButton.setAttribute("aria-label", "Open menu");
  });
});

document.querySelectorAll("[data-copy]").forEach((button) => {
  button.addEventListener("click", async () => {
    const value = button.getAttribute("data-copy") || "";
    try {
      await navigator.clipboard.writeText(value);
      showToast(translations[currentLang]["toast.copied"]);
    } catch {
      showToast(translations[currentLang]["toast.failed"]);
    }
  });
});

document.getElementById("year").textContent = String(new Date().getFullYear());

try {
  const savedLanguage = localStorage.getItem("mes-homework-language");
  if (savedLanguage === "zh" || savedLanguage === "en") {
    currentLang = savedLanguage;
  } else if ((navigator.language || "").toLowerCase().startsWith("en")) {
    currentLang = "en";
  }
} catch {
  // Use the default Chinese interface.
}
applyLanguage(currentLang);

const docSections = ["quickstart", "usage", "deploy", "care"]
  .map((id) => document.getElementById(id))
  .filter(Boolean);
const docLinks = Array.from(document.querySelectorAll(".docs-rail a"));

if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver((entries) => {
    const visible = entries
      .filter((entry) => entry.isIntersecting)
      .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];

    if (!visible) return;
    docLinks.forEach((link) => {
      link.classList.toggle("active", link.getAttribute("href") === "#" + visible.target.id);
    });
  }, { rootMargin: "-18% 0px -65% 0px", threshold: [0, 0.2, 0.6] });

  docSections.forEach((section) => observer.observe(section));
}
