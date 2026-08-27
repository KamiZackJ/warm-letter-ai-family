# 暖笺阶段汇报交付包

这是给队友、项目经理和内部评审使用的阶段成果包，不是 GitHub 源码替代品，也不是比赛最终提交包。

## 先看什么

1. 打开 `暖笺_AI产品说明书_阶段版_2026-08-28.pdf`：快速了解产品问题、真实素材接入、AI 价值、工程闭环、隐私边界和下一阶段计划。
2. 打开 `interactive/index.html`：亲手走完“真实素材 -> A/B/C 三版审核稿 -> 来源核对 -> 确认 -> 阅读 -> 回复”。
3. 需要追溯证据时，再看 `interactive/evidence/`、`interactive/manifest.json` 和 `interactive/PROJECT_INTEGRATION.md`。

## 这里展示的是什么

- `interactive/media/case-001-photo-crop.jpg` 是队友生活照片的物理裁切派生图，只保留货架、商品和价签；原图不在包内。
- `interactive/media/case-001-audio.m4a` 是队友提供的原始示例语音，可直接播放。
- `interactive/demo-case.json` 和 `interactive/demo-case.js` 装载队友审核过的 A/B/C 三版家书、事实映射与 T01-T07 安全结论。
- 编辑后来源会进入“待核对”，确认快照后才进入阅读端；这部分是本项目的产品工程承接。

## 必须说清楚的边界

三版文字是队友固定审核稿，离线页面不调用实时 OpenAI；本包不证明真实 OpenAI 四素材端到端、微信双真机、真人用户测试或生产部署已经完成。仓库默认开发演示仍可能使用合成脱敏素材，不能替代这里的 `interactive/` 真实受控案例。

## 交接建议

展示时先讲 PDF，再打开 `interactive/index.html`；接手开发时核对 `interactive/manifest.json` 的哈希和相对路径，随后阅读仓库中的 `docs/CURRENT_HANDOFF_STATUS_2026-08-28.md`。本包没有原始输入、原始转写、系统提示词或测试工作簿，这些材料继续留在团队受控存储中。
