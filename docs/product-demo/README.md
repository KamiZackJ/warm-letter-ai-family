# 暖笺融合产品演示

`index.html` 是“队友第二部分内容成果 × 本项目产品闭环”的统一演示页。它不再把队友材料放在独立附件页里，而是让同一个 CASE-001 走完：

1. 查看并选择队友提供的照片、语音；
2. 比较队友完成并核验的 A/B/C 三版家书；
3. 选择一版，编辑并重新核对段落来源；
4. 固定为确认快照；
5. 在收信端查看同一版本、切换字号、展开来源、播放原音并回复。

## 两种数据模式

仓库默认携带 `demo-case.js` 脱敏配置，只含审核后的三版文字、事实映射与验收编号，不含照片和语音。

受控团队版由 [`scripts/create-controlled-case-demo.ps1`](../../scripts/create-controlled-case-demo.ps1) 从队友成果包构建。脚本会校验照片、m4a 和三版 TXT 的 SHA-256，在 `D:\tmp` 生成删除右侧人物像素的裁切图，并用同目录相对路径装入媒体。构建和门禁见 [`docs/CONTROLLED_CASE_DEMO.md`](../CONTROLLED_CASE_DEMO.md)。

## 展示口径

- 照片、语音、A/B/C 三版和 T01-T07 是队友提供并人工核验的固定成果。
- 三版比较是本地融合演示层，不代表当前 API 已实现实时三版生成。
- 编辑、四态来源归因、确认快照、H5 阅读控制和回复有本仓库工程实现支撑。
- 页面不调用实时 OpenAI，也不证明微信双真机、真人测试或生产部署完成。
- 原始照片不进入 Git 或受控展示 ZIP；ZIP 只含物理裁切派生图。原始 m4a 仅限团队授权范围内受控传阅。

## 打开方式

仓库脱敏版可直接双击 `index.html`，页面会明确标注“受控媒体未装入”。给队友展示真实材料时，应发送脚本生成的受控 ZIP；解压后双击 ZIP 根目录的 `index.html`，不要发送旧的合成素材产品包。本机已启动受控静态服务时，也可直接打开 `http://127.0.0.1:4183/`。

若需要核对本仓库 React H5 阅读端对同一批受控材料的接入，请在仓库根目录使用脚本启动 `http://127.0.0.1:4173/`：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-controlled-case-reader.ps1 `
  -MediaDirectory 'D:\tmp\warm-letter-ai-family\暖笺_CASE-001_受控团队成果包_2026-08-28\media'
```

该阅读端只展示受控包中的推荐 A 版；A/B/C 比较、确认快照和完整创作流程仍以本页 `index.html` 为主展示。
