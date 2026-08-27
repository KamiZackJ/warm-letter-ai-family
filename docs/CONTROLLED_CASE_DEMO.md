# 受控真实素材演示构建

`scripts/create-controlled-case-demo.ps1` 把队友成果包中的固定案例转换为可移机的本地演示目录。脚本只读源材料，只向 `D:\tmp` 的子目录写入；原始照片不会进入输出目录，展示图是删除裁切外像素后的 JPEG 衍生图。

最终包不是用合成素材补齐界面：它包含队友提供的原始示例语音、由队友照片物理裁切的货架图、队友审核的 A/B/C 三版家书，以及可独立复核的安全和隐私证据。真实媒体仍仅限已授权的团队内部受控传阅。

## 运行

`SourceRoot` 必须指向同时包含 `素材`、`成品`、`接口` 和 `核验` 的内层成果包根目录。

微信文件导出有时会在外层再包一层同名目录；脚本会在传入目录不直接包含上述四个目录时，自动接受唯一的内层成果包。若发现多个候选目录，脚本会停止并要求显式传入真正的内层目录。

```powershell
$sourceRoot = '<队友成果包根目录>'

powershell -ExecutionPolicy Bypass -File .\scripts\create-controlled-case-demo.ps1 `
  -SourceRoot $sourceRoot `
  -OutputRoot 'D:\tmp\warm-letter-ai-family\controlled-case-001'
```

脚本可重复运行。它先在目标目录旁的 D 盘 staging 目录完成全部检查，再替换先前由同一脚本生成的目录；不会覆盖缺少受控 manifest 的已有目录。

默认还会在目录同级生成 `controlled-case-001.zip`，这是可以直接发给队友的压缩包。仅调试目录内容时可传 `-SkipArchive`；正式交付不要跳过压缩包。

## 最终交接构建

长图是一个独立的成果呈现媒介，展示推荐的 A 版家书、真实裁切图和固定审核披露语。正式交接按下面三个命令执行：

```powershell
$sourceRoot = '<队友成果包根目录>'
$outputRoot = 'D:\tmp\warm-letter-ai-family\controlled-case-001'

# 1. 生成包含真实媒体、三版固定稿和证据的基础目录。
powershell -ExecutionPolicy Bypass -File .\scripts\create-controlled-case-demo.ps1 `
  -SourceRoot $sourceRoot `
  -OutputRoot $outputRoot

# 2. 从基础目录生成推荐 A 的长图和它的核验清单。
powershell -ExecutionPolicy Bypass -File .\scripts\create-case-001-long-image.ps1 `
  -InputRoot $outputRoot

# 3. 重新打包，并强制要求存在且通过校验的长图。
powershell -ExecutionPolicy Bypass -File .\scripts\create-controlled-case-demo.ps1 `
  -SourceRoot $sourceRoot `
  -OutputRoot $outputRoot `
  -RequireLongImage
```

第三步会固定验证长图 PNG、长图核验清单、推荐 A 正文哈希、披露语、裁切图哈希和尺寸。若缺少、被替换或不匹配，构建失败且不会替换上一份有效包。

当旧包正被浏览器或本地服务器占用时，可先把它作为只读的长图来源，输出到另一个 `D:\tmp` 子目录：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\create-controlled-case-demo.ps1 `
  -SourceRoot $sourceRoot `
  -OutputRoot 'D:\tmp\warm-letter-ai-family\controlled-case-001-final' `
  -LongImageSourceRoot 'D:\tmp\warm-letter-ai-family\controlled-case-001' `
  -RequireLongImage
```

`LongImageSourceRoot` 和 `OutputRoot` 都被限制在 `D:\tmp` 内，且来源目录必须已经带有本项目的受控 manifest。

## 输入门禁

构建前固定验证三项来源的字节数和 SHA-256：

| 来源 | SHA-256 |
| --- | --- |
| `素材/生活照片_商店货架.jpg` | `885457751dbc4a9a0fe99fc0d7cfe1b5336c5b6e939beab0f4f1e07b138bf44d` |
| `素材/语音_暖笺_1.m4a` | `f9ec48c022bc98d9cc5ac3ff061c65108fe4827ccd8aac9ef1aca15ff88ea4dc` |
| `成品/三版温柔家书.txt` | `72092f4ea003c3aece40b529ef57b121c9300afd7f0315545e11efb37abf5df8` |

此外还会检查：

- 源图解码尺寸必须精确为 `1080 × 1919`；
- 固定裁切矩形为 `x=0, y=420, width=720, height=1020`；
- 三版 JSON 正文必须逐字存在于哈希已确认的 TXT；
- 推荐稿必须仍为 A 版；
- 安全结论必须为 `PASS`，T01-T07 必须全部通过；
- 五份可转发证据文件必须与队友成果包中的哈希完全一致：输出样例、安全策略、隐私审查、自动验收和素材清单；
- 若使用 `-RequireLongImage`，`exports/` 必须恰好包含固定的 CASE-001 推荐 A PNG 与其核验清单，二者的哈希、尺寸、正文来源和披露语均需匹配；
- 构建前后再次校验三个源文件，确认脚本未修改它们；
- 输出文本不得出现盘符绝对路径、raw ASR 字段或常见凭据形态。

任何一项不满足时，脚本终止且不替换上一份有效输出。

## 输出结构

```text
controlled-case-001/
├─ index.html
├─ demo-case.js
├─ demo-case.json
├─ manifest.json
├─ README.md
├─ PROJECT_INTEGRATION.md
├─ evidence/
│  ├─ case-001-output.json
│  ├─ content-safety-policy.json
│  ├─ privacy-review.json
│  ├─ automated-acceptance-tests.json
│  └─ material-manifest.csv
├─ media/
│  ├─ case-001-photo-crop.jpg
│  └─ case-001-audio.m4a
└─ exports/
   ├─ warm-letter-case-001-recommended-a.png
   └─ warm-letter-case-001-recommended-a.manifest.json

controlled-case-001.zip
```

`index.html` 来自仓库的 `docs/product-demo/index.html`。页面读取同目录 `demo-case.js`；两项媒体 URL 固定为 `./media/...`，目录换电脑或换盘符后不需要改配置。`PROJECT_INTEGRATION.md` 说明哪些内容来自队友材料、哪些能力由本项目完成接入，以及尚未完成的边界。

## 接入项目 H5 阅读端

若需要展示本仓库的 React H5 阅读端（`http://127.0.0.1:4173/`），不要把真实媒体复制到仓库。使用受控包的 `media/` 目录作为只读 public 目录：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-controlled-case-reader.ps1 `
  -MediaDirectory 'D:\tmp\warm-letter-ai-family\暖笺_CASE-001_受控团队成果包_2026-08-28\media'
```

启动时 Vite 会重新校验裁切照片、原始 m4a 和受控包根目录 `demo-case.json` 审核稿的 SHA-256，并将推荐 A 的正文从已核验 JSON 注入阅读页；校验失败会直接停止，不会启动一个使用错素材或过期文案的页面。受控脚本还会把 `WARM_LETTER_TMP_DIR`、`TEMP/TMP` 和 Vite 缓存固定到 `D:\tmp\warm-letter-ai-family` 子目录，避免运行时缓存落到 C 盘。换电脑或换目录时只需要替换 `-MediaDirectory`，不要修改源码或提交媒体文件。仓库中的 `pnpm dev:web` 会优先发现 D:\tmp 中已核验的受控 CASE-001；需要明确不加载真实媒体时使用 `pnpm dev:web:synthetic`。

ZIP 在替换旧成果前先完成结构校验：根目录必须包含演示页面、`demo-case.js`、`demo-case.json`、`manifest.json`、`README.md`、`PROJECT_INTEGRATION.md`、两项 `media/` 文件、五项 `evidence/` 文件，以及最终构建时的两项 `exports/` 文件。带 `-RequireLongImage` 的最终交接 ZIP 共 15 个文件；所有条目都不得使用盘符、根路径、反斜杠或 `..`。脚本结束时会输出 ZIP 的 SHA-256，转发后可用它确认文件未被替换。

## `demo-case` 契约

主对象同时写入 JSON 和 `window.WARM_LETTER_DEMO_CASE`，包含：

- `caseId`、`mode`、`provenanceLabel`：以 `controlled-team` 模式装载受控素材，并明确这是固定审核稿、非实时 OpenAI 调用；
- `photoUrl`、`audioUrl`、`audioDurationSeconds`：仅使用相对媒体 URL；
- `photoCrop`、`sourceHashes`：记录裁切矩形、衍生图哈希和三项来源哈希；
- `drafts[]`、`recommendedDraftId`：A/B/C 三版固定审核稿及推荐关系；
- `evidenceMap[]`：正文事实与语音/照片依据的映射；
- `drafts[].paragraphEvidence[]`：每个正文段落关联的已审核证据 ID 与素材类型；构建时会校验它与 `evidenceMap[]` 的来源完全一致，React 阅读端也只按这份映射展示来源归因；
- `safetyTests[]`：供页面直接显示的 T01-T07 编号；
- `safety`、`safetyTestResults[]`：审核结论及每项测试的标签、准则和 PASS 状态。

`manifest.json` 另外记录各输出文件的相对路径、大小、哈希、裁切工具参数、逐字复制的证据文件和长图控制状态。输出含真实原音与真实照片衍生图，仍只适合团队授权范围内受控传阅，不应提交 Git 或上传公开网盘。

未复制的队友材料包括原始照片、`case_001.input.json`、`safe_generation_prompt.txt`、DOCX/XLSX 和真人测试工具；它们分别属于原图隐私、开发输入、实现提示词或后续研究资料，不是团队展示 ZIP 的必要内容。
