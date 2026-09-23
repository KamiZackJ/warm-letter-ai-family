# Ubuntu 正式 API 部署

本目录用于阿里云中国香港轻量服务器（Ubuntu 24.04），不包含凭据。当前分支为 `codex/warm-letter-mvp`，运行时为 Node.js `22.23.2`、pnpm `11.19.0`、单 API 进程、systemd 和 Caddy。

## 当前状态（2026-09-23）

- 公网 API：`https://api.warmjiashu.xyz`；后端运行 `4cf6a6f`，包含 `09ab236` 微信回调诊断修复，模式为 `production + SQLite`。最新 API 全量 361 项测试通过。
- 微信真实登录、Qwen 文字/图片理解、语音转写、家书整理和可选朗读已接入。内容安全使用微信真实文本检查与图片/录音异步审核，回调由正式 API 接收。
- 旧内存记录迁移失败后，用户明确旧记录只有测试数据并指示继续，服务启用了新 SQLite。原始上传文件约 15 MB 已备份保全；这不代表旧记录已恢复。
- 两封新家书与 3 个关联媒体对象已完成备份及独立数据库恢复校验。部署重启后完整性正常、计数未减少，原会话、草稿、匿名读信和朗读引用仍可用。
- 当前媒体审核回调仍返回 `-1008`（微信下载失败），含这些素材的确认请求返回 `CONTENT_SAFETY_UNAVAILABLE`，保持禁止分享。自有公网下载 200、MIME、文件头和证书正常不能替代微信审核通过，TLS 下载兼容性仍在调查。
- 小程序 `1.0.0` 已上传为体验版，未提交代码审核、未正式发布，手机完整验收未完成。部署正式后端不等于小程序正式上架。

持续更新的验收和故障事实见[1.0.0 发布记录](../../docs/PRODUCTION_RELEASE_1_0_0_2026-09-23.md)。9 月 15–16 日的非生产状态仅作为[旧部署交接记录](../../docs/API_DEPLOYMENT_HANDOFF_2026-09-15.md)及[供应商探针历史](../../docs/REAL_AI_PROVIDER_HANDOFF_2026-09-15.md)，不覆盖本页当前状态。

API 的 Caddy 配置已补 `default_sni api.warmjiashu.xyz` 和 `key_type rsa2048`，生产已取得新的 RSA 2048 位可信证书，并验证带/不带 SNI 的 TLS 1.2 RSA 握手及 HTTPS 健康检查。仍保持加密与证书校验；这两项兼容调整后的微信实测仍返回 `-1008`，不能写成根因已修复。`key_type` 不会立即替换缓存中的有效旧证书；本次受控续签的临时周期及 systemd 启动覆盖均已恢复，不应在日常运行保留高频续签配置。

## 正式配置与持久目录

运行中的环境文件为 `/etc/warm-letter/api.env`，由 `root:root` 持有、权限 `0600`。仓库内的 [api.env.example](./api.env.example) 和根目录 `.env.example` 仍采用旧 `demo/fake` 默认值，且未列全生产字段；只能参考字段说明，不能直接复制覆盖正式配置。

配置要求以 [runtime-config.ts](../../apps/api/src/runtime-config.ts)、[server.ts](../../apps/api/src/server.ts) 和 [speech.ts](../../apps/api/src/speech.ts) 为准。当前 Qwen 正式配置的非秘密部分如下：

```dotenv
DEPLOYMENT_MODE=production
NODE_ENV=production
PRODUCTION_SINGLE_INSTANCE=true
HOST=127.0.0.1
PORT=8787
PUBLIC_BASE_URL=https://api.warmjiashu.xyz
CORS_ORIGINS=https://warmjiashu.xyz,https://www.warmjiashu.xyz,https://kamizackj.github.io
DATABASE_PATH=/var/lib/warm-letter/warm-letter.sqlite
UPLOAD_DIR=/var/lib/warm-letter/uploads
AUTH_PROVIDER=wechat
WECHAT_APP_ID=wx281b5275e4a1601f
AI_PROVIDER=openai-compatible
OPENAI_COMPATIBLE_MODEL=qwen3.8-flash
OPENAI_COMPATIBLE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
OPENAI_COMPATIBLE_IMAGE_MODE=native
OPENAI_COMPATIBLE_AUDIO_MODE=streaming-chat-transcription
OPENAI_COMPATIBLE_TRANSCRIPTION_MODEL=qwen3.5-omni-flash
OPENAI_COMPATIBLE_JSON_MODE=json-object
OPENAI_COMPATIBLE_IMAGE_DETAIL=omit
OPENAI_COMPATIBLE_STORE_MODE=omit
OPENAI_COMPATIBLE_VERIFICATION_PROFILE=dashscope-qwen-2026-09-16
```

还必须在服务器私密环境文件中设置以下值，本文不提供实际密钥：

| 字段 | 要求 |
| --- | --- |
| `WECHAT_APP_SECRET` | 对应当前 AppID 的服务端密钥，用于登录和微信内容安全 |
| `OPENAI_COMPATIBLE_API_KEY` | 阿里云百炼服务端密钥，不下发客户端 |
| `MEDIA_SIGNING_KEYS` | 一个或多个逗号分隔的规范 Base64URL 密钥，每个解码后至少 32 字节；部署时保留稳定值 |
| `WECHAT_MESSAGE_TOKEN` | 与微信后台一致，3–32 位字母数字 |
| `WECHAT_ENCODING_AES_KEY` | 与微信后台一致的 43 字符 EncodingAESKey，用于验证加密回调 |

微信消息推送地址为 `https://api.warmjiashu.xyz/v1/wechat/messages`，配置安全模式与 JSON。可选 `QWEN_TTS_API_KEY` 用于独立朗读密钥；未设置时，代码可复用 DashScope 的 `OPENAI_COMPATIBLE_API_KEY`，默认模型为 `qwen3-tts-flash`。正式环境必须使用绝对持久数据库和上传路径；`DATABASE_URL` 不能代替 `DATABASE_PATH`。不要把数据库、密钥、回调密文、分享凭据或原始素材写入 Git、日志输出或截图。

`warmletter` 用户须可写 `/var/lib/warm-letter` 中的数据库、WAL、上传和转码临时目录；私密目录使用 `0700`、数据库使用 `0600`。生产上传上限由代码限制为至多 10 MiB。服务器必须安装 `ffmpeg`，用于把支持的录音规范化后送审；现有 bootstrap 尚不负责安装它。

## 首次安装与后续更新

[bootstrap.sh](./bootstrap.sh) 仅用于首次安装：安装 Node/pnpm/Caddy、必要时创建 swap、构建 API，并安装及重启服务。它会替换 systemd/Caddy 配置；现有生产服务器不要把它当作日常更新脚本。脚本默认分支仍是 `master`，首次使用必须显式指定当前分支：

```bash
sudo install -m 0755 /opt/warm-letter-ai-family/deploy/ubuntu/bootstrap.sh /tmp/warm-letter-bootstrap.sh
sudo WARM_LETTER_BRANCH=codex/warm-letter-mvp bash /tmp/warm-letter-bootstrap.sh
```

执行前需完成 DNS、私密正式环境文件、`ffmpeg` 和持久目录权限配置，并检查待安装的 Caddy 配置是否适合目标主机。上述命令不会替你配置微信后台、创建备份定时器或完成真机验收。

现有 SQLite 发布采用“隔离构建目标提交 → 一致备份并核验 → 替换构建产物并重启单进程 → 健康和原记录检查”的顺序，保留 `/etc/warm-letter/api.env`、数据库、uploads 与服务器现有 Caddy 配置。不要再次运行内存导出/导入、创建空库或删除旧库。回退也应使用兼容现有 SQLite 的代码和已核验备份，不能退回纯内存服务。

只有从仍存活的旧 MemoryRepository 首次迁移时，才按[迁移工具说明](../../scripts/production/README.md)使用 `scripts/production/export-live-memory.mjs` 和 `import-memory-snapshot.mjs`；导出验证完成前不得停止旧进程。当前服务器已经使用 SQLite，不适用该迁移步骤。

## 备份、恢复与单实例边界

备份工具为 `scripts/production/backup-sqlite.mjs`，当前服务器定时单元为 `warm-letter-backup.service` / `warm-letter-backup.timer`，备份目录为 `/var/backups/warm-letter`。定时器配置每天北京时间 03:20，加最多 5 分钟随机延迟；保留最多 7 天。服务器单元由本次部署安装，未包含在本目录的 bootstrap 中。

手动执行一致备份：

```bash
sudo /usr/local/bin/node /opt/warm-letter-ai-family/scripts/production/backup-sqlite.mjs \
  --database /var/lib/warm-letter/warm-letter.sqlite \
  --uploads /var/lib/warm-letter/uploads \
  --destination /var/backups/warm-letter --retention 7
```

工具使用 `VACUUM INTO`，复制快照关联媒体、核对哈希并执行独立数据库恢复校验；不能用直接复制运行中 `.sqlite` 替代。恢复时先停写，在隔离目录校验同一次备份的数据库与媒体再切换，不能直接覆盖在线数据库。详细步骤见[备份与恢复说明](../../scripts/production/README.md)。

当前任务队列和限流只支持一个 API 进程，不启用 PM2 cluster、多 worker 或多个实例共享数据库。本机备份不能应对整机/整盘丢失，不能宣称异地容灾。

## 部署验证

```bash
systemctl status warm-letter-api --no-pager
caddy validate --config /etc/caddy/Caddyfile
curl --fail https://api.warmjiashu.xyz/health
systemctl list-timers warm-letter-backup.timer --no-pager
journalctl -u warm-letter-backup.service -n 30 --no-pager
```

健康响应必须匹配当前正式配置：

| 字段 | 预期值 |
| --- | --- |
| `deploymentMode` / `nonProduction` | `production` / `false` |
| `capabilities.repository` / `objectStorage` | `sqlite` / `local-filesystem` |
| `capabilities.authentication` / `authenticationReady` | `wechat` / `true` |
| `capabilities.contentSafety` / `replySafety` | `wechat-text-and-media` / `wechat` |
| `capabilities.ai` | `openai-compatible` |
| `capabilities.aiInputs.configured` | text/image 为 `native`，audio 为 `transcription` |
| `capabilities.aiInputs.verification` | `profile-match` |
| `capabilities.speech` | `qwen3-tts-flash` |

健康检查表示服务运行及配置匹配，不证明每次外部调用成功。更新后还要检查已有会话、草稿、匿名读信、媒体引用、备份结果与真实微信媒体审核；当前 `-1008` 未解决前不能把媒体分享验收或正式发布标记完成。
