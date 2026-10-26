# 从实际环境推导运行预算

CPU、RAM、磁盘空间从部署机器读取，不使用之前讨论的服务器规格作为事实。查看学校管理员权限的 `GET /api/operations` 中 `runtime`、`resources` 可核对探测来源、预算和实际使用量。本地测试环境和线上服务器不是同一台机器，仓库不能测出线上资源。

## 探测与计算

`server/runtime-profile.mjs` 读取 OS 总内存、Node constrainedMemory、availableParallelism，以及 Linux cgroup v2/v1 的可见层级 CPU/内存限制，取限制中的最小值。CPU 配额可为小数；并发计算使用向下取整、至少一个工作槽。OS/cgroup 文件读取最多 32 KiB。探测无法看到被宿主隐藏的限制；需要结合服务管理器实际配置核对。

以下比例是代码公开的**分配策略**，不是测量所得的性能结论。设有效内存为 M、可用 CPU 工作数为 C：

| 项目 | 自动预算 | 可覆盖配置 |
| --- | --- | --- |
| API V8 主堆 | M/4，最高 M/2 | SERVICE_HEAP_MB |
| API RSS 软准入 | M/2，最高 3M/4 | SERVICE_RSS_SOFT_MB |
| 在途内联 Base64 | min(M/32, 堆/4, 256 MiB) | MODEL_INLINE_BUDGET_MB |
| 模型并发 | C，受堆/响应正文预算约束 | MODEL_GLOBAL_CONCURRENCY |
| 学校、教师、后台批改 | 默认全局并发，最高全局并发 | MODEL_SCHOOL_CONCURRENCY、MODEL_STAFF_CONCURRENCY、OCR_CONCURRENCY、OCR_USER_CONCURRENCY |
| 上传 | min(C, 内联预算/44 MiB)，至少 1；覆盖值受 RSS/50 MiB 约束 | UPLOAD_CONCURRENCY |
| 密码哈希 | CPU、libuv 池减一、堆/32 MiB 中最小值 | PASSWORD_CONCURRENCY |
| 活跃 HTTP 请求 | 8C，最高堆 MiB/2 | HTTP_MAX_ACTIVE_REQUESTS |
| JSON 请求体接收 | 4C，最高堆 MiB/16 | HTTP_JSON_CONCURRENCY |
| TCP 连接 | 默认活跃请求数×4，受缓冲内存预算约束 | HTTP_MAX_CONNECTIONS |
| 解析子进程堆/RSS | M/16、M/8，最高 API 堆/RSS 预算 | PARSER_HEAP_MB、PARSER_RSS_MB |

覆盖值必须为正整数，会被相应安全预算裁剪。Node libuv 池未配置时遵循 Node 默认值 4；这属于运行时协议默认值。学生模型并发 1、单次上传字节上限、响应字节上限、超时和日配额仍是显式安全/业务策略，不按 CPU 猜测供应商吞吐或用户权益。

`storage-profile.mjs` 在配置路径最近的既有父目录执行 statfs。上传暂存默认 min(可用磁盘/4, 有效内存)，最高可用磁盘/2；每校默认全局暂存的 1/4，至少容纳一次最大上传且不超过全局预算。上传磁盘余量默认目标文件系统总量的 5%。备份目标容量默认启动时可用空间的 1/4，单份默认其一半，空闲保留默认目标文件系统总量的 5%。BACKUP_*、UPLOAD_*、DISK_MIN_FREE_MB 可显式调整；这些不是文件系统硬配额，也不保证其他程序不会占用磁盘。

启动资源元数据缓存；调整机器规格、cgroup 或 `.env` 后须重启进程以重新计算。运行中的压力采样继续每 5 秒监测可用内存、PSI、换页、磁盘和事件循环；繁忙时降载或拒绝新工作。启动预算不会随每个请求执行 statfs 或同步读取系统文件。

## 启动与升级

生产使用 `node --env-file=.env tools/ops/supervise.mjs`，监督器在启动 API 子进程前应用实际计算的堆预算。直接 `node server/index.mjs` 仍支持，但 V8 堆由 Node 自身决定；runtime 同时报告实际 v8HeapLimitMiB，不能把配置值当作已应用的硬上限。

部署器运行时包携带 `tools/ops`，首次启动和已安装服务优先使用监督器；旧包无监督器时保留兼容入口。升级保留额外 `.env` 设置。旧 `.env` 中手工写入的并发/内存设置不会自动删除，想采用自动计算时移除对应赋值再重启。

systemd 示例的主服务 MemoryHigh=60%、MemoryMax=75%、备份 MemoryMax=10%、swap=0 是可调整策略，只有安装并启动这些单元才生效。systemd 百分比和可见 cgroup 总预算的基准可能不同；上线前核对实际单元限制。监督器不能修复硬盘故障或内核不可中断 I/O。

## 不能从硬件推导的配置

模型价格、图像 token 上限、供应商速率、OAuth 客户端、学校配额、公开域名、备份目标和可信代理必须由部署方显式配置或读取业务数据库。预算启用时所有视觉模型都必须提供准确 provider/model 的保守 `imageTokens`，缺失则在调用前拒绝，不再猜测 DeepSeek 的图像参数。使用实际 usage 结算，未知费用保留待对账。

学段来自实际数据库 users CHECK 约束；注册开关来自服务端环境；前端通过 `/api/capabilities` 获取，不另设猜测回退。版本以 `server/version.mjs` 为服务端/部署器/打包流水线来源，发布资产大小、摘要和 Node 架构从实际文件与运行时读取。前端版本与 package/lock 由同步测试核对。

协议标识、加密参数、HTTP 状态码、UI 布局/动画值、测试夹具及明确标注的历史测量值保留。将它们全部改成“从环境推断”会破坏协议和可重复测试。
