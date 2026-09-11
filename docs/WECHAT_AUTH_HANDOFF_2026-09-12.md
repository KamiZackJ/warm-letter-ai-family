# 微信小程序接入阶段交接（2026-09-12）

## 本轮完成

- 小程序工程已写入真实 AppID：`wx281b5275e4a1601f`（`apps/miniprogram/project.config.json`）。
- API 新增微信官方 `jscode2session` 适配器：`apps/api/src/wechat-auth.ts`。
- `POST /v1/auth/wx-login` 在 `AUTH_PROVIDER=wechat` 时只接受微信 `code`，服务端换取身份后签发短期 `wx.*` 会话；不会回退到 `dev.*`。
- 微信会话只在当前 API 进程内保存 token 哈希，默认 30 天，最多保留 10,000 个会话；这是比赛/测试阶段实现，生产必须换成持久化会话或 JWT/Redis 方案。
- `session_key` 只在微信上游响应中短暂解析，立即丢弃，不写日志、不写数据库、不返回客户端。
- 已补充上游错误码、超时、异常 JSON、空 code 和登录路由测试。

验证结果：API `159/159` 测试通过，API 类型检查通过。当前本地运行 Node `v24.19.0`，仓库要求 Node `22.23.2`；版本警告不影响本轮测试结果。

## Secret 处理

本轮没有把 AppSecret 写入仓库、`.env.example`、小程序包、日志或 GitHub。聊天中出现过的 Secret 应视为已暴露，建议立即在微信公众平台重置；部署时只在后端环境变量或密钥管理器中配置新 Secret：

```text
AUTH_PROVIDER=wechat
WECHAT_APP_ID=wx281b5275e4a1601f
WECHAT_APP_SECRET=<在部署平台的 Secret 环境变量中填写>
WECHAT_AUTH_TIMEOUT_MS=5000
WECHAT_CODE2SESSION_ENDPOINT=https://api.weixin.qq.com/sns/jscode2session
```

不要把上述 Secret 填入 `apps/miniprogram`、GitHub Pages、前端 JavaScript、截图或文档。

## 还不能宣称完成的部分

1. 目前没有可用的公网 API；`api.warmjiashu.xyz` 仍需独立 HTTPS 后端、DNS 解析和微信合法域名配置。
2. `apps/miniprogram/src/config/env.ts` 的 `COMPETITION_API_BASE_URL` 与 `PRODUCTION_API_BASE_URL` 仍为空，避免小程序误连未部署地址。
3. 生产门禁仍会拒绝内存仓库、本地文件存储、确定性安全策略和其他开发适配器；微信登录适配器完成不等于生产放行。
4. 尚未用真实 `wx.login` code 做真机联调，也尚未完成双账号上传、生成、分享、媒体播放、回复和撤销的验收。

## 接手人下一步

1. 在后端平台创建独立服务，使用仓库 `apps/api` 的 `pnpm build` / `pnpm start`，并把临时目录放在部署平台的持久化卷或对象存储，不要把用户媒体放 GitHub。
2. 配置 `DEPLOYMENT_MODE=competition`、`NODE_ENV=production`、`AUTH_PROVIDER=wechat`、真实 AI 凭据、`MEDIA_SIGNING_KEYS` 和 HTTPS `PUBLIC_BASE_URL`；当前仍需 OpenAI、PostgreSQL、OSS/S3、队列和内容审核适配器才能进一步接近生产。
3. 将 API 根地址（含 `/v1`）填入 `COMPETITION_API_BASE_URL`，重新运行小程序 typecheck，再在微信开发者工具的 trial 环境验证 `/health` 返回 `deploymentMode=competition`。
4. 在微信公众平台配置 request/uploadFile/downloadFile 合法域名为同一 HTTPS API 域名，提交隐私保护指引和素材删除说明。
5. 真机验证通过后，再填写 `PRODUCTION_API_BASE_URL` 并申请 release；在此之前不要把 release 作为可用环境对外宣传。

## 当前可复现命令

```powershell
pnpm --filter @warm-letter/api typecheck
pnpm --filter @warm-letter/api test
pnpm --filter @warm-letter/miniprogram typecheck
git diff --check
```
