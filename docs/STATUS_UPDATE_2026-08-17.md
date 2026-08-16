# 暖笺阶段进度、计划与问题（2026-08-17）

## 已完成且已验证

- 当前分支：`codex/warm-letter-mvp`；当前远端提交：`7d0a0c5e568541bd1161f9a16f21dee6cf749b4b`。
- 草稿 PR：[PR #1](https://github.com/KamiZackJ/warm-letter-ai-family/pull/1)。本批素材选择会话恢复已通过同一 SHA 的 [push CI](https://github.com/KamiZackJ/warm-letter-ai-family/actions/runs/31957578097) 和 [pull request CI](https://github.com/KamiZackJ/warm-letter-ai-family/actions/runs/31957580110)。
- 本批提交 `7d0a0c5` 完成小程序首页、素材页和本地存储的选择会话恢复：使用 `{ sessionId, revision, ids }` 快照，处理读取失败、失效会话、导航失败和过期写入，避免旧页面或旧请求覆盖新选择。
- 已发布的前置提交包括：`34a26be`（项目进度基线）、`b2bdaea`（素材上传 pending/completed 共享契约）和 `fc29692`（401 恢复、素材幂等、列表并发清理）。
- `7d0a0c5` 在冻结候选树上已完成小程序定向测试 `57/57`、小程序全量 `100/100`、API `131/131`、contracts `12/12`、Web `38/38`、各端 typecheck、根级 `pnpm check` 与 `pnpm build`；远端 CI 是发布结论的最终依据。

## 正在推进

1. 单独冻结并提交小程序 Reader、Mock 幂等和回复 API 批次，范围只包含来源展示、适老字号、回复幂等与对应回归测试。
2. 单独冻结并提交 H5 字号、回复草稿保护与设计返修批次，继续以真实浏览器流程和响应式视口检查为准。
3. 每批都在 `D:\tmp\warm-letter-ai-family\runs\<sha>` 的独立临时目录复跑相关门禁，显式暂存文件，禁止 `git add -A`，并等待 push 与 PR 两条 CI 通过后再更新发布状态。

## 未关闭问题与门禁

- 当前项目仍是开发/演示基础，不得表述为 MVP、公测、生产发布或比赛提交候选。
- 尚缺真实 OpenAI 四素材闭环、正式微信 AppID 与 HTTPS、微信双真机及 VoiceOver/TalkBack 验收。
- API 的 `MemoryRepository` 仅覆盖单进程内存场景，不提供重启恢复、多实例一致性或生产持久化保证。
- 正式内容审核、删除 SLA、生产存储、监控、备份、真实后端联调和比赛材料尚未完成。
- 已采用并核验固定版本的 accessibility 与 design-system 设计技能；代码级触控目标、文本换行、AA 对比度和错误重试已覆盖，真实设备验收仍保留为外部门禁。

## 管理方式

- 主项目经理维护批次顺序、证据边界和阶段性汇总；交付项目经理复核提交 SHA、测试日志、敏感信息扫描与双 CI。
- 子代理只用于独立、可验证的专项；其结论必须经过主流程复核，不能替代提交后的远端证据。
- 临时文件、浏览器缓存、测试工件和干净 worktree 统一放在 `D:\tmp\warm-letter-ai-family`，不在 C 盘创建新的任务临时目录。
