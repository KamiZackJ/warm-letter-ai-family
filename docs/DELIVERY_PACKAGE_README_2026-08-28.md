# 暖笺阶段汇报、移交与完赛候选包

这是给队友、项目经理、内部评审和下一位接手人使用的阶段成果与完赛候选包，不是 GitHub 源码替代品，也不是已经完成平台回执的最终提交。本包使用已核验的 CASE-001 受控素材和 r2 产品说明书，旧阶段包仅作历史留存。

## 先看什么

1. 双击 `START_HERE.html`：进入离线成果导航，不需安装或修改路径。
2. 打开 `暖笺_AI产品说明书_阶段版_2026-08-28-r2.pdf`：快速了解产品问题、真实素材接入、AI 价值、工程闭环、隐私边界和下一阶段计划。
3. 打开 `interactive/index.html`：亲手走完“真实素材 -> A/B/C 三版审核稿 -> 来源核对 -> 确认 -> 阅读 -> 回复”。
4. 打开 `submission/README.md`：查看完赛候选口径、3 分钟评审讲稿、AIGC/隐私声明和提交检查表。
5. 打开 `handoff/README.md`：查看当前进度、未完成问题、下一阶段顺序和接手首日清单。
6. 打开 `adapter/README.md`：查看本阶段新增的 `confirmedDraft` 长图适配器、验证脚本和共享契约快照。
7. 需要追溯证据时，再看 `interactive/evidence/`、`interactive/manifest.json`、`interactive/PROJECT_INTEGRATION.md` 和根目录 `PACKAGE_MANIFEST.json`。

## 这里展示的是什么

- `interactive/media/case-001-photo-crop.jpg` 是队友生活照片的物理裁切派生图，只保留货架、商品和价签；原图不在包内。
- `interactive/media/case-001-audio.m4a` 是队友提供的原始示例语音，可直接播放。
- `interactive/demo-case.json` 和 `interactive/demo-case.js` 装载队友审核过的 A/B/C 三版家书、事实映射与 T01-T07 安全结论。
- 编辑后来源会进入“待核对”，确认快照后才进入阅读端；这部分是本项目的产品工程承接。
- `adapter/` 是本项目新增的工程产物，不来自队友材料整理：它从共享契约的 `confirmedDraft` 生成 1080 px 长图和审计 manifest，并包含 direct/API 嵌套、长文和拒绝非法输入的验证脚本。
- `handoff/README.md` 汇总项目等级、验证结果、剩余门禁和接手顺序，避免只看到素材包而看不到产品与工程推进。
- `submission/` 汇总公开体验、评审讲稿、AIGC/隐私声明和平台提交负责人必须完成的最后动作。

## 必须说清楚的边界

三版文字是队友固定审核稿，离线页面不调用实时 OpenAI；本包不证明真实 OpenAI 四素材端到端、微信双真机、真人用户测试或生产部署已经完成。仓库默认开发演示仍可能使用合成脱敏素材，不能替代这里的 `interactive/` 真实受控案例。

## 交接建议

展示时从 `START_HERE.html` 进入，先讲 PDF，再打开 `interactive/index.html`；比赛评审按 `submission/JUDGE_DEMO_RUNBOOK.md` 操作，提交前逐项核对 `submission/SUBMISSION_CHECKLIST.md`。接手开发时先核对 `PACKAGE_MANIFEST.json` 与 `interactive/manifest.json`，随后阅读 `handoff/README.md`。展示入口均使用包内相对路径，换电脑或盘符后无需修改；`adapter/scripts/` 是开发验证工具，仍执行当前受控临时目录策略，不是双击展示入口。本包没有原始照片、开发输入、原始转写、系统提示词或测试工作簿，这些材料继续留在团队受控存储中。
