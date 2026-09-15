# 暖笺微信小程序

原生微信小程序 MVP。无微信运行时的自动化测试使用本地 mock；微信开发版连接暖笺公网演示 API。

## 运行

1. 打开微信开发者工具，选择“导入项目”。
2. 项目目录选择本目录 `apps/miniprogram`。
3. `project.config.json` 已配置项目 AppID `wx281b5275e4a1601f`；接手人若使用其他小程序，须在本地替换为自己的 AppID。
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
微信 `develop` 与 `trial` 均映射到当前非生产 `demo` API，分别用于开发联调和体验版验收；
`release` 映射到尚未配置的 `production`，因此正式版会失败关闭而不会回退演示服务。只有
`test` 部署模式允许 `apiMode: "mock"`。体验版强制使用真实 AppID、非回环 HTTPS API，
并与服务端 `/health` 的 `demo` 模式握手一致。

公网服务当前是 `demo + WeChat code2Session + Qwen 双模型`，仅供开发版和体验版联调，
不是生产服务。微信公众平台已经把 `https://api.warmjiashu.xyz` 配置为 request、uploadFile
和 downloadFile 合法域名；仍需用真机完成素材、生成、确认、阅读和回复连续验收。

当前真实 API 适配器按 `presign -> uploadBinary -> complete` 流程上传照片、截图和语音，
并通过公开 reader 返回的媒体地址预览或播放。`presign` 与 `complete` 使用暖笺 API Bearer
鉴权；外部上传 PUT 只转发 `presign` 返回的 headers，不得携带登录 `Authorization` 或
Cookie。Demo 素材与微信临时媒体路径不得作为真实用户素材、真实 AI 调用或生产证据。
