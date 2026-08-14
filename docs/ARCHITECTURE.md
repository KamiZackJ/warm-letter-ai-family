# 暖笺架构基线

## 1. 目标与边界

V1.0 交付一条可演示、可测试的核心链路：用户主动选择照片、聊天截图、语音、日程截图或文字，确认素材后生成带来源引用的家书草稿，编辑并确认，再由家人通过小程序或 H5 阅读和回复。

首版不直接读取微信聊天记录，不扫描完整相册，不克隆亲友声音。家庭成员管理、日历直连、复杂协作编辑和自动采集不进入 MVP。

## 2. 当前实现与模块边界

当前仓库是可离线演示的比赛 MVP：`apps/api` 使用 Fastify、内存仓库，默认使用确定性 Fake AI，也可通过环境变量启用 OpenAI Responses provider；生成任务在进程内异步执行，默认启动不依赖云端账号。PostgreSQL、对象存储和 Redis/BullMQ 是全量产品的生产适配层，不是当前演示的启动前置条件。

| 模块 | 职责 | 不负责 |
| --- | --- | --- |
| `apps/miniprogram` | 微信登录、素材选择、家书设置、草稿编辑、阅读和回复交互 | 持久化密钥、直接调用 AI、媒体渲染 |
| `apps/web` | H5 只读分享页和比赛演示备用入口 | 创建或修改家书 |
| `apps/api` | 鉴权、业务状态机、素材授权、内存持久化、异步任务和公开阅读令牌 | 前端展示、真实微信/云存储/AI 供应商绑定 |
| `packages/contracts` | 跨端 Zod 运行时校验、TypeScript 类型和家书状态转换规则 | 数据库实现、UI 状态、供应商 SDK |
| AI provider | 将已确认的规范化素材生成结构化草稿和来源引用 | 决定是否发送、绕过用户编辑确认 |
| 生产 Worker（后续） | 独立执行 AI 生成、长图、短片和发布任务 | 接受未经 API 鉴权的客户端调用 |
| PostgreSQL（后续） | 用户、素材元数据、家书、版本、分享链接、任务和回复记录 | 保存二进制素材 |
| 对象存储（后续） | 保存用户主动上传的原始素材与生成媒体 | 长期保存已删除或过期素材 |
| Redis/BullMQ（后续） | 任务排队、重试和短期进度 | 作为业务事实的唯一存储 |

API 和前端必须从 `@warm-letter/contracts` 导入契约，不得各自维护同名 DTO。数据库实体可以扩展内部字段，但不得把内部存储键、微信 openid、AI 提示词或审计内容加入公开响应。

## 3. 核心数据流

1. 小程序使用临时 code 登录，API 换取微信身份并返回本系统短期访问令牌。
2. 文件素材先请求预签名上传地址，客户端直传后调用完成接口；文字素材通过 `POST /v1/materials` 提交。当前 `memory://` 上传地址是对象存储适配器的演示替身。API 只把校验成功且属于当前用户的素材标为 `READY`。
3. 用户创建家书并选择素材。只有 `READY` 且未删除的素材能令家书进入 `MATERIALS_READY`。`screenshot` 在当前契约中同时表示聊天截图和日程截图，避免服务端推断图片内容。
4. 生成接口创建任务并将家书置为 `GENERATING`。AI provider 生成结构化 `LetterDraft`；成功后进入 `EDITING`，失败时恢复生成前状态供重试。生产版再把进程内任务替换为独立 Worker。
5. 用户编辑草稿。每个段落保存 `sourceRefs`，服务端验证引用均属于该家书素材集合。
6. 当前确认接口将内容复制为不可变 `confirmedDraft`，依次进入 `CONFIRMED` 和 `PUBLISHED` 并签发有期限的分享令牌。服务端只保存 token hash，支持重签和撤销；公开阅读接口只返回确认版本与脱敏来源，不返回对象键或用户内部字段。草稿版本并发保护、独立更短期媒体凭据、限流与内容安全仍待生产化。
7. 长图和短片后续均以同一确认版本创建异步渲染任务，禁止从未确认草稿单独生成另一份正文。

## 4. 隐私与一致性不变量

- 所有素材必须由用户逐项主动提供；客户端权限不得扩大为后台扫描或自动读取聊天记录。
- 所有素材读写均校验 owner；预签名地址应短期有效，公开阅读令牌与登录令牌分离。
- 删除素材后立即禁止生成任务继续读取，并异步清理对象存储；应用日志不得记录素材原文、访问令牌或签名 URL。
- AI 只接收当前家书已确认使用的素材。生成结果必须通过 `LetterDraftSchema`，保留 provider 和 AI 生成标注，段落 `sourceRefs` 只能引用当前素材集合。
- `CONFIRMED` 之后正文不可原地修改；修改需求必须复制为新草稿和新版本。
- `PUBLISHED` 是终态。读信页只能展示确认版本，不能因后台重新生成而漂移。
- 任务消费者必须幂等；重复投递不能创建多个草稿版本、回复或发布链接。

## 5. HTTP API 清单

| 方法与路径 | 契约 | 用途 |
| --- | --- | --- |
| `GET /health` | `HealthResponse` | 存活检查 |
| `POST /v1/auth/wx-login` | `WxLoginRequest/Response` | 微信登录；MVP 允许省略 code 使用本地账号 |
| `GET /v1/materials` | `ListMaterialsResponse` | 获取本人素材 |
| `POST /v1/materials` | `RegisterMaterialRequest/Response` | 演示直传素材或创建文字素材 |
| `POST /v1/materials/presign` | `CreateMaterialUploadRequest/Response` | 获取文件直传地址 |
| `POST /v1/materials/complete` | `CompleteMaterialUploadRequest/Response` | 完成文件素材校验 |
| `DELETE /v1/materials/:id` | `DeleteMaterialResponse` | 删除素材 |
| `POST /v1/letters` | `CreateLetterRequest/Response` | 创建家书 |
| `POST /v1/letters/:id/generate` | `GenerateLetterRequest/Response` | 空请求体，排队生成草稿 |
| `GET /v1/jobs/:id` | `GetJobResponse` | 查询异步任务 |
| `GET /v1/letters/:id` | `GetLetterResponse` | 获取编辑态家书 |
| `PATCH /v1/letters/:id` | `UpdateLetterRequest/Response` | 更新设置或草稿 |
| `POST /v1/letters/:id/confirm` | `ConfirmLetterRequest/Response` | MVP 冻结并立即发布，返回 readerUrl |
| `POST /v1/letters/:id/share/reissue` | `ReissueShareLinkResponse` | 撤销旧 token 并签发新 readerUrl |
| `DELETE /v1/letters/:id/share` | 空响应 | 撤销当前分享 |
| `GET /v1/letters/:id/reader` | `GetLetterReaderResponse` | 使用签名令牌读取公开版本 |
| `GET /v1/letters/:letterId/sources/:materialId/content` | 二进制媒体 | 使用当前分享 token 读取公开媒体 |
| `POST /v1/letters/:id/replies` | `CreateReplyRequest/Response` | 添加简单文字回复 |
| `GET /v1/letters/:id/replies` | `ListRepliesResponse` | 作者查看家人回复 |

所有错误统一返回 `ErrorResponse`。写接口必须校验请求体和鉴权；响应在离开 API 边界前再次通过对应 schema 校验。

### 5.1 当前 API 兼容约定

- `MaterialSchema` 与当前 API 一致使用 `userId/name/contentType/status`；私有素材响应中的 `objectKey/textContent` 仅供本人会话使用，前端不得写入日志、分析事件或公开页面。
- 当前草稿使用 `greeting + paragraphs + closing`，每个 paragraph 强制携带 `sourceRefs`。`provider` 是现有生成证据，`aiDisclosure` 是向 UI 渐进增加的显式 AI 标注字段。
- 当前生成任务只有 `status/error`；渲染类型、进度、重试次数和结果字段为可选扩展，接入独立队列后启用。
- 当前分享令牌随确认接口签发，服务端只存 token hash、`expiresAt` 和 `revokedAt`；`POST /v1/letters/:id/share/reissue` 轮换后旧 reader、旧媒体与旧回复入口立即失效，`DELETE /v1/letters/:id/share` 可显式撤销。当前公开媒体 URL 仍复用整份分享 token，生产版必须改为独立且更短期的媒体凭据。

## 6. MVP 验收标准

- 新用户能在 3 分钟内完成登录、添加至少一种素材、生成、编辑、确认和阅读一封家书。
- 五类主动素材入口均有契约和权限校验；超限、格式错误、已删除和不属于当前用户的素材会被拒绝。
- AI 生成、失败重试和用户重生成遵守状态机；重复任务不会产生重复业务结果。
- 草稿逐段保留来源引用，用户可以删除敏感段落或素材，未确认内容不会出现在阅读页。
- 长辈可使用大字阅读、播放已有语音并提交文字回复；无障碍字号下无关键内容溢出。
- 单元测试覆盖 schema 边界和状态转换；API 契约测试覆盖每条端点；端到端测试覆盖一次完整核心链路。
- 删除、令牌过期、越权访问、AI 超时和上传失败有可验证的失败行为，日志中不出现敏感原文。
- 小程序审核未完成时，H5 只读页与演示录屏仍可完成比赛展示。

## 7. 赛规倒推与证据清单

### 7.1 AI 核心服务

- 演示必须显示“用户主动选择素材 → AI 结构化生成 → 每段来源追溯 → 人工编辑确认”的连续过程，证明 AI 是核心内容整理能力而非装饰性功能。
- 生成页、阅读页和导出媒体统一展示“AI 辅助生成，经用户确认”标记；测试证据保留 provider、草稿版本和 `sourceRefs`，但演示材料不得暴露原始隐私内容。
- 真实 provider 接入必须继续实现相同 `AIProvider` 边界，输出先经过共享 schema 和来源归属校验，供应商切换不得改变客户端契约。

### 7.2 创新性、完成度与孵化潜力

- 创新性证据：展示主动授权、段落级来源引用、发送前人工确认，以及动态家书/长图/短片共用确认内容的设计。
- 完成度证据：保留自动化核心链路测试、四类素材实录、错误状态演示、长辈阅读与回复录屏，并记录演示版本 commit。
- 孵化潜力证据：说明内存仓库、Fake AI 和 `memory://` 分别可替换为 PostgreSQL、真实 AI 和对象存储；展示分享令牌生命周期、异步媒体任务和成本/留存指标的扩展契约。

### 7.3 演示、版权与合规

- 比赛演示至少留存：90 秒以内主流程视频、无网络备用录屏、可复现演示账号/素材、自动化测试结果和 H5 备用阅读链接。
- 所有照片、聊天截图和语音取得本人或相关权利人授权并做必要脱敏；演示不得使用真实私密聊天、身份证件、住址、手机号等信息。
- 字体、信纸、图标、音乐和视频素材建立来源台账，只使用自制、明确授权或许可范围覆盖参赛发布的资源；第三方许可证随提交版本归档。
- AI 生成的文字、图片、配音或短片在产品界面、导出物和发布说明中按平台规则标注；用户编辑确认记录不能替代 AI 标注。
- 上架前准备隐私政策、用户协议、素材删除说明、内容安全流程和未成年人保护检查；快手/小程序/iCAN 提交内容使用同一冻结版本交叉核验。

## 8. 全量产品演进

- **动态家书**：公开阅读模型扩展照片、原始语音、旁白和 BGM 时间轴；播放器仍只读取 `confirmedDraft` 对应的冻结内容版本，并保留大字模式和文字回复。
- **手书长图**：创建 `render_long_image` 任务，把确认版本、主题、字体许可和图片裁切参数渲染为 PNG；发布前自动检查文字溢出、图片缺失、AI 标注和二维码有效性。
- **家书短片**：创建 `render_video` 任务，由 FFmpeg 合成照片、字幕、授权音乐和旁白；任务结果记录内容版本、素材许可快照和渲染日志，失败可幂等重试。
- **分享与上架**：短链接只保存 token hash，支持过期、轮换和撤销；小程序审核、H5 备用页、演示视频和报名材料均引用同一发布版本，冻结后只允许新建版本，不覆盖已提交内容。
- **生产替换顺序**：先落地持久化和对象存储，再迁移独立任务队列与媒体 Worker，最后扩展家庭成员、历史归档和节日提醒；每一步继续复用 `@warm-letter/contracts` 并保留 Fake AI 的离线验收路径。
