# 暖笺·AI家书

“把今天，写给想念的人。”

暖笺是一款以微信小程序为创作端、H5 为收信端的 AI 家书工具。用户主动选择照片、截图、语音和文字素材，AI 生成带段落来源的可编辑草稿；只有用户确认后的版本才能发布，家人可通过短期分享链接阅读、播放原始语音并回复。

本仓库已经包含可离线运行的开发/比赛演示骨架（M1），而不只是设计资料；尚未通过 G2 用户测试、MVP、公测或生产放行。默认配置使用内存仓库、文件系统对象存储和确定性 Fake AI 演示业务链路；真实 OpenAI、微信生产鉴权、PostgreSQL、S3/OSS 和独立任务队列仍属于待接入项。

## 当前能力

- 原生微信小程序：素材选择、生成、编辑确认、阅读和回复流程。
- Fastify API：素材上传与校验、家书状态机、来源追溯、分享重签/撤销和回复。
- React H5：公开家书、真实图片与原始音频、系统朗读、来源展开、回复和失效状态。
- 共享契约：Zod 运行时校验、TypeScript 类型和状态转换规则。
- 自动化基线：Node `22.23.2` 下 contracts `17`、Web `70`、小程序 `125`、API `135`，共 `347` 项；类型检查、生产构建和 production bundle 校验均已纳入 GitHub Actions。实现基线 `f60e759` 的 [push CI](https://github.com/KamiZackJ/warm-letter-ai-family/actions/runs/33095266241) 与 [PR CI](https://github.com/KamiZackJ/warm-letter-ai-family/actions/runs/33095270181) 均通过。

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
# 窗口 2
pnpm dev:web
```

- API 健康检查：`http://127.0.0.1:8787/health`
- H5：`http://127.0.0.1:4173/`
- 小程序：使用微信开发者工具导入 `apps/miniprogram`。

小程序通过 `apps/miniprogram/src/config/env.ts` 显式解析 `deploymentMode`、`apiMode` 和
`apiBaseUrl`：无微信运行时的自动化测试使用 `test + mock`，微信 `develop` 映射到 `demo`，
`trial` 映射到 `competition`，`release` 映射到 `production`。真实 API 模式按
`presign -> uploadBinary -> complete` 上传素材；`presign`/`complete` 使用 API Bearer，
外部 PUT 只携带 presign 返回的上传 headers，不得转发 `Authorization` 或 Cookie。当前
环境变量只覆盖已实现的本地与 OpenAI 适配，示例见 `.env.example`；微信生产鉴权、
PostgreSQL、S3/OSS 和独立任务队列仍需实现并接入。

## 进度与边界

- [2026-08-28 当前交接状态（接手人先看这里）](./docs/CURRENT_HANDOFF_STATUS_2026-08-28.md)
- [互动产品演示（主展示入口，双击即可离线打开）](./暖笺_互动产品演示.html)
- [2026-08-26 阶段性交接说明（历史快照）](./docs/HANDOFF_2026-08-26.md)
- [暖笺阶段成果展示中心（双击根目录即可离线打开）](./暖笺_阶段成果展示.html)
- [可搬家压缩包目录说明（全部使用相对路径）](./docs/presentation/PORTABLE_BUNDLE_LAYOUT.md)
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
