# 运行、备份与容量验证

上传超时、内存准入、解析进程隔离、自动重启部署和故障测试记录见 [RESILIENCE.md](RESILIENCE.md)。

多核执行方式、异步密码哈希、SQL 语句缓存和动态降载见 [PERFORMANCE.md](PERFORMANCE.md)。

本轮改善保留 Node.js 24、单机 SQLite 和本地附件目录。没有迁移到 PostgreSQL/对象存储，也没有证明可承载一万人同时使用。先用隔离环境测量，再决定扩容。不要把同一 DATA_DIR 放到网络文件系统，也不要将多个独立本地数据库当成同一集群。

## 后台识别

- 网页使用 `POST /api/submissions/:id/recognition-jobs`，立即返回 HTTP 202 和任务摘要。
- `GET /api/submissions/:id` 返回授权教职工可见的 `recognitionJob`；学生不可读取任务错误或未复核识别结果。页面每约两秒刷新正在进行的任务，可切换答卷、刷新或关闭页面。
- 原同步 `/recognize` 接口保留兼容；客户端断开时取消该次模型请求，不保证恢复，建议新客户端使用队列。
- 一个答卷同时只能有一个任务；重复操作返回 409。全局/学校队列满返回 429 和 Retry-After，不会撤销已有成绩。
- 队列接受重新识别后立即撤销原复核状态，旧错题不再进入学生练习和教学统计；模型输出仍须教师复核。
- PDF/Word 在独立子进程解析，单实例最多 1 个解析进程，堆上限 256 MiB；Linux 每 250 ms 检查 RSS，超过 512 MiB 则终止。每任务总时限 120 秒、租约 150 秒，崩溃后最迟等租约到期再接管。上游 HTTP 429/5xx 最多尝试三次，间隔递增；文件错误和格式错误需修正后手动重试。账户/学校调用额度耗尽不会无限重试。RSS 采样不能替代操作系统内存硬限制。
- 模型繁忙时稍后排队，不占失败尝试数，但最多等待一小时。单个账户后台任务串行执行。
- 重试采用至少一次执行语义：进程在收到模型结果后、保存前崩溃可能再次调用并计费；租约令牌阻止旧任务覆盖新结果。不能承诺外部模型恰好调用一次。
- 任务不保存密钥或文件内容，只保存数据库引用。请为生产实例持续使用同一个私密 APP_SECRET。

`.env.example` 的 MODEL_GLOBAL_CONCURRENCY、MODEL_SCHOOL_CONCURRENCY、MODEL_STAFF_CONCURRENCY、OCR_CONCURRENCY、OCR_USER_CONCURRENCY 默认均为 4；学生并发固定为 1。OCR_MAX_PENDING、OCR_SCHOOL_MAX_PENDING、UPLOAD_TOTAL_MB 默认分别为 100、25、50。MODEL_INLINE_BUDGET_MB 默认 96，限制所有在途内联图片的 Base64 字符数总量（最高可配置 256 MiB，不是精确 RSS 上限）。保留原账户/学校调用次数配额和金额预算。环境变量需注入进程，例如 `node --env-file=.env server/index.mjs`；旧 .env 中的 OCR_CONCURRENCY=1 和模型并发 2 会继续生效，升级时需同步修改这些设置。

教师在复核页可筛选低于 80% 置信度、缺少置信度或包含“无法辨认”的题目。筛选只是查看辅助，不会批量确认任何评分。最终保存仍验证整份正式题目。

## 运行统计与审计

学校管理员仪表盘展示本校排队/处理/成功/失败任务数，以及最近一小时和一天的模型调用次数。`GET /api/operations` 仅供学校管理员，按学校隔离。近 15 分钟请求统计仅包含已认证账户，计数、5xx、平均/最大耗时在进程内保存，重启后清零；多实例不会自动聚合。

`GET /api/submissions/:id/review-history` 仅允许授权教职工读取最近 100 次识别申请和复核操作，记录操作人、时间、总分和逐题改分/改判摘要，不复制学生答案正文或模型密钥。复核保存与审计写入在同一事务中。审计记录也包含学生相关数据，应随学校的数据保留政策一起管理。

这些统计是排查入口；正式部署仍需外部日志、磁盘/内存告警、模型账单告警和备份失败通知。

## 备份与恢复

自动定时备份、保留策略、容量配置和恢复步骤见 [BACKUPS.md](BACKUPS.md)。

使用 Node 的 SQLite 在线备份接口，不直接复制正在写入的 sqlite/WAL 文件。当前应用附件为不可变文件：备份先取得一致数据库副本，再复制该副本引用的附件，检查数据库完整性并生成 SHA-256 清单。若有外部清理程序，请在备份期间暂停文件删除。不要在源目录内存放备份。

```bash
node tools/ops/storage.mjs backup /srv/homework/data /srv/backups/homework-2026-10-23
node tools/ops/storage.mjs restore /srv/backups/homework-2026-10-23 /srv/homework/restore-check
```

目标路径必须不存在；失败不会覆盖现有目录。恢复先校验全部文件，再重写附件绝对路径并清除登录会话/运行租约。恢复后使用原 APP_SECRET 才能解密已有模型凭据；APP_SECRET 必须通过独立安全渠道备份。备份包含学生数据和加密凭据，应限制权限、加密后异地保存，并按保留期限清理。清单校验用于发现损坏，不能替代防篡改存储。

提供每小时备份 timer 和周期性隔离恢复演练；每月仍建议人工启动隔离服务，检查登录、附件授权访问与复核统计。切换正式 DATA_DIR 前停止旧实例，确保备份可用；不要直接覆盖生产目录。仓库不自动安装计划任务，也不上传真实数据。

## 可重复验证

```bash
npm test
npm run build
npm run verify:teaching
npx playwright install --with-deps chromium
npm run test:browser
```

可通过 PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH 指向已安装的 Chromium，默认仍用 Playwright 管理的浏览器。所有自动模型测试使用模拟结果，不调用付费 API。

### 本地基础压测

先启动 `node tests/browser/server.mjs`，它使用临时数据库和模拟模型。通过测试教师登录取得会话后，将其放入 LOAD_COOKIE 环境变量，执行：

```bash
node tools/ops/load.mjs
```

默认 20 并发、200 次已认证作业/提交列表请求，输出失败数及 p50/p95/p99。LOAD_BASE 默认本机 18877，仅接受 loopback；LOAD_CONCURRENCY 最大 100，LOAD_REQUESTS 最大 10000。不要将会话写入版本库或分享压测日志中的凭据。

这只验证列表读取基线，不代表真实一万用户容量。下一步应使用匿名化大样本数据库，单独测量集中上传、PDF 转换、队列积压、长时间运行和模型限流，并记录 CPU、内存、磁盘、p95 和错误率。模型费用与供应商速率需独立测量。

### OCR/评分离线评测

`node tools/ops/evaluate.mjs /secure/anonymous-evaluation.json` 读取以下数组格式，不连接模型：

```json
[
  {
    "expected": [
      {
        "questionId": "q1",
        "studentAnswer": "2 A",
        "score": 5,
        "isCorrect": true
      }
    ],
    "actual": [
      {
        "questionId": "q1",
        "studentAnswer": "2A",
        "score": 0,
        "isCorrect": false
      }
    ]
  }
]
```

输出正式题目匹配率、答案完全一致率（Unicode NFC、忽略空白）、正误准确率、已匹配题目的评分平均绝对误差。缺失题计入准确率分母，重复或非正式题号拒绝评测。文字一致率不是语义准确率；同义表达需要教师另行判断。

真实评测集需由获授权的人员匿名化并标注，按印刷/手写、模糊图片、公式、多页、学段学科分层。额外记录教师修正时间、每份调用费用和模型版本。仓库只提供工具与合成测试，没有真实作业效果结论。

## 后续架构迁移

任务模块、文件解析模块和监控模块已从主服务分离。扩大到多机器前，仍需实现 PostgreSQL 适配、对象存储授权下载、独立任务进程/共享队列和迁移回滚演练。密码找回、学校身份验证及文件病毒扫描也需要配套服务和产品流程，不应仅凭服务器配置宣称完成。

## 可选设备端切片与金额预算

见 [CLIENT_TILING.md](CLIENT_TILING.md)：包含客户端 Worker 重叠切片、幂等流式上传、有限头部检查、账户/学校金额预留、未知用量对账和 DeepSeek Files API 清理。增强功能默认关闭，普通上传与教师复核保持原流程。旧上传接口也加入入口并发/传输配额，不能作为绕过路径。
