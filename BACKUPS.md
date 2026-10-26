# 自动备份与恢复

备份覆盖数据库中的账户、作业、成绩、教师复核、费用账本及其引用的本地原图和切片。不复制正在变化的 SQLite/WAL 文件：使用 SQLite 在线备份取得一致快照，再复制不可变附件。临时上传和 DeepSeek Files 临时文件不作为恢复附件。

备份任务在独立进程运行，不放在 API 请求或 API 主事件循环中。提供的 systemd 示例限制 CPU 为单核的 25%、总内存为主机内存的 10%、V8 堆按该进程实际资源预算计算、最长运行 30 分钟，并降低 CPU/I/O 调度优先级；这些限制只有安装服务后才生效，IOWeight 也需要对应控制器/设备支持。

## 启用

在生产环境文件中设置 DATA_DIR 和 BACKUP_DIR。BACKUP_DIR 必须在 DATA_DIR 之外，建议使用另一块磁盘；目录由服务账户独占，权限 0700。以下示例路径与 systemd 示例一致：

```dotenv
DATA_DIR=/var/lib/mes-homework
BACKUP_DIR=/var/backups/mes-homework
BACKUP_KEEP_RECENT=24
BACKUP_KEEP_DAYS=7
# 容量变量不设置时从备份目标文件系统实际空间计算
# BACKUP_MAX_TOTAL_MB=
# BACKUP_MAX_SNAPSHOT_MB=
# BACKUP_MIN_FREE_MB=
BACKUP_RESTORE_DRILL_DAYS=7
```

先手动执行一次，确认快照、校验和恢复演练成功：

```bash
node --env-file=/etc/mes-homework.env tools/ops/backup.mjs run
node --env-file=/etc/mes-homework.env tools/ops/backup.mjs status
```

本地开发也可通过 `npm run backup:run`、`npm run backup:status` 使用 .env。没有 BACKUP_DIR 时拒绝运行。备份目录不能与其他 DATA_DIR 混用，也不能放到 Web 可公开访问的目录。

安装 [backup service](tools/ops/mes-homework-backup.service.example) 和 [backup timer](tools/ops/mes-homework-backup.timer.example)：按实际 Node 路径、专用用户、代码目录、DATA_DIR/BACKUP_DIR 调整，复制为 `/etc/systemd/system/mes-homework-backup.service` 和 `.timer`。事先创建备份目录并赋予 `mes-homework` 用户独占权限；同步修改服务的 ReadWritePaths。SQLite 连接为只读，但源数据目录允许其创建必要的 WAL/SHM 辅助文件。

```bash
systemctl daemon-reload
systemctl enable --now mes-homework-backup.timer
systemctl list-timers mes-homework-backup.timer
journalctl -u mes-homework-backup.service
```

默认每小时备份，加至多 5 分钟随机延迟；停机错过计划后在恢复运行时补执行一次。只有安装并启用 timer 才会自动运行，提交代码或填写 .env 不会自动启用。单次失败记录到 journal 和受限的 status.json，命令返回非零；需将命令退出码或 systemd 失败状态接入运维监控，仓库不会自动发送邮件/消息。

故障时只能恢复已完成快照的时点，之后的更改可能丢失；每小时排程不等于实时同步或零数据丢失。

## 保留与失败行为

启用系统压力检测时，备份会在可用内存/换页/PSI 或 API 降载信号繁忙时延后，并在复制、哈希校验、恢复演练检查点再次检查。它不会在单次原子文件复制或 SQLite 查询内部即时抢占。延后返回退出码 75；更新后的 systemd 示例会在 10 分钟后重试，普通配置/数据错误退出码 1 仍等待排查或下一次计划。API 停止后的过期状态提示不会阻止独立备份，进程自身仍读取主机和 cgroup 指标。详情见 [PERFORMANCE.md](PERFORMANCE.md)。

- 保留最近 24 份快照，并尽量保留近 7 天每天的最新副本；成功快照总大小超过配置时，从最旧副本开始减少保留。当前新副本始终保留，数量和天数不是容量不足时的保证。
- 默认保留总量为备份目标文件系统启动时可用空间的 1/4，默认单份上限为其一半；空闲保留默认文件系统总量的 5%。这些是分配策略，容量需按真实数据增长调整。
- 新备份先写独立暂存目录，检查数据库完整性、外键、全部 SHA-256 和附件引用完整性，成功后才允许删除本工具同一数据源的历史快照。不清理用户手工目录、其他数据源副本或无法识别的损坏目录。
- 第一次及每隔 7 天在备份盘的独立临时目录实际恢复一次，验证恢复逻辑和数据库，再删除演练目录；不会启动生产服务、调用模型或覆盖 DATA_DIR。它不代替完整登录和业务流程的人工演练。
- 开始复制前检查大小与磁盘余量，至少保留配置的空闲空间。为避免先删后失败，不会为了新备份预先删除旧备份；空间不足会失败并保留旧副本。还需预留一份新备份、到期恢复演练的完整副本和配置的空闲余量；程序按实际探测的可用空间检查。
- 备份之间用独立 SQLite 文件锁互斥；进程崩溃后内核释放锁。下一次运行清理已登记的未完成暂存/演练目录，不会删除上一份成功备份。写好的文件在发布前 fsync；持久性仍取决于硬盘、文件系统及控制器。
- status 命令在最近一次任务失败、缺少记录或距成功备份超过 2 小时时返回非零。status.json 中保留上次成功时间与快照位置。即使状态成功，也可用 `node tools/ops/storage.mjs verify <快照目录>` 重新检查文件。

保留配额不是文件系统硬配额，未知文件和中断残留也会占空间；应结合独立备份卷/目录配额与磁盘告警。备份失败不能靠清空所有旧备份解决。

## 故障恢复

先停止 API 实例，保留故障目录用于排查。选取最近通过校验的快照，恢复到一个全新目录，禁止覆盖现有数据：

```bash
node tools/ops/storage.mjs verify /var/backups/mes-homework/snapshot-实际名称
node tools/ops/storage.mjs restore /var/backups/mes-homework/snapshot-实际名称 /var/lib/mes-homework-restored
```

恢复后修改服务的 DATA_DIR 和 ReadWritePaths，确保专用用户拥有数据，使用兼容的代码版本启动。备份器绑定原数据目录，切换后使用一个新的 BACKUP_DIR，保留旧备份目录供回溯。

恢复会保留成绩和复核内容，重写本地附件路径，清除旧登录会话，取消未完成上传并回收任务租约。用户重新登录后，检查原图权限、教师成绩及队列状态。启用了费用预算时模型调用先暂停：必须核对备份时点之后的供应商实际账单，再按 [CLIENT_TILING.md](CLIENT_TILING.md) 使用 reconcile-cost 工具处理未决记录并确认恢复；不要跳过预算闸门。恢复的队列可能重新尝试任务，每次尝试仍受预算约束。

APP_SECRET 不会被自动写入备份，应通过独立的受控渠道加密保存。保留原 APP_SECRET 才能解密既有模型凭据；丢失它不等于作业成绩丢失，但需要重新录入模型密钥。备份含学生数据和加密凭据，不能上传公共仓库或共享网盘目录。

同盘备份能应对程序错误、误删和部分文件损坏，无法抵御整盘损坏、整机丢失或攻击者同时删除所有副本。当前未配置异地上传：可将 BACKUP_DIR 放到另一磁盘，并用受控的加密离线/异地复制保存已完成快照。SHA-256 用于发现损坏，不能代替防篡改或不可变存储。

## 验证记录

2026-10-24，200 项自动测试和生产构建通过。专项测试包括成绩/复核/原图恢复、缺失附件与损坏校验、容量不足保留旧副本、跨数据目录和符号链接越界防护、互斥进程被 SIGKILL 后恢复运行、未完成暂存清理、保留策略及退出码。在单独的 64 MiB V8 堆进程中备份约 16 MiB 的合成数据库，同时源数据库继续写入 WAL，快照校验及恢复演练成功。所有数据均为合成数据。

systemd service/timer 替换为当前 Node 路径后通过配置检查；没有在本环境安装定时任务或备份真实生产数据，也没有验证整盘故障或异地恢复。
