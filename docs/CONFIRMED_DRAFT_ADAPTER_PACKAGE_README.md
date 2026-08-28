# confirmedDraft 长图适配器交接

这个目录是暖笺本阶段新增的工程产物，不是队友材料的副本。它把服务端确认版本转换为可审计的 1080 px 家书长图，并保持正文、结尾和署名来自同一个 `confirmedDraft`。

## 目录

```text
adapter/
├─ README.md
├─ CONFIRMED_DRAFT_LONG_IMAGE.md
├─ contracts/
│  └─ models.ts
└─ scripts/
   ├─ create-confirmed-draft-long-image.ps1
   ├─ create-case-001-long-image.ps1
   └─ verify-confirmed-draft-long-image.ps1
```

两个渲染脚本必须保留在同一个 `scripts/` 目录中；通用适配器通过 `$PSScriptRoot` 调用共享版式渲染器。`contracts/models.ts` 是打包时的共享契约快照，便于接手人核对 `LetterDraftSchema`；实际开发仍以仓库中的最新契约为准。

## 已证明的范围

- 接受直接 `LetterDraft`、`confirmedDraft` 包装对象和 API `letter.confirmedDraft` 响应。
- 校验标题、问候、段落、来源 UUID、结尾、署名、provider、时间戳和 AI 标注。
- 输出固定 1080 px 宽、自适应高度的 PNG 与独立 manifest。
- manifest 记录输入确认稿哈希、规范化稿哈希、正文哈希、图片哈希、尺寸和像素证据，不记录输入绝对路径。
- 覆盖 direct/API 嵌套、长中文换行、12000 px 高度上限、非法字段拒绝、输入只读和旧 CASE-001 成品不被改写。

## 尚未证明的范围

- 尚未接入 API 异步渲染任务、对象存储或任务队列。
- 尚未完成打印预览、失败重试/幂等、授权台账和微信真机消费。
- 尚未生成短片，也不能把该适配器称为生产导出服务。
- 图片会嵌入输出 PNG；调用方必须只传入已获准展示的派生图。

## 在代码仓库中验证

在 Windows PowerShell 中，从仓库根目录运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\verify-confirmed-draft-long-image.ps1
```

当前机器的验证脚本将测试输入和输出限制在 D 盘受控临时目录。接手到没有 D 盘的电脑时，先评审并调整临时目录策略，再运行脚本；不要让受控媒体静默回落到系统盘或公开同步目录。

详细输入、输出和门禁见 [`CONFIRMED_DRAFT_LONG_IMAGE.md`](./CONFIRMED_DRAFT_LONG_IMAGE.md)。
