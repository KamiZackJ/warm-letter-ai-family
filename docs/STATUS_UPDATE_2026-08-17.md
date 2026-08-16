# 暖笺阶段进度、计划与问题（2026-08-17）

## 已发布且已验证

- 当前分支：`codex/warm-letter-mvp`；当前远端提交：`09f03c159900f9ad329b390b618d99800968d9f9`。
- 草稿 PR：[PR #1](https://github.com/KamiZackJ/warm-letter-ai-family/pull/1)。当前 HEAD 已通过同一 SHA 的 [push CI](https://github.com/KamiZackJ/warm-letter-ai-family/actions/runs/31959509731) 与 [pull request CI](https://github.com/KamiZackJ/warm-letter-ai-family/actions/runs/31959511141)。
- 已发布 `7d0a0c5`：小程序首页、素材页和本地存储的选择会话恢复，使用 `{ sessionId, revision, ids }` 快照处理读取失败、失效会话、导航失败和过期写入；其 [push](https://github.com/KamiZackJ/warm-letter-ai-family/actions/runs/31957578097) 与 [PR](https://github.com/KamiZackJ/warm-letter-ai-family/actions/runs/31957580110) CI 均成功。
- 已发布 `82e6ca4`：小程序 Reader 的来源追溯、图片/音频恢复、适老字号、回复重试和 Mock 回复幂等；其 [push](https://github.com/KamiZackJ/warm-letter-ai-family/actions/runs/31958094090) 与 [PR](https://github.com/KamiZackJ/warm-letter-ai-family/actions/runs/31958096153) CI 均成功。
- 已发布 `67f003b`：H5 阅读字号持久化、回复请求身份与草稿离开保护、历史回复收纳、媒体裁切与移动端可访问性返修。浏览器已验证 demo 模式下字号切换、回复成功后编辑器保留、320px `scrollWidth/clientWidth = 320/320` 与 1280px 稳定三段字号控件；控制台为 `0 errors / 0 warnings`。
- 每个代码批次均在 `D:\tmp\warm-letter-ai-family\runs\<sha>` 的干净 worktree 上完成冻结依赖安装、`pnpm check`、`pnpm build`、差异和敏感信息扫描。当前冻结回归为小程序 `118/118`、API `131/131`、contracts `12/12`、Web `68/68`。H5 生产 bundle 只使用仓库示例中的非秘密 HTTPS 占位 API 配置验证，未连接或部署生产服务。
- 已发布的前置提交包括：`34a26be`（项目进度基线）、`b2bdaea`（素材上传 pending/completed 共享契约）和 `fc29692`（401 恢复、素材幂等、列表并发清理）。

## 下一步计划

1. 在真实 OpenAI 四素材闭环、正式微信 AppID/HTTPS 和双真机可用后，执行寄信端到收信端的真实端到端验收并归档脱敏证据。
2. 完成 VoiceOver/TalkBack、微信开发者工具系统大字号和真实弱网重试验收；代码级通过不能替代这些设备证据。
3. 建立生产持久化、正式内容审核、删除 SLA、监控、备份和真实后端联调，再评估封闭测试或比赛材料资格。
4. 每批继续显式暂存文件，禁止 `git add -A`；临时文件、浏览器缓存、测试工件和干净 worktree 统一放在 `D:\tmp\warm-letter-ai-family`。

## 未关闭问题与门禁

- 当前项目仍是开发/演示基础，不得表述为 MVP、公测、生产发布或比赛提交候选。
- 尚缺真实 OpenAI 四素材闭环、正式微信 AppID 与 HTTPS、微信双真机及 VoiceOver/TalkBack 验收。
- API 的 `MemoryRepository` 仅覆盖单进程内存场景，不提供重启恢复、多实例一致性或生产持久化保证。
- 正式内容审核、删除 SLA、生产存储、监控、备份、真实后端联调和比赛材料尚未完成。
- 已应用 accessibility、design-system、frontend-design 和 Playwright 设计/验证能力；代码级触控目标、文本换行、AA 对比度和错误重试已覆盖，真实设备验收仍保留为外部门禁。

## 管理方式

- 主项目经理维护批次顺序、证据边界和阶段性汇总；交付项目经理复核提交 SHA、测试日志、敏感信息扫描与双 CI。
- 子代理只用于独立、可验证的专项；其结论必须经过主流程复核，不能替代提交后的远端证据。
- GitHub CLI 已登录并用于草稿 PR 和远端 CI 状态复核；发布结论始终绑定提交 SHA 与 push/PR 两条成功检查。
