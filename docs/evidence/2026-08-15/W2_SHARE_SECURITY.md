# W2 分享安全收口证据

## 结论

- 最终代码基线：`d1c525db521ac857866c019ac9dc264396c006e3`
- 浏览器与截图基线：`623811bad79748b2b5910614681ac3b2ce4308d3`（最终修复只改变缺失对象的公开错误语义，未重录正常 H5 路径）
- 两名项目经理与独立安全 QA 结论：W2 本地/单实例门禁通过，可提交归档。
- 生产结论：未放行。正式内容审核保持 P0；持久数据库原子约束、共享限流和可信代理保持 P1。

## 独立媒体凭据

- reader 为每个非文本素材签发无状态 HMAC-SHA256 凭据，claims 为 `v/aud/sid/lid/mid/exp`。
- 媒体凭据默认 5 分钟，浏览器验收使用 30 秒；期限始终不超过父分享期限。
- token 绑定父分享、家书和单个素材；不能用于 reader 或 reply。
- 支持多密钥轮换和常量时间验签；生产要求配置 `MEDIA_SIGNING_KEYS`。
- 重签、撤销或父分享过期后，旧媒体凭据立即失效。
- Base64URL payload/签名必须是无填充规范编码；同签名字节的非规范别名返回统一 404，且只消耗 IP 桶，不创建凭据桶。

## 公开错误矩阵

| 场景 | reader | media | reply |
| --- | --- | --- | --- |
| 有效且绑定正确 | 200 | 200 | 201 |
| 缺失、未知、错家书、错素材、非规范编码 | 404 `PUBLIC_ACCESS_NOT_FOUND` | 同左 | 同左 |
| 父分享已撤销 | 410 `SHARE_TOKEN_REVOKED` | 同左 | 同左 |
| 父分享已过期 | 410 `SHARE_TOKEN_EXPIRED` | 同左 | 同左 |
| 媒体自身过期 | 不适用 | 410 `MEDIA_TOKEN_EXPIRED` | 不适用 |
| 家书未发布或确认快照缺失 | 410 `SHARE_UNAVAILABLE` | 同左 | 同左 |
| 有效媒体凭据对应的素材缺失、未就绪、无对象键或底层对象缺失 | 不适用 | 410 `SHARE_UNAVAILABLE` | 不适用 |

公开媒体路由先验证凭据，再读取对象：合法凭据遇对象缺失返回 410，且不包含对象键或 `MATERIAL_OBJECT_NOT_FOUND`；未知、篡改、错绑定和非规范凭据仍统一 404。私有 owner 素材接口保留精确的对象缺失 404。

重签故障注入测试证明：新凭据持久化失败时旧分享仍有效；正常重签后旧 reader/media/reply 全部 410，新 reader/media 200且原回复保留。

## 滥用与回复安全

- reader/media/reply 使用 IP 与凭据双桶、`Retry-After`、窗口恢复和桶数量上限。
- IP 已超限后不会继续为随机猜测 token 分配凭据桶；缺失或非规范媒体凭据只计 IP。
- 回复正文上限 240 字、称呼上限 40 字、每封最多 100 条。
- 正文和称呼都经过同一可注入安全策略；本地兜底覆盖违法、低俗、暴力、歧视和攻击性，超时或策略异常失败关闭为 503。
- 指定违规正文和违规称呼均返回 422 且不落库。
- 120 个并发 reply POST 同时通过异步审核后，仅 100 个成功、20 个返回 `409 REPLY_LIMIT_REACHED`。
- 匿名作者固定返回 `authorVerified: false`，H5/小程序显示“未验证身份”。

## 隐私与客户端

- confirm/reissue/reader/reply 为 `no-store`；媒体增加 `nosniff`；H5 设置 `Referrer-Policy: no-referrer`。
- 日志移除查询串、Authorization、Referer、正文和私有对象字段；公开 DTO 不含 `shareToken/tokenHash/userId/objectKey/openId`。
- H5 将查询 token 迁移到 fragment；媒体到期后重读 reader 获取新 URL，URL 只保留 `mediaToken`。
- 小程序在媒体过期或播放失败时重读 reader；缺少参数或读取失败时显示持久错误、重试和返回首页入口。
- H5 与小程序补充焦点/ARIA、44px 触控区、次级文字对比度和适老字号覆盖。

## 自动验证

- `pnpm check`：contracts 10/10、API 40/40，四工作区 typecheck 通过。
- `pnpm build`：四工作区通过。
- `public-access.test.ts`：11/11，新增合法凭据遇对象缺失 410、无效凭据仍 404 和响应不泄露对象键/存储错误码回归。
- 非规范 Base64URL 同字节别名隔离测试：连续 12 次通过。
- 严格 UTF-8 与乱码扫描：README、docs、apps、packages 共 82 个文本文件，非法 UTF-8、替换字符、私用区字符和 mojibake 特征均 0 命中。
- 浏览器：媒体自然到期/续签、违规输入、匿名回复、重签前后、390/412/1440 三视口通过。
- 截图和交互详情见 [H5_VALIDATION.md](./H5_VALIDATION.md)。

## 生产残余

- P0：生产入口未注入正式内容审核服务，本地规则不能替代供应商审核、申诉和人工修正流程。
- P1：内存仓储原子写入不跨进程，生产需数据库事务、锁或约束。
- P1：限流状态不跨实例共享，生产需 Redis 等共享存储，并配置 `trustProxy`/可信代理与真实客户端 IP。
- 其他 G2 P0：真实 OpenAI E2E、微信生产鉴权、真机双设备、Demo/生产隔离、全量删除生命周期仍未关闭。
