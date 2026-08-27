window.WARM_LETTER_DEMO_CASE = Object.freeze({
  schemaVersion: 1,
  caseId: "NUANJIAN-CASE-001",
  mode: "redacted",
  provenanceLabel: "队友第二部分固定审核成果（脱敏仓库版）",
  disclosure:
    "当前仓库版只包含审核后的文字与规则，不包含队友提供的照片和语音。受控团队包会在 D 盘装入物理裁切照片和原始 m4a。",
  photoUrl: null,
  audioUrl: null,
  audioDurationSeconds: 8.895,
  sourceHashes: {
    photoOriginal: "885457751dbc4a9a0fe99fc0d7cfe1b5336c5b6e939beab0f4f1e07b138bf44d",
    audioOriginal: "f9ec48c022bc98d9cc5ac3ff061c65108fe4827ccd8aac9ef1aca15ff88ea4dc",
    draftsOriginal: "72092f4ea003c3aece40b529ef57b121c9300afd7f0315545e11efb37abf5df8",
  },
  recommendedDraftId: "A",
  drafts: [
    {
      id: "A",
      label: "短笺版",
      name: "A｜短笺版（主推荐）",
      body: "亲爱的家里人：\n\n今天上午开了个会，结束时有点累。中午点的外卖意外送了一小瓶饮品，心情也跟着轻松了一点。我还拍下了商店货架上的魔芋爽和9.9元价签，都是很普通的小事，却想讲给你们听。愿你们今天也平安、舒心。\n\n想念你们的我",
      paragraphEvidence: [
        { evidenceIds: ["evidence-01", "evidence-02", "evidence-03", "evidence-04"], sourceRefs: ["voice", "photo"] },
      ],
    },
    {
      id: "B",
      label: "日常版",
      name: "B｜日常版（信息更完整）",
      body: "亲爱的家里人：\n\n今天想和你们分享两件很小的事。上午开了个会，结束时确实有点累；中午点的外卖却意外送了一小瓶饮品，那一刻心情忽然轻松了些。还有一张生活照片，是我在商店里拍到的货架：一排魔芋爽摆得整整齐齐，前面的价签写着9.9元。\n\n这些片段都不是什么大事，却让我觉得，平常的一天也会藏着一点小惊喜。把这点开心也分给你们。愿你们照顾好自己，每天都安稳、舒心。\n\n想念你们的我",
      paragraphEvidence: [
        { evidenceIds: ["evidence-01", "evidence-02", "evidence-03", "evidence-04"], sourceRefs: ["voice", "photo"] },
        { evidenceIds: ["evidence-02", "evidence-03"], sourceRefs: ["voice"] },
      ],
    },
    {
      id: "C",
      label: "留白版",
      name: "C｜留白版（更克制）",
      body: "亲爱的家里人：\n\n上午开完会有点累，好在中午的外卖附送了一小瓶饮品，让我意外地开心了一下。今天还拍到商店里一排魔芋爽和9.9元的价签，顺手把这个日常片段留下来。\n\n生活有时就是这样，一点小小的意外，也能让普通的一天柔软起来。想把这份轻松告诉你们，也祝你们今天顺顺利利。\n\n想念你们的我",
      paragraphEvidence: [
        { evidenceIds: ["evidence-01", "evidence-02", "evidence-03", "evidence-04"], sourceRefs: ["voice", "photo"] },
        { evidenceIds: ["evidence-02", "evidence-03"], sourceRefs: ["voice"] },
      ],
    },
  ],
  evidenceMap: [
    { id: "evidence-01", fact: "上午开会后有点累", source: "语音 0.86-3.14 秒", sourceLabel: "语音 0.86-3.14 秒", sourceRefs: ["voice"], confidence: "高" },
    { id: "evidence-02", fact: "外卖附送一小瓶饮品", source: "语音 3.14-5.86 秒", sourceLabel: "语音 3.14-5.86 秒", sourceRefs: ["voice"], confidence: "中高" },
    { id: "evidence-03", fact: "觉得挺开心", source: "语音 5.86-7.96 秒", sourceLabel: "语音 5.86-7.96 秒", sourceRefs: ["voice"], confidence: "高" },
    { id: "evidence-04", fact: "商店货架、魔芋爽、9.9 元价签", source: "生活照片可见内容", sourceLabel: "生活照片可见内容", sourceRefs: ["photo"], confidence: "高" },
  ],
  safetyTests: ["T01", "T02", "T03", "T04", "T05", "T06", "T07"],
});
