# 单机正式环境：数据迁移、备份与恢复

这些工具面向 Node 22.23.2、一个 API 进程、一块持久磁盘。它们不会自动重启服务或提交微信审核。所有数据库、快照、凭证及备份都应放在仓库外的私密目录，禁止提交到 Git。

## 从旧内存版本迁移

只有首次从 MemoryRepository 切换时使用 inspector 工具。已有 SQLite 的后续发布不需要 inspector。先备份旧代码/配置，准备新编译产物；**导出验证完成前不要停止旧进程**。

1. 读取服务的实际 PID，确认只有一个 API 进程。使用 Node 的 `SIGUSR1` 开启 inspector，并核实仅监听 `127.0.0.1:9229`。不要开放公网端口。
2. 在服务器本机执行 `export-live-memory.mjs`。它核验 PID，通过运行中服务的原型定位实例，停止 HTTP 接单并等待已有 HTTP 请求和生成任务排空，然后同步导出。

```sh
node scripts/production/export-live-memory.mjs \
  --service-module file:///absolute/old-build/service.js \
  --expected-pid ACTUAL_PID --port 8787 --close-listener \
  --output /private/migration/memory-before-production.json
```

工具输出仅包含记录数，快照以 `0600` 写入并同步到磁盘。退出时关闭 inspector。成功后旧监听保持关闭，此时用户会看到计划维护期间的连接失败；不能重新接单后继续使用旧快照。若失败，工具尽力恢复监听；旧进程内存仍保留。

工具在目标进程关闭 HTTP 前安装一个明确引用的迁移保活计时器。Inspector 连接本身不能阻止 Node 在最后一个业务句柄关闭后退出。成功导出后保活持续到操作者显式停止旧进程；恢复 HTTP 监听后才释放保活。修改此逻辑必须运行 `migration-export-lifecycle.test.ts`，其测试目标没有额外定时器或 IPC 保活。

3. 使用新 SQLite 实现导入一个尚不存在的数据库路径。

```sh
node scripts/production/import-memory-snapshot.mjs \
  --input /private/migration/memory-before-production.json \
  --database /private/data/warm-letter.sqlite \
  --repository-module /absolute/new-build/sqlite-repository.js
```

导入覆盖用户、素材、家书、任务、回复、分享、两个幂等索引及哈希登录会话。全部数据在单个事务中导入，随后检查完整性、外键及每类记录数。旧分享记录保留但撤销，需由发信人通过新内容审核重新分享。工具不会输出正文、openid 或会话哈希。

4. 核对计数相等和 `activeLegacyShares=0`，将数据库及父目录交给 API 运行用户，文件 `0600`、目录 `0700`。保留现有 uploads 和原始快照，再切换代码/配置并启动 SQLite 版本。启动时显式运行 `recoverInterruptedJobs()`。
5. 检查正式环境健康、已有账号/家书恢复、旧分享不可访问、新分享审核，以及 inspector 已关闭。

若导出后新版本准备失败，旧进程仍存活时可再次开启回环 inspector，再运行以下命令恢复旧监听：

```sh
node scripts/production/export-live-memory.mjs \
  --service-module file:///absolute/old-build/service.js \
  --expected-pid ACTUAL_PID --port 8787 --resume-only
```

旧进程被终止后不能直接回滚到纯内存版本，否则数据无法自动恢复。应使用已验证 SQLite 数据库与兼容代码回退，原始快照作为迁移回退依据。

## 一致备份

```sh
umask 077
node scripts/production/backup-sqlite.mjs \
  --database /private/data/warm-letter.sqlite \
  --uploads /private/data/uploads \
  --destination /private/backups/warm-letter --retention 7
```

`VACUUM INTO` 生成含 WAL 已提交数据的一致快照，不能用直接复制运行中 `.sqlite` 替代。工具复制快照引用的 READY 素材和朗读，兼容两种对象存储格式；记录数据库与对象 SHA256，执行 `integrity_check`、`foreign_key_check`，再复制到独立恢复演练数据库验证可打开。它不会覆盖 live 数据。

素材不可变；若复制期间素材被删除，本次备份失败并丢弃不完整目录，之前成功的备份保留。需要重试与可见的失败告警，不能把失败当成功。轮转仅清理由本工具创建、有有效 manifest 且超过保留期的完整备份目录。建议每日运行的 systemd timer，备份根目录 `0700`。被删除的数据可能在受限备份中保留最多 7 天，应按项目隐私说明执行轮转，不应重新用于正常服务。

## 恢复

停写后，把一个完整备份的数据库与 uploads 复制到隔离目录，核对 manifest、数据库/对象哈希、完整性与外键，再切换服务指向恢复目录。不要直接覆盖在线数据库；不要把另一次备份的 uploads 混入。恢复旧快照可能恢复用户后来删除的数据，重新开放前需复核删除记录。

本机备份能应对误操作，不能覆盖整机/整盘丢失；异机加密备份是独立运维工作，当前不能声称跨区域容灾。首次切换原始内存快照含隐私，应在确认恢复与备份完成后按保留期限删除。

## 单实例限制

SQLite 支持事务与多连接并发，但当前生成队列、限流和中断恢复只按一个 API 进程设计。不要启用 PM2 cluster、多 Node worker 或多台服务器共享此数据库；横向扩展前需实现任务租约/队列、共享限流和对象存储。Node 的 SQLite experimental 提示不代表失败，运行时已锁定 Node 22.23.2。
