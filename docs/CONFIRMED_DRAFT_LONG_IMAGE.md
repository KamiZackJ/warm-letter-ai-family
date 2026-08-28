# confirmedDraft 长图导出

`scripts/create-confirmed-draft-long-image.ps1` 是动态长图的最小可验收入口。它消费 API/共享契约中的 `LetterDraft` 形状，不调用模型，也不把素材上传到网络；输入、临时 staging 和输出均限制在 `D:\tmp` 子目录。

## 运行

`ConfirmedDraftPath` 可以是以下任一 JSON 形状：

- 直接的 `confirmedDraft` 对象；
- `{ "confirmedDraft": { ... } }`；
- `{ "letter": { "confirmedDraft": { ... } } }`（API 确认响应）；
- `{ "data": { "letter": { "confirmedDraft": { ... } } } }`。

照片必须是已经获准展示的派生图，或测试用合成图；不要将队友原始照片复制到仓库或公开包。

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\create-confirmed-draft-long-image.ps1 `
  -ConfirmedDraftPath 'D:\tmp\warm-letter-ai-family\confirmed-draft.json' `
  -PhotoPath 'D:\tmp\warm-letter-ai-family\approved-photo.jpg' `
  -OutputRoot 'D:\tmp\warm-letter-ai-family\confirmed-draft-output' `
  -OutputName 'warm-letter-confirmed-draft.png'
```

输出目录包含 `exports/<OutputName>` 和同名 `.manifest.json`。PNG 宽度固定为 `1080`，高度按标题、照片和正文自适应（上限 `12000`）。正文顺序固定为 `greeting → paragraphs → closing → signature`；manifest 记录确认稿文件哈希、规范化稿哈希、正文哈希、照片哈希、尺寸和像素证据，不记录输入绝对路径。

适配器先按 `packages/contracts/src/models.ts` 的 `LetterDraftSchema` 校验字段、长度、UUID、时间戳、归因和 AI 标注；拒绝未确认的 `draft` 形状、未知字段、凭据/绝对路径文本和无效媒体。渲染复用 `create-case-001-long-image.ps1` 的现有暖笺布局、字体和像素门禁。原脚本的新参数默认值保持 CASE-001 既有入口不变。

## 验证

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\verify-confirmed-draft-long-image.ps1
```

验证脚本只在 `D:\tmp` 生成合成照片和临时 JSON，覆盖直接 Draft、API 嵌套 `letter.confirmedDraft`、长中文正文自动换行、超过 12000px 的高度上限拒绝、非法字段拒绝、PNG/manifest 一致性、输入只读和 CASE-001 固定输出未被触碰。默认结束后清理测试目录；需要查看中间产物时传 `-KeepArtifacts`。

这条路径证明的是离线渲染闭环，不等于真实模型调用、微信双设备、生产任务队列或短片导出已经完成。
