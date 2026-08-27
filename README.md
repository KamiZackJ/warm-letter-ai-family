# 暖笺·AI家书

“把今天，写给想念的人。”

暖笺是一款以微信小程序为创作端、H5 为收信端的 AI 家书工具。用户主动选择照片、截图、语音和文字素材，AI 生成带段落来源的可编辑草稿；只有用户确认后的版本才能发布，家人可通过短期分享链接阅读、播放原始语音并回复。

本仓库已经包含可离线运行的开发/比赛演示骨架（M1），而不只是设计资料；尚未通过 G2 用户测试、MVP、公测或生产放行。默认配置使用内存仓库、文件系统对象存储和确定性 Fake AI 演示业务链路；真实 OpenAI、微信生产鉴权、PostgreSQL、S3/OSS 和独立任务队列仍属于待接入项。

## 当前能力

- 原生微信小程序：素材选择、生成、编辑确认、阅读和回复流程。
- Fastify API：素材上传与校验、家书状态机、来源追溯、分享重签/撤销和回复。
- React H5：受控 CASE-001 模式可加载队友真实图片与原始音频；默认开发模式使用合成脱敏素材，并提供系统朗读、来源展开、回复和失效状态。
- 共享契约：Zod 运行时校验、TypeScript 类型和状态转换规则。
- 自动化基线：Node `22.23.2` 下当前工作树 contracts `17`、Web `75`、小程序 `125`、API `138`，共 `355` 项；本地类型检查、构建和 production bundle 校验均通过。远端链接保留为历史 CI 证据，当前交接口径以 [`docs/CURRENT_HANDOFF_STATUS_2026-08-28.md`](./docs/CURRENT_HANDOFF_STATUS_2026-08-28.md) 为准。

## 仓库结构

| 路径 | 说明 |
| --- | --- |
| `apps/miniprogram` | 微信小程序创作端与阅读端 |
| `apps/web` | H5 公开分享页 |
| `apps/api` | Fastify API、业务状态机、AI 与对象存储适配层 |
| `packages/contracts` | 跨端共享契约与状态规则 |
| `docs` | 架构、开发、验收清单和项目阶段状态 |

## 本地运行

固定使用 Node.js `22.23.2` 和 pnpm `11.19.0`；Node 24 不在当前支持范围。

```powershell
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm check
pnpm build
```

API 与 H5 都是常驻进程，请分别在两个 PowerShell 窗口启动：

```powershell
# 窗口 1
pnpm dev:api
```

```powershell
# 窗口 2：优先加载 D:\tmp 中已核验的队友 CASE-001；找不到时才回退脱敏演示
pnpm dev:web
```

如需明确启动不含真实媒体的脱敏演示，可使用：

```powershell
pnpm dev:web:synthetic
```

团队内部要看队友 CASE-001 的真实照片和原始语音，直接运行下面的一键入口（媒体来自 D 盘受控包，启动时会校验 SHA-256）：

```powershell
pnpm dev:web:case-001
```

也可以直接转发 `D:\tmp\warm-letter-ai-family\暖笺_CASE-001_受控团队成果包_2026-08-28.zip`。解压后双击根目录 `index.html`，即可看到队友真实照片的隐私裁切图、原始 m4a、A/B/C 固定审核稿、来源证据和确认/阅读/回复流程；ZIP SHA-256 为 `1ce227e3b90734674dd128c0cbbbe650bb89ddd79bc1a00e2837db2cf4610954`。

- API 健康检查：`http://127.0.0.1:8787/health`
- H5：`http://127.0.0.1:4173/`
- 小程序：使用微信开发者工具导入 `apps/miniprogram`。

`pnpm dev:web` 会优先发现并加载 D:\tmp 中的队友 CASE-001 受控包；页面会显示“队友成果已接入”并在启动时校验照片、语音和审核稿 SHA-256。找不到受控包时才回退到合成脱敏演示，并明确标注“未加载队友真实媒体”。需要显式指定受控目录时，也可以使用
[`scripts/start-controlled-case-reader.ps1`](./scripts/start-controlled-case-reader.ps1)；它从 D 盘受控包的
`media/` 目录读取已核验的裁切照片和原始 m4a，启动时校验 SHA-256，不会把媒体复制进仓库。

小程序通过 `apps/miniprogram/src/config/env.ts` 显式解析 `deploymentMode`、`apiMode` 和
`apiBaseUrl`：无微信运行时的自动化测试使用 `test + mock`，微信 `develop` 映射到 `demo`，
`trial` 映射到 `competition`，`release` 映射到 `production`。真实 API 模式按
`presign -> uploadBinary -> complete` 上传素材；`presign`/`complete` 使用 API Bearer，
外部 PUT 只携带 presign 返回的上传 headers，不得转发 `Authorization` 或 Cookie。当前
环境变量只覆盖已实现的本地与 OpenAI 适配，示例见 `.env.example`；微信生产鉴权、
PostgreSQL、S3/OSS 和独立任务队列仍需实现并接入。

## 进度与边界

- [2026-08-28 当前交接状态（接手人先看这里）](./docs/CURRENT_HANDOFF_STATUS_2026-08-28.md)
- [受控 CASE-001 融合演示（团队内部主展示入口）](./docs/CONTROLLED_CASE_DEMO.md)
- [队友材料融合映射与接手说明](./docs/TEAMMATE_MATERIAL_INTEGRATION_2026-08-28.md)
- [可搬家压缩包目录说明（全部使用相对路径）](./docs/presentation/PORTABLE_BUNDLE_LAYOUT.md)
- [团队成果展示入口（优先受控 CASE-001，含脱敏开发入口）](./暖笺_互动产品演示.html)
- [阶段成果展示中心（汇报入口，直达受控实材包）](./暖笺_阶段成果展示.html)
- [2026-08-26 阶段性交接说明（历史快照）](./docs/HANDOFF_2026-08-26.md)
- [2026-08-25 阶段成果汇报包（队内展示入口）](./docs/PHASE_DELIVERY_REPORT_2026-08-25.md)
- [队内 10 分钟演示手册](./docs/INTERNAL_DEMO_RUNBOOK_2026-08-25.md)
- [CASE-001 脱敏固定案例快照](./docs/evidence/2026-08-25/CASE_001_SAFE_SNAPSHOT.md)
- [当前进度、推进计划与问题清单（2026-08-16）](./docs/CURRENT_PROGRESS_PLAN_ISSUES_2026-08-16.md)
- [项目阶段状态](./docs/PROJECT_STATUS.md)
- [2026-08-16 阶段进度、计划与问题](./docs/PROGRESS_2026-08-16.md)
- [W1 阶段进度、计划与问题](./docs/W1_PROGRESS_2026-08-15.md)
- [验收清单](./docs/ACCEPTANCE_CHECKLIST.md)
- [外部验收与参赛取证手册](./docs/evidence/EXTERNAL_VALIDATION_RUNBOOK.md)
- [架构基线](./docs/ARCHITECTURE.md)
- [开发说明](./docs/DEVELOPMENT.md)
- [参赛作品完整计划](./暖笺_AI家书_参赛作品完整计划.docx)

当前 H5 与本地 API 已具备独立短期媒体凭据、完整公开访问负面矩阵、单实例限流/内容兜底和真实浏览器证据；但真实 OpenAI 请求、微信 `code2Session`、持久化存储、跨实例共享限流、正式内容审核、微信真机双设备闭环及正式部署尚未完成。不得把本地演示结果表述为生产放行。

原始赛题文章：<https://mp.weixin.qq.com/s/GMdJc8OBWIDang5iQdj7rg>
