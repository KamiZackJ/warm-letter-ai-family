# 暖笺合成演示素材

本目录只用于 `demo` 环境。素材由项目本地生成，不包含真实人物、真实聊天或用户隐私，也不得作为真实 OpenAI、真实用户素材或比赛取证证据。

| 文件 | 用途 | 生成方式 | SHA-256 |
| --- | --- | --- | --- |
| `synthetic-cooking-demo.png` | 素材上传、图片预览和删除链路 | 2026-08-15 使用 Windows `System.Drawing` 本地绘制的合成厨房插图 | `92EADFCCE54996F5B56ACF8DB50F06E3A77A4D17A96FA1467F7BFEBEF576705C` |
| `synthetic-voice-demo.wav` | 素材上传、原始音频播放和删除链路 | 2026-08-15 使用 Windows 中文系统语音 `Microsoft Huihui Desktop` 合成 | `62253B93103723DB78A22AE87C51485BFF25B1EADA3585EBBEC528AD6A903B7F` |

语音文本：

> 妈妈，我最近虽然工作有点忙，但每天都有按时吃饭。周末还学着做了番茄炒蛋，你不用担心我。

演示素材必须继续走与用户选择媒体相同的 `presign -> readFile/upload -> complete -> reader` 链路。禁止在非 `demo` 环境加载本目录，禁止把合成素材截图剪裁成看似真实用户证据。
