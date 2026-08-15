# 暖笺·AI家书

“把今天，写给想念的人。”

暖笺是一款以微信小程序为创作端、H5 为收信端的 AI 家书工具。用户主动选择照片、截图、语音和文字素材，AI 生成带段落来源的可编辑草稿；只有用户确认后的版本才能发布，家人可通过短期分享链接阅读、播放原始语音并回复。

本仓库已经包含可离线运行的开发/比赛演示骨架（M1），而不只是设计资料；尚未通过 G2 用户测试、MVP、公测或生产放行。默认配置使用内存仓库、文件系统对象存储和确定性 Fake AI 演示业务链路；真实 OpenAI、微信生产鉴权、PostgreSQL、S3/OSS 和独立任务队列仍属于待接入项。

## 当前能力

- 原生微信小程序：素材选择、生成、编辑确认、阅读和回复流程。
- Fastify API：素材上传与校验、家书状态机、来源追溯、分享重签/撤销和回复。
- React H5：公开家书、真实图片与原始音频、系统朗读、来源展开、回复和失效状态。
- 共享契约：Zod 运行时校验、TypeScript 类型和状态转换规则。
- 自动化基线：全仓类型检查、合约/API 测试和生产构建；仓库同时提供 GitHub Actions 工作流，远端 CI 结果仍待发布后验证。

## 仓库结构

| 路径 | 说明 |
| --- | --- |
| `apps/miniprogram` | 微信小程序创作端与阅读端 |
| `apps/web` | H5 公开分享页 |
| `apps/api` | Fastify API、业务状态机、AI 与对象存储适配层 |
| `packages/contracts` | 跨端共享契约与状态规则 |
| `docs` | 架构、开发、验收清单和项目阶段状态 |

## 本地运行

需要 Node.js 22.20+ 和 pnpm 11+；仓库通过 `.node-version` 固定复验版本为 Node.js 22.23.2。

```powershell
pnpm install
pnpm check
pnpm build
```

分别启动 API 与 H5：

```powershell
pnpm dev:api
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

- [项目阶段状态](./docs/PROJECT_STATUS.md)
- [2026-08-16 阶段进度、计划与问题](./docs/PROGRESS_2026-08-16.md)
- [W1 阶段进度、计划与问题](./docs/W1_PROGRESS_2026-08-15.md)
- [验收清单](./docs/ACCEPTANCE_CHECKLIST.md)
- [架构基线](./docs/ARCHITECTURE.md)
- [开发说明](./docs/DEVELOPMENT.md)
- [参赛作品完整计划](./暖笺_AI家书_参赛作品完整计划.docx)

当前 H5 与本地 API 已具备独立短期媒体凭据、完整公开访问负面矩阵、单实例限流/内容兜底和真实浏览器证据；但真实 OpenAI 请求、微信 `code2Session`、持久化存储、跨实例共享限流、正式内容审核、微信真机双设备闭环及正式部署尚未完成。不得把本地演示结果表述为生产放行。

原始赛题文章：<https://mp.weixin.qq.com/s/GMdJc8OBWIDang5iQdj7rg>
