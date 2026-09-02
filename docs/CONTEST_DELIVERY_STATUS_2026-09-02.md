# 暖笺完赛交付候选与移交状态

- 状态时间：2026-09-02 22:48 +08:00
- 当前等级：`G0` 队内受控演示与完赛交付候选
- 公开仓库：<https://github.com/KamiZackJ/warm-letter-ai-family>
- 公开脱敏体验：<https://kamizackj.github.io/warm-letter-ai-family/>
- 默认分支：`master`
- 交付源码提交：`d1e2b572e9e9b96b3f71229e682df201ef08053f`

## 1. 当前做到什么程度

当前已达到“队友可直接体验、评审可按 3 分钟流程查看、下一位成员可按文档接手”的完赛交付候选程度。它不再是队友材料的简单整理，而是把以下成果收口到同一个可移机交付中：

- 队友照片的物理裁切派生图、授权示例语音、A/B/C 固定审核稿、事实映射、隐私审查和 T01-T07。
- 本项目实现的素材选择、三版比较、段落编辑、来源复核、确认快照、收信端字号、来源展开和回复闭环。
- 微信小程序、Fastify API、React H5 和共享契约的工程基线。
- 离线完赛导航、3 分钟讲稿、AIGC/隐私声明、平台提交检查表和接手清单。
- 公开 GitHub Pages 脱敏备用体验，不包含队友真实照片或语音。

## 2. 唯一推荐发送产物

- ZIP：`D:\tmp\warm-letter-ai-family\暖笺_完赛交付候选_2026-09-02-r2.zip`
- ZIP SHA-256：`FF38CCF94962A16FCD362CB0B46A7A5D1FA5D3A9C968DCDF9D1D75C526C46A55`
- 校验文件：同目录 `暖笺_完赛交付候选_2026-09-02-r2.zip.sha256`
- manifest 类型：`warm-letter-contest-delivery-candidate`
- manifest 绑定源码：`d1e2b572e9e9b96b3f71229e682df201ef08053f`
- 受控 CASE-001 源包 SHA-256：`D58EA5C44479677B57207E07090942795952F99C0B17F8648A7BD972FD28D5EF`

不要再发送旧阶段包，也不要发送同日 `r1` 候选包；`r2` 已包含正文逐字输入的光标保留修复。

## 3. 队友如何快速体验

### 无需下载

1. 打开公开脱敏体验链接。
2. 选择素材并加载 A/B/C 三版。
3. 修改一段正文，核对新来源，确认家书。
4. 进入阅读端，切换大字、展开来源并发送本地回复。

这个入口用于快速看产品效果，不展示受控真实媒体。

### 队内完整展示

1. 将推荐 ZIP 解压到一个独立文件夹，不要直接散落解压到桌面根目录。
2. 双击根目录 `START_HERE.html`。
3. 先打开根目录 PDF，再点击“开始操作演示”。
4. 按 `submission/JUDGE_DEMO_RUNBOOK.md` 完成 3 分钟展示。
5. 接手人继续阅读 `handoff/README.md`、`adapter/README.md` 和 `PACKAGE_MANIFEST.json`。

所有核心入口都使用包内相对路径，移动到其他电脑或盘符后不需要改路径。

## 4. 已完成的验证

- 本地 Node `22.23.2` / pnpm `11.19.0`：`pnpm check` 通过。
- contracts `17/17`、Web `75/75`、小程序 `125/125`、API `138/138`，共 `355/355`。
- `pnpm build` 与 Web production bundle verifier 通过。
- ZIP 独立解压复验通过：30 个文件，29 个 payload 全部与 manifest 的大小和 SHA-256 一致。
- ZIP 条目无绝对路径、反斜杠、`..` 或盘符；`START_HERE.html` 的 12 个本地引用全部存在。
- 照片派生图、原始示例 m4a、长图和固定证据哈希通过；原始照片不在包内。
- 包内无 C 盘路径、微信导出路径、原始转写、开发输入、私有提示词或凭据。
- 390 x 844 真浏览器回归通过：无横向溢出，正文逐字输入顺序与光标正常，来源复核和发布锁定正常。
- GitHub Actions：分支 CI、PR CI、`master` CI 和 `master` Pages 部署全部成功。
- PR #1 已合并并关闭；公开仓库默认 `master` 已指向交付提交。

远程证据：

- `master` CI：<https://github.com/KamiZackJ/warm-letter-ai-family/actions/runs/33644247335>
- `master` Pages：<https://github.com/KamiZackJ/warm-letter-ai-family/actions/runs/33644247304>
- PR CI：<https://github.com/KamiZackJ/warm-letter-ai-family/actions/runs/33644220270>

## 5. 当前问题与不得误报的边界

- 当前 CASE-001 是队友提供并人工审核的固定 A/B/C，不是现场实时 OpenAI 生成。
- 尚无真实 OpenAI 四素材端到端证据。
- 尚无微信两账号/两设备的正反向闭环证据。
- 尚无 3 名年轻用户和 3 名长辈的真人测试与复测证据。
- 尚未接入生产数据库、对象存储、正式审核、跨实例限流和删除 SLA。
- 尚未完成比赛平台的团队信息、赛道/话题、AIGC 勾选、最终视频上传和提交回执。

因此对外只能使用“完赛交付候选”，不能写成“已完赛”、“已上线”或“已通过真人验收”。

## 6. 交给下一位负责人的第一小时

1. 用同级 `.zip.sha256` 核对推荐 ZIP，解压到新目录。
2. 从 `START_HERE.html` 走完一次离线演示，并用无痕窗口打开公开仓库和 Pages。
3. 阅读 `submission/SUBMISSION_CHECKLIST.md`，确认比赛平台要求的文件类型、大小、视频时长和团队字段。
4. 按 `submission/JUDGE_DEMO_RUNBOOK.md` 录制或彩排最终视频，不宣称未完成能力。
5. 在平台上如实填写 AIGC 声明，完成提交后保存作品链接、回执截图和提交时间。

## 7. 本机空间与临时产物

- 本轮新增的候选 ZIP、解压核验、QA 截图、Node 缓存和构建临时产物均位于 `D:\tmp\warm-letter-ai-family`。
- 源码仓库检出和现有 `node_modules` 仍位于本机工作区；本轮没有在 C 盘新建交付 ZIP 或 QA 临时目录。
- 队友原始材料只从本机受控来源读取，不在公开文档中记录其绝对导出路径，也不复制进 GitHub。
