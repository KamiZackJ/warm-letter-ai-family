# 对外展示与证据附件

展示与移交包不依赖 GitHub 或 C 盘绝对路径。当前推荐给同学发送 `暖笺_阶段汇报交付包_2026-08-28-r2.zip`（SHA-256：`431F14C6892A750FCDC6D629D525FCDBC04802A7B6490A3FD9D8AFFF3F465F82`），并保留同级 `.zip.sha256`。该包不是队友原材料的简单归档，而是本项目的阶段说明、融合交互、工程适配与接手资料的统一成果载体。

```text
暖笺_阶段汇报交付包_2026-08-28-r2/
├─ 暖笺_AI产品说明书_阶段版_2026-08-28-r2.pdf  # 汇报先看，8 页 A4
├─ README.md                                     # 打开顺序与传播边界
├─ PACKAGE_MANIFEST.json                         # payload 哈希与代码提交
├─ interactive/
│  ├─ index.html                                 # 产品效果主入口
│  ├─ demo-case.js / demo-case.json              # 仅使用相对媒体路径
│  ├─ manifest.json / PROJECT_INTEGRATION.md      # 隐私门禁与融合归属
│  ├─ evidence/                                  # 安全、隐私、T01-T07
│  ├─ exports/                                   # 推荐 A 长图及 manifest
│  └─ media/
│     ├─ case-001-photo-crop.jpg                 # 物理裁切派生图
│     └─ case-001-audio.m4a                      # 8.895 秒原始示例语音
├─ handoff/README.md                              # 进度、计划、问题、接手清单
└─ adapter/                                       # confirmedDraft 长图适配器与契约

暖笺_阶段汇报交付包_2026-08-28-r2.zip.sha256      # ZIP 整体校验，位于压缩包同级
```

`interactive/index.html` 只引用相邻的 `demo-case.js`，配置再引用 `./media/...`。因此换电脑、换盘符或用聊天软件转发压缩包都不需要改展示路径。`adapter/scripts/` 是受控开发验证工具，仍需接手人明确配置临时目录，不属于双击展示入口。

包内 `PACKAGE_MANIFEST.json` 绑定分支 `codex/warm-letter-mvp` 和提交 `1c2de783f3a5812aca96868f417e67d82ce6300f`，记录除自身以外全部 payload 文件的大小和 SHA-256；同级 sidecar 验证 ZIP 整体，避免 manifest 自引用。阶段 PDF SHA-256 为 `DAD5B6E5FE97680180FDA1F9B1FA2B7AFCDD9DCCA131DF93D1825462A3AF87D4`。

完整原始成果仍应作为单独的“受控原材料档案”保管；其开发输入、原图、DOCX/XLSX 和真人测试工具不放进可转发主演示包：

```text
暖笺_证据附件包/
├─ 暖笺_真实素材家书展示.html     # 照片、音频、三版家书和验收结果
├─ 暖笺_真人用户测试工具.html
└─ 完整成果包/                    # README、素材、成品、展示、测试、接口、规则、核验、配套文件
```

现场先讲根目录 PDF，再让观看者操作 `interactive/index.html`；只有在追问原始接口、规则、工作簿或完整核验记录时才打开另行保管的证据附件包。原始照片不会进入阶段汇报包；照片派生图和原始语音仍只允许队内受控展示，不应上传公开仓库或公开网盘。

受控融合产品包需要同时拥有仓库和队友成果包。脚本会校验三项来源哈希、物理裁切照片并检查 ZIP 根结构：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\create-controlled-case-demo.ps1 `
  -SourceRoot '<队友成果包内层根目录>' `
  -OutputRoot 'D:\tmp\warm-letter-ai-family\controlled-case-001'
```

当前机器强制输出到 `D:\tmp` 子目录，避免在 C 盘堆积受控派生物。接手到没有 D 盘的电脑时，应先修改脚本的受控临时盘策略并重新评审，不能把输出静默回退到 C 盘。证据附件包含不入 Git 的原始素材，不能仅凭仓库重建。
