# H5 移动端适老返修复验

- 日期：2026-08-16（Asia/Shanghai）
- 分支：`codex/warm-letter-mvp`
- 基础提交：`71d6aae9ba8bd9025c4310c485f28f9af8809247`
- 复验对象：本证据文件所在提交中的 Web 移动端正文 `20px` 返修
- 运行时：Node.js `22.23.2`、pnpm `11.19.0`
- 浏览器工具：`@playwright/cli`，Vite Demo `http://127.0.0.1:4173/`

## 1. 结果

| 视口 | 家书正文计算字号 | 页面宽度 | 图片解码 | 其他检查 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 320x844 | `20px` | `scrollWidth=clientWidth=320` | `640x480` | 控制台 error/warning 为 0 | 通过 |
| 390x844 | `20px` | `scrollWidth=clientWidth=390` | `640x480` | 回复按钮计算高度 `44px` | 通过 |

两张截图均显示永久 Demo 标识、合成演示图片和系统合成演示语音，不含真实家庭素材、登录令牌或签名 URL。

## 2. 截图与校验值

| 文件 | SHA-256 |
| --- | --- |
| [`h5-mobile-320x844.png`](./h5-mobile-320x844.png) | `E605AF005B09451DD6DC8E097A4C4D5EFD1281D77D2179C24C05331F8EC9FD38` |
| [`h5-mobile-390x844.png`](./h5-mobile-390x844.png) | `2E5B79E64CEAC57777089EB7EEBA2963073A1F22931A2A28CFB1343B384B9467` |

原始 Playwright 会话、CLI 输出和未重命名截图保存在 `D:\tmp\warm-letter-ai-family\playwright-design-qa`，不进入 Git。

## 3. 自动化回归

- Web：测试 `38/38`、typecheck 和 Vite build 通过。
- 小程序：测试 `30/30`、typecheck 通过；新增删除取消/确认行为测试。
- 根级 `pnpm check`、`pnpm build` 和 Web production bundle verifier 通过。

## 4. 证据边界

本记录只证明 H5 移动端正文返修在 320/390 宽度下保持 `20px`、无横向溢出且关键媒体可解码。历史 200% 字体、最长中文、无媒体和其他视口结果仍按对应历史记录管理；本记录不替代微信开发者工具、系统大字号、读屏或真机触控验收，因此不能单独关闭 `FIX-023`、W3 或 G2。
