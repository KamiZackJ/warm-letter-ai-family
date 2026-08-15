# 暖笺微信小程序

原生微信小程序 MVP，默认使用本地 mock 数据，可在没有 API 服务和云端凭据时演示完整流程。

## 运行

1. 打开微信开发者工具，选择“导入项目”。
2. 项目目录选择本目录 `apps/miniprogram`。
3. AppID 可使用测试号；`project.config.json` 默认配置为 `touristappid`。
4. 编译后从首页选择“写一封家书”，或选择“快速演示完整流程”。

静态检查：

```powershell
pnpm --filter @warm-letter/miniprogram typecheck
```

## 演示路径

“快速演示完整流程”会展示一键样例素材和预填创作意图。推荐录屏顺序：

1. 加入演示素材，展示照片、语音和文字都由用户主动选择。
2. 生成草稿，展示“AI 辅助生成”和每段“内容依据”。
3. 修改一段正文并确认，证明用户拥有最终决定权。
4. 在阅读页切换“大字/特大”字号，展示素材来源并发送一条家人回复。

这条路径通常可在 1-2 分钟内完成，所有操作与正常创作流程共用相同的数据和页面逻辑。

## API 模式

[`src/config/env.ts`](src/config/env.ts) 显式配置 `deploymentMode`、`apiMode` 和 `apiBaseUrl`。
微信版本映射为 `develop -> demo`、`trial -> competition`、`release -> production`；只有
`test` 部署模式允许 `apiMode: "mock"`，其余模式必须连接真实 API。Demo 默认可连接本机
`http://127.0.0.1:8787/v1`；competition 和 production 必须使用与服务端 `/health`
握手一致的非回环 HTTPS 环境，且 production 当前仍由服务端门禁拒绝启动。

当前真实 API 适配器按 `presign -> uploadBinary -> complete` 流程上传照片、截图和语音，
并通过公开 reader 返回的媒体地址预览或播放。`presign` 与 `complete` 使用暖笺 API Bearer
鉴权；外部上传 PUT 只转发 `presign` 返回的 headers，不得携带登录 `Authorization` 或
Cookie。Demo 素材与微信临时媒体路径不得作为真实用户素材、真实 AI 调用或生产证据。
