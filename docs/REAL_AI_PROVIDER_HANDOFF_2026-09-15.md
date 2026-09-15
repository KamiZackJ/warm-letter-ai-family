# 真实 AI Provider 探测与上线交接（2026-09-15，9 月 16 日更新）

## 当前结论

- 2026-09-16，公网非生产 API 已切换为精确的 Qwen 双模型配置；私密环境已先备份，密钥仅保存在服务器 `/etc/warm-letter/api.env`。
- 2026-09-16，阿里云百炼北京地域 OpenAI-compatible 端点的 Qwen 双模型组合已通过供应商探针和代码级合成多模态闭环。
- 已验证组合固定为 `qwen3.8-flash` 负责文字、图片与结构化家书，`qwen3.5-omni-flash` 负责流式语音转写。
- 队友提供且核验为“仅用于转写”的 M4A 已单独完成转写探针；未向模型发送队友原始照片，也未把该单项结果冒充完整真实素材端到端。
- 健康检查标记为 `profile-match`，服务器随后完成一次约 97.5 秒的合成文字、图片和音频真实调用，证明切换时凭据、网络和供应商运行时可用；这仍不证明持续可用，也不等于任意用户图片的小程序闭环、正式隐私审核、费用验收或生产放行。
- 2026-09-15 探测的 Gemini-labelled 第三方代理仍判定不可用；其模型列表可访问，但三个文本推理请求均失败。
- 探针密钥在协作会话中提供过，必须视为已暴露并轮换；任何实际密钥都不得进入仓库。

## Qwen 已验证配置

完整代码链路使用仓库自带的无隐私合成文字、图片和 WAV；另用队友授权示例 M4A 只验证转写。验证结论只适用于下表中的完整组合，不能外推到其他地域、模型、接口模式或字段设置。

| 项目 | 已验证值 | 作用 |
| --- | --- | --- |
| Compatible endpoint | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 阿里云百炼北京地域兼容模式端点 |
| 家书模型 | `qwen3.8-flash` | 非流式 Chat Completions；草稿生成与事实审校各调用一次 |
| 图片模式 | `native` | 照片和截图以 `image_url` data URL 进入家书模型 |
| 语音模式 | `streaming-chat-transcription` | 先流式转写，再把转写文字交给家书模型 |
| 转写模型 | `qwen3.5-omni-flash` | 只负责语音转写，不直接生成家书 |
| JSON 模式 | `json-object` | 请求结构化 JSON，响应仍由本地 schema 和来源规则校验 |
| 图片 detail | `omit` | 不发送兼容端点不需要的 `detail` 字段 |
| store 模式 | `omit` | 不发送 `store` 字段；不代表供应商不留存数据 |
| 媒体总量上限 | `12582912` bytes | 每次生成所选图片与音频合计 12 MiB，超限在远端调用前拒绝 |
| 转写字符上限 | `12000` | 流式转写超过 12,000 个 Unicode 字符即中止 |
| 验证档案 | `dashscope-qwen-2026-09-16` | 将竞争模式锁定到本次实际探测过的完整组合 |

流式转写代码接受 MP3、WAV、M4A 和 AAC。队友示例 M4A（148,876 bytes）返回了与人工事实基准一致的“开会有点累、外卖附送饮品让人开心”原意；没有做人声识别、克隆或身份推断。这不表示所有编码器、码率和损坏文件都已通过。图片与语音仍属于可能含个人信息的素材，单项探针不能解除授权和隐私门禁。

同日还从编译后的真实 Provider 代码执行完整合成闭环：本机探针约 112 秒；公网服务器切换后的复验约 97.5 秒。两次均由 `qwen3.5-omni-flash` 流式转写仓库合成 WAV，再由 `qwen3.8-flash` 联合读取合成图片、转写和文字，完成草稿生成与第二轮事实审校，三份素材 ID 均进入最终 `sourceRefs`。脱敏结果保存在本机 `D:\tmp\warm-letter-ai-family\qwen-provider-e2e-result.json` 和服务器受控数据目录，不进入公开 Git；密钥未写入结果。

`OPENAI_COMPATIBLE_IMAGE_DETAIL=omit` 与 `OPENAI_COMPATIBLE_STORE_MODE=omit` 的含义都是“不发送该请求字段”。尤其是 `STORE_MODE=omit`，它不是“供应商承诺零留存”的证据；留存、训练使用、跨境传输和删除仍以正式条款及团队审核为准。

## 历史失败探测

2026-09-15 曾探测第三方代理 `https://api.genshinsekai.pro/v1`，且没有发送真实项目素材：

| 探测 | 结果 | 判定 |
| --- | --- | --- |
| `GET /models` | 使用测试凭据鉴权成功 | 只证明凭据可访问模型目录 |
| 模型目录 | 列出 `gemini-3.8-flash`、`gemini-3.7-flash`、`gemini-3.1-pro-preview` | 不证明存在可用推理通道 |
| 三个模型的 `POST /chat/completions` | 均返回 HTTP `503`、`code=model_not_found` | 当前分组没有可用渠道，停止后续探测 |

因此没有继续该代理的图片或语音测试，也没有向它发送队友照片、语音或其他真实素材。模型 ID 和“Gemini”名称只来自代理返回值，没有建立其与 Google 官方 Gemini API 的运营、授权或服务质量关系。

## 证据边界

当前可以确认：

- Qwen 精确双模型配置已完成供应商合成探针；
- 编译后 Provider 已完成一次合成图片、WAV、文字的双模型完整生成与审校闭环；
- 队友授权 M4A 已完成仅转写探针，语义与人工事实基准一致；
- 适配器会执行“生成 + 事实审校”两次家书模型调用；
- 图片、WAV/M4A 流式转写、JSON 输出和本地来源校验存在可运行路径；
- 代码会限制媒体总字节数和转写字符数；
- 竞争模式会拒绝配置漂移或仅口头声明的多模态能力。
- 公网非生产 API 已切换 Qwen，服务器合成多模态探针通过；
- 微信后台 request、uploadFile、downloadFile 合法域名均为 `https://api.warmjiashu.xyz`。

当前仍未确认：

- 轮换为未在协作会话中出现的新密钥；
- 用户任意选择照片、文字和录音后的同一封家书完整 E2E；
- 小程序上传、真实 AI、编辑确认、分享、另一设备阅读与回复的连续录像；
- 供应商正式隐私条款、删除机制、配额、费用上限和故障 SLA；
- 公网服务持续稳定性、实际费用和回滚演练。

## 密钥处理

用于当前非生产演示的密钥曾在协作会话中提供，已经作为临时凭据写入服务器，但没有进入仓库、小程序包或证据结果。扩大体验范围或生产使用前必须在供应商后台撤销并轮换。

新密钥只能在其余上线门禁通过后，通过私密渠道写入服务器 `/etc/warm-letter/api.env`。该文件保持 `root:root` 和 `0600`。禁止把密钥写入：

- Git 仓库、提交记录、Issue、文档或环境变量示例；
- 小程序、静态页面、客户端包或 GitHub Actions 明文配置；
- URL、截图、聊天消息、演示录屏或测试报告；
- 可被普通用户读取的日志、shell 命令参数或命令历史。

仓库中的 `OPENAI_COMPATIBLE_API_KEY=` 只能为空或使用明显的占位文字。

## 上线候选配置

以下是当前公网非生产 API 使用、并通过服务器合成探针的精确配置；示例故意省略真实密钥。轮换后的新密钥也只能写入服务器私密环境文件：

```env
AI_PROVIDER=openai-compatible
OPENAI_COMPATIBLE_API_KEY=replace-with-a-new-server-side-secret
OPENAI_COMPATIBLE_MODEL=qwen3.8-flash
OPENAI_COMPATIBLE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
OPENAI_COMPATIBLE_IMAGE_MODE=native
OPENAI_COMPATIBLE_AUDIO_MODE=streaming-chat-transcription
OPENAI_COMPATIBLE_TRANSCRIPTION_MODEL=qwen3.5-omni-flash
OPENAI_COMPATIBLE_JSON_MODE=json-object
OPENAI_COMPATIBLE_IMAGE_DETAIL=omit
OPENAI_COMPATIBLE_STORE_MODE=omit
OPENAI_COMPATIBLE_VERIFICATION_PROFILE=dashscope-qwen-2026-09-16
OPENAI_COMPATIBLE_MAX_TOTAL_MEDIA_BYTES=12582912
OPENAI_COMPATIBLE_MAX_TRANSCRIPT_CHARACTERS=12000
OPENAI_COMPATIBLE_TIMEOUT_MS=60000
OPENAI_COMPATIBLE_MAX_RETRIES=2
```

不得只替换模型名却继续保留验证档案。档案会在启动时校验端点、两个模型、图片/语音模式、JSON、detail 和 store；任一项漂移都会失败关闭。其他供应商或模型必须使用 `OPENAI_COMPATIBLE_VERIFICATION_PROFILE=unverified` 并重新执行完整合成探针，不能用于当前竞争模式放行。

## 上线门禁与步骤

公网非生产切换已完成；以下事项仍是扩大体验范围和生产放行前的门禁：

1. 撤销探针旧密钥，创建用途受限的新服务端密钥，并设置可接受的余额、配额和费用告警。
2. 团队审阅并接受供应商的数据留存、训练使用、删除、地域和日志政策。
3. 获得四份固定验收素材的明确授权；在此前不得发送队友真实照片或语音。
4. 使用轮换后的密钥在受控环境复跑文字、图片、M4A、JSON、事实引用、超限、超时和错误脱敏测试。
5. 备份 `/etc/warm-letter/api.env`，只在该文件中写入密钥与上述配置，确认权限仍为 `0600`。
6. 发布包含验证档案和流式转写实现的已审核代码，再重启 `warm-letter-api.service`。
7. 检查 `GET /health`：`capabilities.ai` 应为 `openai-compatible`，配置能力应为 text `native`、image `native`、audio `transcription`，verification 应为 `profile-match`；该值只表示配置匹配已探测档案，响应不得包含密钥、端点或模型。
8. 先完成一轮合成素材公网闭环，再完成获授权四素材的小程序双设备闭环，并保存脱敏证据。
9. 记录一次失败回滚演练和实际调用费用，项目经理复核后才能更新对外口径。

运维复验命令不携带任何密钥：

```bash
systemctl status warm-letter-api --no-pager
journalctl -u warm-letter-api -n 100 --no-pager
curl --fail https://api.warmjiashu.xyz/health
```

## 回滚

出现供应商失败、费用异常、事实错误、隐私问题或延迟不可接受时，把服务器私密环境恢复为：

```env
AI_PROVIDER=fake
```

重启服务并确认 `GET /health` 中 `capabilities.ai` 为 `fake`。日志、请求记录、测试证据和费用截图必须脱敏。回滚保证演示链路可用，但回滚后的输出不能作为真实 AI 证据。

## 对外汇报口径

可以说：“暖笺公网非生产 API 已启用阿里云百炼 Qwen 双模型，并通过服务器合成文字、图片和音频闭环；用户任意图片的小程序连续验收、密钥轮换、隐私费用审核和生产基础设施仍未放行。”

不可以说：“队友真实照片和语音已经完成小程序连续闭环”“已完成生产放行”，也不可以把历史第三方代理表述为官方 Gemini。
