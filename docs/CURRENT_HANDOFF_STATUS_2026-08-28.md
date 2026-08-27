# 暖笺当前交接状态

- 状态日期：2026-08-28（Asia/Shanghai）
- 适用对象：项目接手人、队长、项目经理和内部评审成员
- 当前等级：`G0` 队内开发演示可用，不是 MVP、公测、生产或比赛提交候选

这是当前唯一交接入口。更早的阶段报告、验收清单和交接文件继续保留为历史证据；若日期、SHA 或测试数冲突，以本文件和分支 HEAD 为准。

## 1. 当前结论

| 项目 | 当前事实 |
| --- | --- |
| 分支 | `codex/warm-letter-mvp` |
| 已验证实现基线 | `730fe47`（当前工作树含待提交的 CASE-001 展示、运行时门禁与交接更新） |
| 本地运行时 | Node `22.23.2`、pnpm `11.19.0` |
| 自动回归 | contracts `17/17`、Web `75/75`、小程序 `125/125`、API `138/138`，共 `355/355` |
| 本地工程门禁 | frozen install、`pnpm check`、`pnpm build`、production bundle verifier、`git diff --check` 通过 |
| 视觉复验 | H5 在 1440×900 和 390×844 下结尾/署名分层正常；手机端无署名溢出，控制台 0 error / 0 warning |
| 队内主展示 | `暖笺_CASE-001_受控团队成果包_2026-08-28.zip`：队友真实照片的隐私裁切图、原始 m4a、A/B/C 固定审核稿、段落级证据、T01-T07 与 1080 px 长图均已进入同一可操作包 |
| 远端验证 | [push CI](https://github.com/KamiZackJ/warm-letter-ai-family/actions/runs/33095266241) 与 [PR CI](https://github.com/KamiZackJ/warm-letter-ai-family/actions/runs/33095270181) 均通过 |

### 最新复验（2026-08-28 07:30:38 Asia/Shanghai）

- 使用 D 盘 Node `v22.23.2` 和 pnpm `11.19.0` 重跑 `pnpm check`、`pnpm build` 与 `pnpm --filter @warm-letter/web verify:production-bundle`，结果全部通过（355/355）；本轮新增 CASE-001 A/B/C 段落级精确归因回归测试。
- `4183` 受控成果包浏览器实测已加载队友照片裁切图和原始 m4a，并完成 A/B/C 切换、确认、阅读和回复；`4173` React H5 同样实际加载 `720×1020` 照片和 `8.895s` 原始 m4a。阶段首页在 390×844 下 `scrollWidth=390`。
- 本轮构建生成的 `dist`、`tsbuildinfo` 已移至 `D:\tmp\warm-letter-ai-family\artifacts\post-build-20260828-0729`；Vite 缓存位于 D 盘 `vite-cache`，C 盘工作区未保留本轮构建临时产物。

## 2. 给队友展示什么

默认发送 CASE-001 受控团队成果包，不再把脱敏合成产品原型作为对队友的主展示：

- 目录：`D:\tmp\warm-letter-ai-family\暖笺_CASE-001_受控团队成果包_2026-08-28\`
- 文件：`D:\tmp\warm-letter-ai-family\暖笺_CASE-001_受控团队成果包_2026-08-28.zip`
- SHA-256：`1CE227E3B90734674DD128C0CBBBE650BB89DDD79BC1A00E2837DB2CF4610954`
- 打开方式：解压后直接双击根目录 `index.html`；无需 GitHub、服务端或本机绝对路径。
- 内容：队友提供的真实照片隐私裁切图、原始 m4a、A/B/C 三版固定审核家书、证据副本、可操作的“素材 -> 三版比较 -> 来源核对 -> 确认 -> 阅读/回复”旅程，以及推荐 A 的 1080 x 2631 成果长图。
- 已复验：照片在页面加载为 `720 x 1020` 物理裁切派生图；原始 m4a 可加载；A/B/C 可切换；初次载入显示“队友固定审核稿 / 固定稿依据已核对”，编辑后才变为“修改后待核对依据”。
- 边界：三版是队友固定审核稿，不请求实时 OpenAI；阅读页是本地交互演示，不产生真实外网分享链接，也不代表微信双真机、真人测试或生产部署完成。

### 阶段汇报 PDF（独立展示媒介）

- 文件：`D:\tmp\warm-letter-ai-family\submission\暖笺_AI产品说明书_阶段版_2026-08-28.pdf`
- SHA-256：`91B253C983B3AE8F48133407BBA181A34AD38A83ED433769D0485DD2C567FDB9`
- 用途：给队友、项目经理和内部评审快速理解产品定位、真实素材接入、AI 价值、工程承接、隐私边界、当前门禁和接手路线；封面使用队友照片的物理裁切图。
- 口径：这是 `G0 / 内部受控 / 阶段版`，不宣称真实 OpenAI 四素材、微信双真机、真人测试或生产放行已完成。

### 单文件阶段汇报包

- 文件：`D:\tmp\warm-letter-ai-family\暖笺_阶段汇报交付包_2026-08-28.zip`
- SHA-256：`CF1E99E917E34AC9A1648DE57FF3D230802BA8B0A4A0DDAD329B921AEE395F1A`
- 内容：根目录 PDF；`interactive/` 下是包含队友真实照片裁切图、原始 m4a、A/B/C、证据和确认/阅读/回复闭环的完整受控页面。
- 打开顺序：解压后先看根目录 PDF，再双击 `interactive/index.html`；所有页面引用均为包内相对路径，可换电脑使用。

### 本轮实材复验（2026-08-28）

- 受控 H5 阅读页实际请求 `/case-001-photo-crop.jpg` 和 `/case-001-audio.m4a`；页面顶部与素材区均明确标出队友来源。
- 从 `http://127.0.0.1:4173/` 下载的照片 SHA-256 为 `e09c8091a6676398d81ba40cd28d11c2f598e846748cfe2a069a09666ee6706b`，与受控包中的隐私裁切图一致。
- 从同一地址下载的语音 SHA-256 为 `f9ec48c022bc98d9cc5ac3ff061c65108fe4827ccd8aac9ef1aca15ff88ea4dc`，与受控包中的原始 m4a 一致。
- 因此，当前 `4173` 受控入口展示的是队友材料；仓库根目录的 `pnpm dev:web` 现在会优先发现 D:\tmp 中的受控包，找不到时才明确回退为合成脱敏演示。

本包中已经含有展示所需的安全、隐私和验收证据。只有在评审追问开发输入、真人测试工具、DOCX 成果册或完整原始成果时，才在同一受控范围内提供原成果包作为补充：

- 受控包不包含原始照片，只包含删除裁切外像素的派生图；原始 m4a 仅限已授权的团队成员播放。
- 包内 `evidence/` 已包含输出样例、内容安全规则、隐私审查、T01-T07 自动验收和素材清单；`exports/` 已包含推荐 A 长图和长图核验清单。
- 原始照片、开发输入、原始转写、系统提示词、DOCX/XLSX 和真人测试工具均不进入可转发主包，也不能上传公开仓库或公开网盘。

## 3. 本阶段新增成果

### 署名确认快照（FIX-021 子范围）

- 共享 `LetterDraft` 契约新增必填 `signature`，长度为 1 到 30 个字符。
- API 生成默认署名，PATCH 会修剪和校验；重新生成保留用户已编辑署名。
- 确认发布时把归一化署名冻结进 `confirmedDraft`，后续草稿变化不影响公开 Reader。
- 小程序真实 API 已移除 `real_signatures` 本地缓存，编辑端和全新收信设备都读取服务端字段。
- H5 将结尾和署名分开展示，并把两者都纳入系统朗读。
- 长图、短片渲染器尚不存在，微信双真机也未验，因此 FIX-021 的跨全部输出/真机范围仍不能整体关闭。

### CASE-001 受控真实素材融合

- `packages/contracts/src/fixtures/case-001.ts` 固定三条审核后事实、合成 UUID、单版草稿和安全断言。
- contracts 测试锁定中性称呼、不确定词降级、第三方隐私、禁止购买/食用/功效推断和来源覆盖。
- API 测试覆盖“生成 -> 确认 -> 公开 Reader DTO”，并验证公开响应不包含 CASE ID、内部对象键、用户 ID 或真实文件名。
- fixture 不含原始媒体、原始 ASR、绝对路径或访问凭据；它不证明真实 OpenAI、三版选择或真人测试已完成。
- 队友提供的 CASE-001 真实照片、8.895 秒 m4a、A/B/C 家书、事实映射、隐私审查和 T01-T07 已经通过受控构建脚本接入产品演示；构建前后校验三项主来源 SHA-256，并只输出照片物理裁切派生图。
- 受控包用相对路径加载 `media/`、`evidence/` 和 `exports/`；推荐 A 长图为 `1080 x 2631`，正文、裁切图、披露语和无敏感路径由独立 manifest 复核。
- React H5 阅读端新增 `VITE_DEMO_CASE=case-001` 受控模式：从受控包只读加载真实裁切照片和原始 m4a，Vite 启动时校验 SHA-256、媒体目录只允许两项已核验文件；页面显示队友来源、固定审核稿和非实时 OpenAI 口径。
- 新增 `scripts/start-controlled-case-reader.ps1` 与 `scripts/start-web-demo.ps1`：前者显式指定受控媒体目录，后者是根目录默认入口，会优先加载 D:\tmp 中已核验的队友 CASE-001，找不到时回退脱敏模式；真实媒体仍不会进入 Git。

### 展示入口收口（本轮）

- 阶段展示中心新增 `http://127.0.0.1:4183/` 受控包直达入口；脱敏仓库页会明确提示“受控媒体未装入”，不再把合成占位图当作队友成果。
- 阶段展示中心首屏核验卡在 `4183` 可用时直接加载队友照片物理裁切图和原始 m4a 播放器；连接不可用时只显示受控预览缺失提示，不以合成素材回填。
- 根目录 `暖笺_互动产品演示.html` 已收口为团队成果展示入口，默认先进入阶段成果展示中心；脱敏开发演示仍可从该入口的次级链接或 `pnpm dev:web:synthetic` 打开。队友汇报统一使用受控 ZIP 根目录 `index.html`，或 `4183` 离线服务与 `4173` React H5。
- 受控 ZIP 已用 D 盘队友成果包副本重建，15 项相对路径、真实照片裁切图、原始 m4a、A/B/C、证据和长图复核通过；当前 SHA-256 以本文件第 2 节为准。

### 交付与质量

- CASE-001 受控包的 ZIP 根目录直接出现 `index.html`，包内 README、项目接入说明和 manifest 使用相对路径；构建时检查 15 个必需条目、媒体哈希、证据副本、长图和敏感文本。
- 旧阶段展示页不再保存任何人的微信/C 盘绝对路径。
- Node 和 pnpm 版本已统一；GitHub Actions 新增 production bundle verifier。

## 4. 接手后的首日操作

当前机器的任务临时目录固定使用 D 盘，只设置当前 PowerShell 进程，不修改系统或用户全局环境变量：

```powershell
$env:TEMP = 'D:\tmp\warm-letter-ai-family'
$env:TMP = $env:TEMP
$env:WARM_LETTER_TMP_DIR = $env:TEMP
New-Item -ItemType Directory -Force $env:TEMP | Out-Null
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm --filter @warm-letter/web verify:production-bundle
```

预期版本为 Node `v22.23.2`、pnpm `11.19.0`。API 与 H5 是两个常驻进程，需要在两个 PowerShell 窗口分别运行：

```powershell
# 窗口 1
pnpm dev:api
```

```powershell
# 窗口 2：优先加载 D:\tmp 中队友 CASE-001，找不到时回退脱敏演示
pnpm dev:web
```

若要强制只跑合成脱敏数据：

```powershell
pnpm dev:web:synthetic
```

需要给队友展示本项目 React H5 阅读端并使用 CASE-001 真实受控材料时，在窗口 2 改用下面的一键入口（等价于直接调用脚本）：

```powershell
pnpm dev:web:case-001
```

如需换用另一份受控包，再显式调用 `scripts/start-controlled-case-reader.ps1 -MediaDirectory <该包的 media 目录>`。无受控包时，环境条会标注“未加载队友真实媒体”，避免把两种展示口径混淆。

该脚本只向 Vite 子进程注入受控媒体目录，启动时强制校验裁切照片和原始 m4a；真实媒体不进入 Git。默认展示入口是 `D:\tmp\warm-letter-ai-family\暖笺_CASE-001_受控团队成果包_2026-08-28\index.html`，React H5 入口用于验证产品阅读端的素材接入。

新电脑没有 D 盘时，不要硬编码盘符；可将打包输出显式改到该电脑的临时目录：

```powershell
$outputRoot = Join-Path $env:TEMP 'warm-letter-ai-family-delivery'
powershell -ExecutionPolicy Bypass -File .\scripts\create-product-demo-package.ps1 -OutputRoot $outputRoot
```

需要重新构建队友 CASE-001 的受控展示时，先取得团队授权的原成果包内层根目录。当前脚本故意只允许向 `D:\tmp` 写入，以避免原始素材或派生物散落到 C 盘：

```powershell
$sourceRoot = '<队友原成果包的内层根目录>'
$outputRoot = 'D:\tmp\warm-letter-ai-family\controlled-case-001'

powershell -ExecutionPolicy Bypass -File .\scripts\create-controlled-case-demo.ps1 `
  -SourceRoot $sourceRoot `
  -OutputRoot $outputRoot

powershell -ExecutionPolicy Bypass -File .\scripts\create-case-001-long-image.ps1 `
  -InputRoot $outputRoot

powershell -ExecutionPolicy Bypass -File .\scripts\create-controlled-case-demo.ps1 `
  -SourceRoot $sourceRoot `
  -OutputRoot $outputRoot `
  -RequireLongImage
```

微信导出的外层包装目录也可以直接作为 `-SourceRoot` 传入；脚本会在只发现一个包含 `素材/成品/接口/核验` 的内层目录时自动下探。多个候选目录时必须显式指定内层根目录。

## 5. 受控素材与移交问题

| 项目 | 当前状态 | 接手动作 |
| --- | --- | --- |
| 原始照片/语音 | 仅允许队内受控展示，未取得公开传播授权 | 指定一名真人负责人保管，并记录访问人员和删除要求 |
| 原始来源位置 | 不写入仓库；由移交人在线下确认团队受控存储位置 | 接手当天验证可访问性和 SHA-256 |
| CASE-001 受控展示包 | 仓库脚本可从授权的原成果包重建；原始照片仍不会入包 | 先核对三项来源 SHA-256，再按第 4 节三步重建并校验最终 ZIP SHA-256 |
| 原始成果附件 | 原照片、开发输入、DOCX/XLSX、真人测试工具不进入主演示 ZIP | 仅在团队受控存储中保管；按需复核，不能用旧合成展示包替代主演示 |
| 完整使用与融合教程 | 辅助材料清单中提到，但已访问目录未找到 | 由材料提供者补交，不能用“实际成果册”冒充 |
| 真人测试 | 工具和工作簿已准备，尚无 6 名真人评分 | 完成 3 名年轻用户和 3 名长辈测试并复测问题 |

## 6. 尚未完成的门禁

- 真实 OpenAI 照片、截图、中文语音和文字四素材端到端调用及事实核验录像。
- 微信正式 `code2Session`、HTTPS API、两账号/两设备分享、媒体播放、回复和错误 token 真机证据。
- PostgreSQL、S3/OSS、独立队列、跨实例限流、正式内容审核、删除 SLA 和生产部署。
- 受控 CASE-001 已有 1080 px 长图，但从任意 `confirmedDraft` 自动生成长图/短片、与线上草稿的署名一致性验证仍未实现。
- 3 名年轻用户和 3 名长辈的真人测试、问题返修与通过结论。
- 比赛录屏、PDF、AIGC 声明、平台账号和正式提交回执。

## 7. 推荐推进顺序

1. 用受控、已授权的脱敏四素材完成真实 OpenAI 请求，保存结构化输出、`sourceRefs`、失败/重试和人工事实核对证据。
2. 配置正式微信环境，在两台设备上完成上传、寄出、阅读媒体、回复、回查和失效链接负向流程。
3. 决定持久化、对象存储、审核、共享限流和删除架构，再进入 G2 真人用户测试。
4. 从 `confirmedDraft` 实现 1080 px 长图，确认正文/署名一致和无溢出后再复用到短片。

## 8. 移交完成清单

- [ ] 接手人核对分支 HEAD、Node/pnpm 版本并运行全部本地门禁。
- [ ] 接手人完整操作 CASE-001 受控展示包，确认真实裁切图、原始 m4a、A/B/C、编辑后来源核对、确认阅读和回复均可用。
- [ ] 团队指定受控素材负责人，确认授权范围、原成果存储位置和 `1CE227E3B90734674DD128C0CBBBE650BB89DDD79BC1A00E2837DB2CF4610954`。
- [ ] 接手人选择第 7 节的一项 P0 工作，并先定义可复核证据再编码。
- [ ] 每次阶段更新记录完成事实、证据链接、剩余风险和下一步前三项。

## 9. C 盘占用说明

仓库和既有 `node_modules` 位于 C 盘工作区，这是项目源码与依赖本身。2026-08-28 本轮新增的测试临时文件、production bundle、浏览器截图、Node 22 运行时、打包 staging、ZIP、Web 构建缓存和 Vite 缓存均写入 `D:\tmp\warm-letter-ai-family` 或 `D:\tmp`；本轮生成的 `apps/web/dist`、`apps/api/dist`、`packages/contracts/dist`、`apps/web/tsconfig.tsbuildinfo` 与 `apps/web/node_modules/.vite` 已移到 D 盘 artifacts。受控阅读脚本会把 `WARM_LETTER_TMP_DIR`、`TEMP/TMP` 和 Vite `cacheDir` 固定到 D 盘子目录。未新增 C 盘任务临时目录，也未修改全局 `TEMP/TMP`。
