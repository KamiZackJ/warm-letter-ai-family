# 暖笺当前进度、推进计划与问题清单

- 更新时间：2026-08-16 21:36（Asia/Shanghai）
- 仓库：`KamiZackJ/warm-letter-ai-family`
- 分支：`codex/warm-letter-mvp`
- 本次更新前远端 HEAD：`eae660b7b74cd2142101cf272e8cb2399d907f86`
- 已发布功能基线：`cf097586f6eeb09eb7b5bc383c07e492065c5141`
- 上一文档提交：`eae660b`（已推送，push run `31948534413` 与 pull request run `31948537909` 均成功）
- 草稿 PR：[PR #1](https://github.com/KamiZackJ/warm-letter-ai-family/pull/1)
- 文档性质：项目经理阶段快照。只有完成“测试 -> 独立复核 -> 提交 -> 推送 -> 远端 CI 全绿”的内容才计为“已发布”；工作树中的实现统一计为“进行中”。

## 1. 阶段结论

暖笺当前已具备可运行的 Fastify API、React H5 和微信小程序开发/演示骨架，`G0` 内部开发门禁已通过，`W2` 本地/单实例分享安全已有基线。远端 `cf09758` 已发布 API 素材/回复幂等加固：素材同键重放与异内容冲突、预签名/complete 恢复、回复重放先于限流和内容安全、并发同键只写一条、审核期间撤销分享不落库，以及分享 token hash 的 O(1) 索引均已进入草稿 PR。管理文档 HEAD 已推进到 `eae660b`，其 push 与 pull request 两条 GitHub Actions 均成功：

- [push run 31948534413](https://github.com/KamiZackJ/warm-letter-ai-family/actions/runs/31948534413)
- [pull_request run 31948537909](https://github.com/KamiZackJ/warm-letter-ai-family/actions/runs/31948537909)

当前未提交批次集中在 Web 和微信小程序。最新小程序证据为 materials 定向 `42/42`、全量 `117/117`、typecheck 与 `git diff --check` 通过；两条跨 epoch ABA 和 `recorder.stop()` 同步抛错后的迟到回调均有回归，独立评审结论为 GO。根级 `pnpm check` 与 `pnpm build` 已在最终 stop 抛错加固前通过，随后小程序定向、全量和 typecheck 已重新通过；提交前仍会再跑一次根级门禁。上述结果均来自包含未提交改动的工作树，只能作为候选证据，不能绑定为 `cf09758` 或 `eae660b` 的已发布功能证据。

Web 已完成设计高优先返修：照片与聊天截图采用不同裁切策略，回复成功后编辑器保持可用，回复历史默认展示最近三条并支持展开/收起，同时补充跨页面品牌 CSS token。独立复核发现 skip link 会覆盖承载分享凭据的 hash，现已改为阻止默认导航、直接聚焦并滚动正文；键盘 Tab -> Enter 后 hash 保持，刷新仍可读。最新定向 `5/5`、Web 全量 `67/67`、typecheck、`build:test` 与 `git diff --check` 通过。主流程在真实 Chromium 320px 下确认回复请求 `201`、编辑器可见/启用/清空、回复数为 9、横向溢出为 0、console `0 errors / 0 warnings`；独立评审复测 320px 与 1280px 均无横向溢出并给出最终 GO。证据使用 Playwright route 模拟 API，且尚未绑定冻结 SHA/tree，因此仍需提交后验证，不能替代真实后端联调。

小程序恢复批次已继续加固。家书失效 ID 清理基于写回时的最新列表只删除已确认失效项；素材选择采用 `{sessionId, revision, ids}` 原子快照，`goIntent()` 在导航前校验 session、revision、可见 ID 与 `loadError`，重读期间 session 失效会立即返回首页。导航失败不再恢复已暴露给旧 writer 的 session A，而是把旧 IDs 恢复到新的 rollback session C，使 A/B writer 均失效。保存、批量保存、删除和旧页面晚返均按最新快照合并；legacy ID 会过滤、去重、迁移并删除旧键。session 与最新录音 epoch 独立复核均已 GO。

小程序 Mock 契约已本地修复：素材同 ID 同内容重放，异内容冲突；回复按 `[letterId, requestKey]` 同内容重放原回复，异内容冲突，并新增 `mock-idempotency.test.ts`。录音停止已增加 `stoppingRecord` 与 `recordingEpoch`：每次录音重新绑定捕获 epoch 的回调，阻止旧录音的迟到 `onStop/onError` 污染新录音；`recorder.stop()` 同步抛错时也会使当前 epoch 失效并解绑监听。两条 ABA 与同步 stop 失败回归均已通过，独立评审 GO。

小程序 reader 与适老布局也已继续推进：每段展示 `sourceRefs` 来源摘要和展开列表，覆盖失效来源/无来源兜底；大字/特大模式覆盖回复框、来源、错误和辅助文字，回复计数按 Unicode 字符处理；首页草稿提示达到 AA 对比度，长标题/收信人支持两行，素材入口改为两列并放大字号、换行和触控区。这些改动已进入当前 `117/117` 工作树快照，但仍待按批次提交和远端 CI。

设计工作已完成一轮工具调研并应用现有 `frontend-design`、Web Interface Guidelines 与 Playwright 流程。第三方候选包括 Apache-2.0 的 `pbakaus/impeccable` 以及 MIT 的 `wshobson/agents` accessibility/design-system skills；目前尚未安装，后续若采用必须固定 commit、完整审阅 `SKILL.md` 与外部依赖后再进入项目流程。

真实 OpenAI 四素材闭环、微信开发者工具/双真机闭环、正式内容审核、完整删除生命周期、生产持久化与监控、长图短片和比赛提交材料仍未关闭。当前不得宣称达到 `G1`、`G2`、MVP、公测、生产或比赛提交候选。

## 2. 已发布并有远端证据的基线

| 范围 | 当前事实 | 证据边界 |
| --- | --- | --- |
| API | 已发布上传首次写入防覆盖、公开分享安全、文件系统对象/metadata 原子发布，以及素材/回复稳定幂等、丢响应恢复、并发同键收敛和撤销分享竞态保护；`cf09758` 对应 API `131/131` 与 typecheck 通过 | `MemoryRepository` 仅提供单进程内幂等，不代表重启恢复、多实例一致性、生产数据库/对象存储或真实 AI 通过 |
| H5 | 已发布移动端家书正文 20px、分享阅读、媒体恢复和适老基础返修；已记录 Web `38/38` 本地基线 | 不包含当前工作树中的三档字号与回复幂等改动 |
| 小程序 | 已发布环境隔离、上传头部白名单、删除确认、ARIA 和触控热区返修；已记录小程序 `30/30` 本地基线 | 不包含当前工作树中的首页、素材、收信异常恢复批次，也不替代微信运行态验收 |
| contracts | 已记录 `11/11` 本地基线 | 共享 DTO/schema 尚未覆盖全部三端私有模型 |
| GitHub | 功能 HEAD `cf09758`，push run `31943555895` 与 pull request run `31943557728` 两条 `verify` 均成功 | 本次文档更新会形成后继提交；两条既有 CI 只覆盖 `cf09758`，不覆盖当前未提交 Web/小程序工作树 |

## 3. 当前工作树进度

| 工作流 | 已实现或已验证 | 当前状态与剩余工作 |
| --- | --- | --- |
| H5 阅读字号、回复与设计返修 | 已实现 `20/24/28px` 三档字号和偏好持久化；回复使用稳定幂等键，失败重试复用同键；照片/截图分流裁切、编辑器持续可用、最近三条历史及展开/收起、品牌 token 已完成；skip link 不再覆盖分享凭据 hash；Web `67/67`、typecheck、`build:test` 与独立评审 GO | D 盘 Chromium 已验证 320px 发送闭环和键盘 skip link：激活后 hash 保持、正文获焦、刷新仍可读；独立复测 320px/1280px 无横向溢出。待 SHA/tree 绑定、拆分提交和远端 CI；模拟 API 不替代真实后端联调 |
| API 素材/回复幂等 | `cf09758` 已发布素材同键重放/冲突、预签名与 complete 恢复、回复重放先于限流和内容安全、同键并发收敛、撤销分享竞态保护和 tokenHash 索引；API `131/131`、typecheck 与双 CI 通过 | 已发布到草稿 PR；仍受 `MemoryRepository` 单进程边界约束，不能宣称生产幂等 |
| 小程序首页与收信页 | 已覆盖旧数据保留/重试、失败回复复用同一幂等键、编辑中的新输入不被旧成功请求清空、媒体刷新不覆盖新回复、旧音频回调不影响新播放、卸载后不再写 UI 状态；首页 `4/4`、收信页 `11/11` 通过 | 本地实现完成，待独立审查、全量门禁、拆分提交和远端 CI |
| 小程序素材 session/revision 流程 | 选择存储为 `{sessionId, revision, ids}` 原子快照；首页同步启动锁、URL 绑定 session；`goIntent()` 校验 session/revision/可见 ID/`loadError`；导航失败使用全新 rollback session C；素材页最多三次重读，session 失效立即回首页，legacy IDs 会迁移 | materials `42/42`、小程序 `117/117`、typecheck 与独立录音/session 复核均通过；待冻结提交、干净副本复跑和远端 CI |
| 小程序服务与 401 恢复 | 已实现素材上传丢响应恢复与稳定幂等键；业务请求遇到 401 后单飞 `wx.login`，并发请求共享登录，原操作最多重放一次，第二次 401 清 token 并上抛；`listLetters()` 已改为基于写回时最新列表只删除已确认失效 ID；包含列表回归的 P1 定向 `40/40` 通过 | 本地返修已完成但未提交；401 仍缺正式微信运行态证据，列表原子清理仍需在冻结提交上复跑并绑定远端 CI |
| 小程序 Demo 幂等契约 | Mock 素材同 ID 同内容重放、异内容冲突；回复按 `[letterId, requestKey]` 同内容重放原回复、异内容冲突；已新增契约测试并进入 `117/117` | 本地门禁通过；仍待拆分提交、干净副本复跑和远端 CI |
| 小程序 reader 与适老设计 | 已增加每段来源摘要/展开列表、失效/无来源兜底、Unicode 回复计数；大字/特大覆盖回复框、来源和辅助文字；首页与素材页完成 AA 对比度、两列入口、换行、触控区和双行截断返修 | 小程序仍需冻结提交上的设计差异复核与真机字号验收；Web 主流程 Chromium 和独立评审均已 GO，待 SHA/tree 绑定、拆分提交和远端 CI |
| 小程序全量 | materials `42/42`、全量 `117/117`、typecheck 与 diff-check 通过；录音 ABA 独立复核 GO | 结果来自脏工作树，仍需绑定冻结提交 SHA、干净副本复跑和远端双 CI |
| 项目经理与发布复核 | 主项目经理负责收口与推进，独立交付项目经理核对发布证据；小程序录音/session 与 Web skip link 独立复核均为 GO | 每批仍必须绑定提交 SHA、测试日志和双 CI；独立复核不替代提交后验证 |

除本进度文档外，当前工作树快照包含 15 个已修改代码文件和 16 个未跟踪代码/测试文件，横跨 Web、小程序页面、服务层和测试。该批次必须按所有权边界拆分审查和提交，禁止一次性 `git add -A`。

## 4. 推进计划

### P0：收口当前本地批次

1. 归档 Web 独立复核最终 GO，补齐并索引 320/390/768/1440、200% 字体、截图完整显示、历史展开、编辑器持续可用、焦点与控制台证据。
2. 复跑 API、Web、小程序、contracts 全量测试与各端 typecheck，以及根级 `pnpm check`、`pnpm build`、Web `build:test` 和 production bundle verifier；执行敏感信息扫描和 `git diff --check`。
3. 按“小程序 auth/list/service 回归”“素材 session/storage/home/materials/Mock/录音”“reader 来源与适老”“Web 字号/回复/草稿与设计返修”拆分提交；显式暂存文件，禁止 `git add -A`。
4. 每批在 `D:\tmp\warm-letter-ai-family` 下创建冻结提交的干净 worktree，复跑相关门禁并把日志绑定到 SHA/tree。
5. 每个提交推送后分别等待 push 与 pull request 两条 CI 成功；失败即回到对应批次修复，不把后续批次覆盖为绿色结论。
6. 全部 CI 通过后同步 `README.md`、`PROJECT_STATUS.md`、`ACCEPTANCE_CHECKLIST.md` 和证据索引中的最新 HEAD、测试数与未关闭门禁。

### P1：补齐外部验收

1. 使用授权照片、截图、中文语音和文字完成真实 OpenAI 结构化草稿闭环，保存脱敏 request ID、模型、usage、耗时、失败和重试证据。
2. 使用正式微信 AppID、`code2Session`、可达 HTTPS API、体验成员和两台设备完成上传、预览、播放、删除、分享、回复、重签及寄信端回查录像。
3. 落地正式内容审核、完整删除 SLA、生产数据库/对象存储、共享限流、队列、监控和失败补偿。
4. 从同一确认版本产出手书长图和 30 秒以上家书短片，完成许可台账、失败重试和一致性验证。
5. 完成种子家庭观察测试、视频/PDF、AIGC 声明、双话题、报名字段、资格与学校/主体证据归档。
6. 使用正式微信运行态验证现有 401 自动恢复：token 过期、并发请求单飞重登、原操作最多重放一次、第二次 401 清 token，并确认变更请求不产生重复副作用。

## 5. 当前问题与风险

### 代码与验证

- 工作树混合多条工作流且差异较大；必须分批审查、显式暂存文件并独立提交。
- `MemoryRepository` 的素材/回复幂等只覆盖单进程内存，无法提供跨进程重启、多实例或生产持久化保证。
- 已返修、待发布：素材选择旧快照覆盖问题已改为 session/revision 原子快照与条件更新，`listLetters()` 也已基于写回时最新 ID 清理失效项；两项均有本地回归证据，但尚未拆分提交、推送和绑定远端 CI。
- 当前没有已知本地测试阻塞；小程序 materials `42/42`、全量 `117/117`、typecheck 与录音独立复核均通过。
- Mock 素材/回复幂等已修复并补测试，但仍只覆盖单进程内存，尚未拆分提交、推送和绑定远端 CI。
- P2：素材失败动作与回复幂等键只保存在页面实例；卸载后丢响应无法复用同一身份，生产弱网承诺目前只能限定为“同页重试”。
- 小程序回复输入框、来源、错误和辅助文字已随大字/特大模式覆盖；仍需在冻结提交上完成独立设计差异复核和真机字号验收。
- Web 四项设计高优先问题和 skip link 覆盖分享凭据问题已完成本地返修；Web `67/67`、typecheck、构建、主流程 Chromium 复核与独立评审均通过，但冻结 SHA/tree 和远端 CI 尚未绑定。
- H5 本轮真实浏览器验收已完成且控制台 `0 errors / 0 warnings`，但 API 由 Playwright route 模拟；仍缺真实后端联调、弱网和双设备端到端证据。
- 当前全量测试计数来自脏工作树，尚未绑定独立提交 SHA/tree，也未形成每批干净副本日志；不能替代提交后的两条远端 `verify`。
- 小程序 401 自动恢复已有本地测试，但真实 `wx.login` 过期、弱网丢响应、录音权限/双击停止、图片同 URL 重载和音频切换仍缺微信运行态证据。
- “重新生成”并发保护、完整历史家书入口和跨设备历史/署名仍是独立 P1，不能被当前恢复批次顺带视为完成。
- `PROJECT_STATUS.md`、`ACCEPTANCE_CHECKLIST.md` 等旧文档仍可能引用旧 HEAD 或旧 CI；完成当前批次前以本文件的“已发布基线”口径为准。

### 外部门禁

- 缺真实 OpenAI 凭据、模型权限、额度、授权四素材和人工事实基准。
- 缺正式微信 AppID、可达 HTTPS API、体验成员、开发者工具/双真机证据。
- 正式内容审核、完整删除、生产持久化、共享限流、监控和备份策略未闭环。
- 参赛资格、目标期次、学校截止、快手账号、小程序主体、视频、PDF 和报名回执尚未完整归档。

## 6. 项目管理与推进规则

| 角色/工作流 | 当前职责 | 阶段退出条件 |
| --- | --- | --- |
| 主项目经理 | 维护推进顺序、协调实现与复核、阶段性汇总事实，并按风险视情况开启专项子代理 | 所有 P0 问题有负责人、处理结果和验证证据；不得用自报结果代替主流程复核 |
| 独立交付项目经理 | 核对提交边界、SHA/tree、测试日志、敏感信息、远端双 CI 和外部门禁 | 每个发布结论均可追溯到干净提交与远端证据；未关闭门禁明确保留 |
| API 素材/回复幂等专项 | 实现并验证稳定请求身份、丢响应恢复、并发收敛和撤销分享竞态 | 已发布 `cf09758` 且双 CI 通过；生产持久化仍作为独立门禁 |
| Web 回复与字号 | 收口公开回复重试、字号、草稿保护和浏览器证据 | 全量测试/构建通过，浏览器矩阵通过，适老问题关闭或明确保留门禁 |
| 小程序恢复专项 | 收口首页、素材页、收信页的竞争、重试、录音 epoch 和卸载边界 | 本地 materials `42/42`、全量 `117/117`、typecheck 与独立复核 GO；冻结提交、干净副本和远端双 CI 后退出 |
| 设计专项 | 使用固定版本设计 skill 与界面规则复核 reader、适老布局、媒体裁切、编辑器持续可用、历史收纳和跨端 token | 设计 P1 有定向/全量证据并通过独立差异复核；未完成项明确保留为发布门禁 |

- 项目经理每个阶段只更新三类事实：已完成证据、新增问题、下一项可执行工作。
- 任一实现只有在“测试通过 -> 独立复核 -> 提交 -> 推送 -> 最新远端 CI 全绿”后才从“进行中”改为“已发布”。
- 子代理可由项目经理按风险开启，但子代理的自报结果必须由主流程复核，不能直接作为发布结论。
- 当前推进顺序固定为：根级全量门禁与敏感信息扫描 -> 拆分提交 -> 干净 worktree 复跑 -> 每批远端双 CI -> 管理文档同步 -> 外部验收。
- 下一次阶段汇报触发条件：专项代理返回、任一全量门禁失败、至少一个独立提交推送且两条 CI 成功，或出现新的 P0 阻塞。

## 7. 临时文件与证据约束

- 固定运行时：Node.js `22.23.2`、pnpm `11.19.0`。
- `TEMP`、`TMP`、`TMPDIR`、`WARM_LETTER_TMP_DIR` 统一指向 `D:\tmp\warm-letter-ai-family`。
- 测试、构建、浏览器会话、截图、缓存和候选副本不得在 C 盘新建任务临时目录。
- 当前 H5 浏览器证据目录为 `D:\tmp\warm-letter-ai-family\web-design-qa` 与 `D:\tmp\warm-letter-ai-family\web-main-review`。
- 当前关键日志位于 `D:\tmp\warm-letter-ai-family\logs`：`materials-page-stop-throw-final.log`、`miniprogram-full-stop-throw-final.log`、`miniprogram-typecheck-stop-throw-final.log`、`web-full-skip-fragment.log`、`web-typecheck-skip-fragment.log`、`web-build-skip-fragment.log`、`root-check-integrated.log` 与 `root-build-integrated.log`。
- 不提交 API key、访问令牌、原始家庭素材、签名 URL、个人信息截图或未脱敏日志。
