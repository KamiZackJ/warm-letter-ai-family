# 暖笺 DeepSeek 个性文案接入说明

## 先处理密钥安全

已经发到聊天、截图、群消息或 Git 仓库中的 API Key 应视为已泄露。请先到 DeepSeek 控制台撤销旧 Key，再创建一枚新 Key。新 Key 只能配置在 API 服务端环境变量中，不得写入 HTML、小程序、客户端 JavaScript、文档或 Git 提交。

## 服务端配置

复制 `.env.example` 为本机私有配置文件，并设置：

```env
DEPLOYMENT_MODE=demo
NODE_ENV=development
AI_PROVIDER=deepseek
AUTH_PROVIDER=development
DEEPSEEK_API_KEY=替换为新生成且未泄露的密钥
DEEPSEEK_MODEL=deepseek-chat
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_TIMEOUT_MS=60000
DEEPSEEK_MAX_RETRIES=2
```

`.env` 不得提交。线上部署时，在云服务的 Secret 或 Environment Variables 面板中配置同名变量。

安装依赖并启动 API：

```powershell
pnpm install
pnpm --filter @warm-letter/api dev
```

默认 API 地址是 `http://127.0.0.1:8787`。

## 让创作网页使用 AI

启动静态创作页后，在地址后添加 `api` 参数：

```text
http://127.0.0.1:4317/create.html?api=http://127.0.0.1:8787
```

未提供 `api` 参数时，页面只使用本地模板，并会如实标注“本地草稿”。提供参数时，页面会把用户填写的文字近况、独家细节、风格和禁用表达发送给暖笺 API，并显示“AI 个性润色”。照片仍只在浏览器本地预览。

`api` 参数仅在 `localhost` 或 `127.0.0.1` 页面生效，避免公开链接把用户文字发送到任意第三方服务器。线上部署时，把 `create.html` 中 `warm-letter-api` 元标签的 `content` 设置为经过审核的 HTTPS 后端地址，并把 GitHub Pages 域名加入后端 `CORS_ORIGINS`。不要把 API Key 放到 HTML 或 URL 参数中。

## 为什么每版文案会不同

后端会把草稿版本号传给模型，并在八种写作方向之间轮换，包括具体瞬间切入、口语消息、时间顺序、短段落留白和生活细节起笔。提示词要求改变切入点、段落组织和句式节奏，禁止只替换同义词，同时继续校验每段引用的用户素材，避免为了“个性”而编造事实。

## 当前能力边界

DeepSeek 文本模式只读取用户填写的文字。它不会读取或理解照片、截图和语音；后端遇到这些素材会明确拒绝生成，不会假装识图。需要“根据照片内容写信”时，应使用工程现有的多模态 OpenAI Provider，或先接入经过验证的视觉描述服务，再把经过用户确认的图片描述交给 DeepSeek 润色。

公开内测前还需要部署一个 HTTPS API 后端、配置限流和正式鉴权。GitHub Pages 只能托管静态网页，不能安全保存第三方 API Key。

DeepSeek 的兼容接口说明见官方文档：<https://api-docs.deepseek.com/>。
