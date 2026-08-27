# 对外展示与证据附件

展示包不依赖 GitHub 或 C 盘绝对路径。当前推荐给同学发送“受控融合产品包”：`暖笺_CASE-001_受控团队成果包_2026-08-28.zip`（SHA-256：`1CE227E3B90734674DD128C0CBBBE650BB89DDD79BC1A00E2837DB2CF4610954`）。解压后双击根目录 `index.html`，第一屏直接是使用队友真实材料的可操作写信工作台。

```text
controlled-case-001/
├─ index.html                     # 唯一主入口
├─ demo-case.js                   # 页面运行配置，仅相对媒体路径
├─ demo-case.json                 # 可核验的同构配置
├─ manifest.json                  # 输出大小、SHA-256、裁切参数与隐私门禁
├─ README.md                      # 展示范围与能力边界
├─ PROJECT_INTEGRATION.md          # 队友材料与本项目能力的融合说明
├─ evidence/                       # 输出样例、安全、隐私、T01-T07 与素材清单
├─ exports/                        # 推荐 A 长图及其核验 manifest
└─ media/
   ├─ case-001-photo-crop.jpg     # 物理裁切派生图，不含右侧人物像素
   └─ case-001-audio.m4a          # 队友提供的 8.895 秒示例原音
```

`index.html` 只引用相邻的 `demo-case.js`，配置再引用 `./media/...`。因此换电脑、换盘符或用聊天软件转发压缩包都不需要改路径。

完整原始成果仍应作为单独的“受控原材料档案”保管；其开发输入、原图、DOCX/XLSX 和真人测试工具不放进可转发主演示包：

```text
暖笺_证据附件包/
├─ 暖笺_真实素材家书展示.html     # 照片、音频、三版家书和验收结果
├─ 暖笺_真人用户测试工具.html
└─ 完整成果包/                    # README、素材、成品、展示、测试、接口、规则、核验、配套文件
```

现场先让观看者操作融合产品包；只有在追问原始接口、规则、工作簿或完整核验记录时才打开证据附件包。原始照片不会进入融合产品包；照片派生图和原始语音仍只允许队内受控展示，不应上传公开仓库或公开网盘。

受控融合产品包需要同时拥有仓库和队友成果包。脚本会校验三项来源哈希、物理裁切照片并检查 ZIP 根结构：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\create-controlled-case-demo.ps1 `
  -SourceRoot '<队友成果包内层根目录>' `
  -OutputRoot 'D:\tmp\warm-letter-ai-family\controlled-case-001'
```

当前机器强制输出到 `D:\tmp` 子目录，避免在 C 盘堆积受控派生物。接手到没有 D 盘的电脑时，应先修改脚本的受控临时盘策略并重新评审，不能把输出静默回退到 C 盘。证据附件包含不入 Git 的原始素材，不能仅凭仓库重建。
