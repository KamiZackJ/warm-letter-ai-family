# 暖笺当前交接状态

- 状态日期：2026-08-28（Asia/Shanghai）
- 适用对象：项目接手人、队长、项目经理和内部评审成员
- 当前等级：`G0` 队内开发演示可用，不是 MVP、公测、生产或比赛提交候选

这是当前唯一交接入口。更早的阶段报告、验收清单和交接文件继续保留为历史证据；若日期、SHA 或测试数冲突，以本文件和分支 HEAD 为准。

## 1. 当前结论

| 项目 | 当前事实 |
| --- | --- |
| 分支 | `codex/warm-letter-mvp` |
| 已验证实现基线 | `f60e759a925e0eb4189afa23344b2489e9bb632f` |
| 本地运行时 | Node `22.23.2`、pnpm `11.19.0` |
| 自动回归 | contracts `17/17`、Web `70/70`、小程序 `125/125`、API `135/135`，共 `347/347` |
| 本地工程门禁 | frozen install、`pnpm check`、`pnpm build`、production bundle verifier、`git diff --check` 通过 |
| 视觉复验 | H5 在 1440×900 和 390×844 下结尾/署名分层正常；手机端无署名溢出，控制台 0 error / 0 warning |
| 远端验证 | [push CI](https://github.com/KamiZackJ/warm-letter-ai-family/actions/runs/33095266241) 与 [PR CI](https://github.com/KamiZackJ/warm-letter-ai-family/actions/runs/33095270181) 均通过 |

## 2. 给队友展示什么

默认只发送产品体验包：

- 文件：`D:\tmp\暖笺_产品体验展示包_2026-08-28-005053.zip`
- SHA-256：`0C5B8727FB64852659350D3B621BDDC96B0DA2676BF25E5DC0994E7CC7D3BD90`
- 打开方式：解压后直接双击根目录 `暖笺_互动产品演示.html`。
- 内容：一条可操作的“选择素材 -> 生成草稿 -> 核对来源 -> 确认寄出 -> 阅读/回复”旅程。
- 边界：页面使用脱敏固定语义和本地状态，不请求真实 OpenAI，不产生真实分享链接。

只有在队友追问真实素材、三版家书、隐私规则或测试方法时，才受控发送证据附件：

- 文件：`D:\tmp\暖笺_证据附件包_2026-08-26.zip`
- SHA-256：`44C87C23F7E369AD8993B3747A69EF14981CC3E3A959E9761E74D360D8D5DB56`
- 该包包含不进入公开 Git 的照片和语音，不能上传公开仓库或公开网盘。
- 该包不能从仓库独立重建；团队必须在受控存储中保留原包并校验 SHA-256。

## 3. 本阶段新增成果

### 署名确认快照（FIX-021 子范围）

- 共享 `LetterDraft` 契约新增必填 `signature`，长度为 1 到 30 个字符。
- API 生成默认署名，PATCH 会修剪和校验；重新生成保留用户已编辑署名。
- 确认发布时把归一化署名冻结进 `confirmedDraft`，后续草稿变化不影响公开 Reader。
- 小程序真实 API 已移除 `real_signatures` 本地缓存，编辑端和全新收信设备都读取服务端字段。
- H5 将结尾和署名分开展示，并把两者都纳入系统朗读。
- 长图、短片渲染器尚不存在，微信双真机也未验，因此 FIX-021 的跨全部输出/真机范围仍不能整体关闭。

### CASE-001 脱敏回归

- `packages/contracts/src/fixtures/case-001.ts` 固定三条审核后事实、合成 UUID、单版草稿和安全断言。
- contracts 测试锁定中性称呼、不确定词降级、第三方隐私、禁止购买/食用/功效推断和来源覆盖。
- API 测试覆盖“生成 -> 确认 -> 公开 Reader DTO”，并验证公开响应不包含 CASE ID、内部对象键、用户 ID 或真实文件名。
- fixture 不含原始媒体、原始 ASR、绝对路径或访问凭据；它不证明真实 OpenAI、三版选择或真人测试已完成。

### 交付与质量

- 产品体验包改为 ZIP 根目录直接出现入口，包内 README 使用正确相对路径，并在生成后自动检查三个必需文件。
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
# 窗口 2
pnpm dev:web
```

新电脑没有 D 盘时，不要硬编码盘符；可将打包输出显式改到该电脑的临时目录：

```powershell
$outputRoot = Join-Path $env:TEMP 'warm-letter-ai-family-delivery'
powershell -ExecutionPolicy Bypass -File .\scripts\create-product-demo-package.ps1 -OutputRoot $outputRoot
```

## 5. 受控素材与移交问题

| 项目 | 当前状态 | 接手动作 |
| --- | --- | --- |
| 原始照片/语音 | 仅允许队内受控展示，未取得公开传播授权 | 指定一名真人负责人保管，并记录访问人员和删除要求 |
| 原始来源位置 | 不写入仓库；由移交人在线下确认团队受控存储位置 | 接手当天验证可访问性和 SHA-256 |
| 证据附件重建 | 仓库不能独立重建 | 保留上节指定 ZIP，不要用相似名称旧包替代 |
| 完整使用与融合教程 | 辅助材料清单中提到，但已访问目录未找到 | 由材料提供者补交，不能用“实际成果册”冒充 |
| 真人测试 | 工具和工作簿已准备，尚无 6 名真人评分 | 完成 3 名年轻用户和 3 名长辈测试并复测问题 |

## 6. 尚未完成的门禁

- 真实 OpenAI 照片、截图、中文语音和文字四素材端到端调用及事实核验录像。
- 微信正式 `code2Session`、HTTPS API、两账号/两设备分享、媒体播放、回复和错误 token 真机证据。
- PostgreSQL、S3/OSS、独立队列、跨实例限流、正式内容审核、删除 SLA 和生产部署。
- 从同一 `confirmedDraft` 生成的 1080 px 长图和短片，以及署名一致性验证。
- 3 名年轻用户和 3 名长辈的真人测试、问题返修与通过结论。
- 比赛录屏、PDF、AIGC 声明、平台账号和正式提交回执。

## 7. 推荐推进顺序

1. 用受控、已授权的脱敏四素材完成真实 OpenAI 请求，保存结构化输出、`sourceRefs`、失败/重试和人工事实核对证据。
2. 配置正式微信环境，在两台设备上完成上传、寄出、阅读媒体、回复、回查和失效链接负向流程。
3. 决定持久化、对象存储、审核、共享限流和删除架构，再进入 G2 真人用户测试。
4. 从 `confirmedDraft` 实现 1080 px 长图，确认正文/署名一致和无溢出后再复用到短片。

## 8. 移交完成清单

- [ ] 接手人核对分支 HEAD、Node/pnpm 版本并运行全部本地门禁。
- [ ] 接手人完整操作产品体验包，能复述它与真实 AI/真机证据的区别。
- [ ] 团队指定受控素材负责人，确认授权范围、存储位置和附件包 SHA-256。
- [ ] 接手人选择第 7 节的一项 P0 工作，并先定义可复核证据再编码。
- [ ] 每次阶段更新记录完成事实、证据链接、剩余风险和下一步前三项。

## 9. C 盘占用说明

仓库和既有 `node_modules` 位于 C 盘工作区，这是项目源码与依赖本身。2026-08-28 本轮新增的测试临时文件、production bundle、浏览器截图、Node 22 运行时、打包 staging 和 ZIP 均写入 `D:\tmp\warm-letter-ai-family` 或 `D:\tmp`；未新增 C 盘任务临时目录，也未修改全局 `TEMP/TMP`。
