# 微信内容安全接入与发布边界

核对日期：2026-09-23。自动化测试使用合成数据和本地 HTTP 服务；真实环境已验证微信文字检查及加密媒体回调接收，但本轮媒体回调返回下载失败，不能声称素材审核通过或已正式发布。实时结果见[发布记录](./PRODUCTION_RELEASE_1_0_0_2026-09-23.md)。

## 文本安全

`createContentSafetyProviderFromEnv(env)` 创建服务端 `WechatContentSafetyProvider`，只读取服务端 `WECHAT_APP_ID`、`WECHAT_APP_SECRET`。稳定令牌通过官方 `stable_token` 获取并缓存，合并并发刷新；普通刷新不会主动使其他请求的令牌失效。只有明确的失效令牌错误才重新获取并重试一次，配额错误和风险结果不重试。

```ts
await requireTextSafety(provider, {
  content: finalText,
  openId: authenticatedUser.openId,
  scene: 4, // 家书为社交日志；回复用 2（评论）。
});
```

文本接口固定使用 version=2，一次最多 2500 个 Unicode 字符；不截断未审内容。只接受完整、有效的 `result.suggest=pass`。`review` 和 `risky` 均阻断发送；只有请求受理标识、异常 JSON、超时、上游失败或配额用尽不能放行。不要把模型自己的“安全”判断代替此结果。

用户 OpenID 必须属于此小程序，且用户近两小时内访问过小程序。`61010` 等身份问题转为 `WECHAT_LOGIN_REQUIRED`，需要客户端重新登录后重试。阅读可匿名，发布回复需要服务端鉴权后取得 OpenID，不能相信客户端提交的 OpenID。

默认 `WECHAT_TOKEN_TIMEOUT_MS=5000`，`CONTENT_SAFETY_TIMEOUT_MS=15000`，范围 500–60000 毫秒。内容审核的总时限包含令牌等待、第一次请求、可选重试和完整响应体。响应体最多 128 KiB，禁止 HTTP 重定向；取消或回收失败不拖延返回，也不记录上游原始错误、用户正文或凭据。

对家书生成输入、生成结果、最终编辑结果和回复分别设置审核点。提交审核后如果正文、称呼、署名或来源改变，不能复用旧结果；发布前检查当前内容与已审核版本的一致性。超过单次上限时应限制输入或按业务独立字段审核，不能悄悄截断。

## 媒体审核

```ts
const receipt = await provider.submitMedia({
  mediaUrl: temporaryReviewUrl,
  mediaType: "image", // 或 audio
  openId: authenticatedUser.openId,
  scene: 4,
});
```

`submitMedia` **只返回 pending 或 unavailable，不返回 allow**。必须将 `traceId`、素材标识、文件内容版本或摘要、所有者、提交时间和截止时间持久化，待收到已验签的最终回调后才能放行该素材。官方回调不提供 `media_type`，通过 `trace_id` 查询原始任务，不猜测媒体类型。重启、超时、下载失败和未知 trace ID 均不能变成审核通过。

官方当前格式和大小限制：

- 图片：jpg、jpeg、png、bmp、gif；gif 只取首帧，不等于逐帧审核。
- 音频：mp3、aac、ac3、wma、flac、vorbis、opus、wav。
- 单个文件不超过 10M。文档未承诺 m4a 容器、HEIC/HEIF、WebP、视频或其他格式，也未给出音频时长上限；不要用文件扩展名“看起来相近”推断兼容。
- URL 必须能被微信检测服务器下载。使用用途独立、有限期、绑定文件版本的审核地址，不公开整个素材目录；审核前验证实际媒体类型与大小。URL 有效期需覆盖下载等待，回调最长可能在 30 分钟内到达。

本实现将 m4a/MP4 与 Ogg 在服务端完整转换为 MP3 再保存为实际分享素材，审核和播放使用同一文件；把 m4a 直接重命名为 aac 不改变容器格式。`prepareMediaForSafety` 仅允许 JPG/PNG/BMP 静态图与当前支持的音频，拒绝 WebP/GIF/HEIC。m4a 输入可能在文件末尾保存索引，使用唯一、受限权限的临时文件提供可定位输入，成功或失败均清理。Windows 调试必须设置 D 盘临时目录，服务器使用私有数据目录。

`normalizeSafetyMaterial` 同时覆盖新上传和旧版本已标记 READY 的素材。上传完成、首次发布和重新分享前均执行；同一仓库与素材的并发请求合并。它读取真实存储内容，转换后通过同步事务比较原 objectKey、类型和状态，仅在素材仍是同一版本时替换，原文件进入持久删除队列，并清除该素材的旧审核记录。删除、覆盖、写入超时或失去比较更新竞争时，新文件只进入删除队列，不恢复被删除的数据；迟到写入会再次登记清理。

发布检查在同一家书快照内进行素材规范化、媒体提交与文本检查，并共享 60 秒总时限；中途修改正文或素材列表会要求重新确认。超时只保留草稿，迟到的规范化结果不能继续触发后续审核或发布。规范化替换文件期间迟到的旧媒体受理响应也不能写回该素材的审核记录。

转码限制为最多两个并行子进程、输入 25 MiB、输出 10 MiB、完整操作 15 秒。固定本地 demuxer、禁用网络协议、禁止 shell、单线程；输出超大或超时就终止进程并丢弃部分结果，不截断后放行。`max_alloc` 限制单项分配，不是操作系统级进程总内存隔离；正式服务另由进程/容器资源上限约束。

媒体协调器持久记录 `pending/pass/reject/failed`；最终回调只更新最新、35 分钟内、尚未完成的任务，旧回调、迟到回调和重复回调不能取得发布权限。`failed`（例如微信下载失败）一分钟后允许重试，`reject` 不自动重审。未返回 trace ID 的受理失败也有本进程一分钟冷却。异步回调早于提交响应持久化时返回可重试失败，让平台重推。

审核故障的私密记录只保留安全整数 `diagnostic.wechatErrorCode` 和有限枚举 `diagnostic.reason`（`provider/risky/review`），不保存原始回调、错误正文、OpenID、签名 URL 或凭据。诊断字段可随 SQLite 持久保存；已有旧失败记录不能凭空补回错误码。HTTP 200 / `success` 只说明接收回调，必须继续核对对应任务的审核结论。

本轮真实照片和 MP3 的回调错误为 `-1008`，官方定义为微信下载失败，不代表内容违规。排查时依次核对签名有效期、正确媒体类型和文件头、无需登录及重定向的公网下载、DNS、TLS 证书及客户端兼容性；自有客户端返回 200 不能替代微信的下载结果。每次明确调整后有限复测，保留冷却，不循环重传素材、重新生成家书或强行将失败改成通过。

2026-09-23 14:12:26–14:13:26 UTC 的首轮有界双向 TCP 443 诊断覆盖一次原素材复测，60 秒共 303 包、104,404 字节，未触及采集上限。与审核同时出现的 12 条相同特征连接带正确 API SNI，并声明 TLS 1.2、ECDHE-RSA/ECDSA AES-GCM 支持；记录到服务器 ServerHello 和后续客户端 RST，未见可靠明文 Alert。API 日志无任何方法的审核素材请求；该轮 14:13:23.951 和 14:13:25.722 UTC 的两条认证回调均为 `-1008`。本轮抓取长度为 1600 字节且未分析更早的 FIN；此前据 RST 次序将故障归到“收到握手回复后、HTTP 前”的推断不能成立，应以下述完整抓取复核为准。TLS ChangeCipherSpec 之后的 Alert 可能已加密，不应将其字节误读为明文错误码。原始抓取只留服务器私密目录，不上传仓库或公开报告。

15:11:58.759–15:12:58.827 UTC（北京时间 23:11:58.759–23:12:58.827）的完整抓取包含 350 包、148,524 字节，28 条连接均双向；抓取长度 65,535 字节，无截断，未触及 2 MB 预算。12 条声明 56 个密码套件的连接，在发送 269 字节 ClientHello 后 0.012–0.185 毫秒就发出 FIN，全部早于服务器首个 TLS 数据；后者出现在 ClientHello 后 2.416–3.078 毫秒。因此后续 RST 不能作为客户端收到证书后拒绝它的证据。FIN 只说明客户端提前关闭发送方向；这些连接可能是预检或探测，无法仅凭时序确认其来自微信媒体下载器，也不能据此判定证书拒绝、丢包或中间设备故障。

完整 ServerKeyExchange 使用 `rsa_pkcs1_sha512` 和 `secp256r1`，公钥 65 字节、签名 256 字节，均在客户端声明的支持范围内。另 8 条声明 50 个密码套件的连接使用相同签名、曲线和完整三张证书链，其中 4 条进入双方 ChangeCipherSpec 阶段；这不等于素材下载已经成功。本轮确认操作的客户端返回时间为 15:12:25.852 UTC；两条审核记录分别于 15:12:34.312 和 15:12:36.877 UTC 更新为 `failed/-1008`，认证回调返回 200（包含一次重复回调），所有 HTTP 方法的审核素材请求仍为 0。媒体下载失败的根因仍未确定，后续继续核查 URL 和下载链路，不据这些连接尝试更换 CA。

范围：微信媒体异步审核针对上传的用户素材。AI 朗读在合成前审核文字输入；除非业务额外接入朗读成品的媒体任务，不能将此描述为“生成的音频波形也通过了微信媒体审核”。

公开证书链的补充核对：服务器发送 `api.warmjiashu.xyz → Let's Encrypt YR2 → Root YR（由 ISRG Root X1 交叉签名）` 三张证书，OpenSSL 带域名验证最终到 `ISRG Root X1`，返回 `0 (ok)`，符合 [Let's Encrypt 官方默认链](https://letsencrypt.org/certificates/)。三张证书签名均为 `sha256WithRSAEncryption`，不是止于尚未普遍受信的 Root YR 短链。首轮抓取无法核实的 ServerKeyExchange 已由完整抓取补齐，为上述 PKCS#1/SHA-512 与 P-256；现有证据不支持 PSS 不兼容或信任链错误的结论，也不代表所有微信客户端的 TLS 行为均已验收。可用于进一步核查的脱敏材料见[支持草稿](./WECHAT_MEDIA_DOWNLOAD_SUPPORT_DRAFT_2026-09-23.md)，尚未对外发送。

## 消息推送与回调

在小程序后台“开发管理 → 消息推送配置”设置服务器 URL、Token、EncodingAESKey，选择 **安全模式** 和 JSON（模块也兼容标准 XML）。服务端分别配置 `WECHAT_MESSAGE_TOKEN`、`WECHAT_ENCODING_AES_KEY`，不要提交到仓库。

2026-09-23 实际配置页面提示 EncodingAESKey 为 **43 位 A–Z、a–z、0–9 字符**。这是配置页面约束；公开消息推送文档说明的是 `Base64_Decode(EncodingAESKey + "=")` 得到 32 字节密钥，两者需同时满足。本地解密器接受标准 Base64 的 `+`、`/`，不代表微信配置后台也接受它们。

生成时使用安全随机的 32 字节，转为标准 Base64 并去掉最后一个 `=`，仅当结果匹配 `^[A-Za-z0-9]{43}$` 时采用，否则重新生成。这样既符合页面字符提示，也保留规范 Base64 的末尾填充位。不要改用含 `-`、`_` 的 Base64URL，也不要直接拼接 43 个随机字符后假设能通过规范性校验。将同一值同步到服务端和配置页，验证只记录长度、字符集和解码长度的布尔结果，不输出真实密钥。

本轮曾遇到后台提交提示“系统繁忙”，当时尚未观察到微信发起的真实 GET 握手。按上述字符范围重新生成并同步候选密钥后，用户在有效扫码会话内提交成功；2026-09-23 后台保存状态、设置页的安全模式/JSON 和服务器签名 GET 返回 200 均已核实。未取得微信保存接口的详细错误码，因此不把先前“系统繁忙”归因为已证实的单一因素。公网自检和配置成功仍不能替代实际媒体审核事件的落库验证。

```ts
const verifier = new WechatModerationCallbackVerifier({
  token: messageToken,
  appId,
  encodingAesKey,
});
// GET: 回复 verifier.verifyHandshake(query) 原样返回的 echostr。
// POST:
const event = verifier.decodeMediaCheckCallback(query, body);
// null 表示其他已认证事件，可以回复 success，但不能修改审核记录。
// allow/reject/unavailable 仅更新同一 traceId 对应的任务；处理必须幂等。
```

GET 握手按官方文档校验 `signature`；安全模式 POST 校验包含密文的 `msg_signature`，不使用普通 `signature` 代替。模块验证 ±5 分钟时间窗、AES-256-CBC、32 字节 PKCS#7 填充、解密后的 AppID、事件类型和版本。XML 解析拒绝 DTD、外部实体、属性、超限嵌套和歧义关键字段。安全模式可兼容微信官方公开的加密样例，已有固定向量测试。

默认拒绝明文 POST。仅显式传 `allowPlaintext:true` 可兼容旧标准：其 SHA1 签名只覆盖 URL 参数，不保护正文完整性，正式环境应保持 AES 安全模式。回调路由不要记录查询参数、密文或解密正文；未知/过期/重复事件不会取得其他内容的发布权限。

## 官方依据

- [文本内容安全识别](https://developers.weixin.qq.com/miniprogram/dev/server/API/sec-center/sec-check/api_msgseccheck.html)：含 2500 字限制、近两小时访问要求、scene 和结果字段。未上架小程序文本调用上限为 100 次/天，联调需要控制次数。
- [多媒体内容安全识别](https://developers.weixin.qq.com/miniprogram/dev/server/API/sec-center/sec-check/api_mediacheckasync.html)：支持格式、10M、30 分钟异步推送、回调结构。
- [稳定版接口调用凭据](https://developers.weixin.qq.com/miniprogram/dev/server/API/mp-access-token/api_getstableaccesstoken.html)：7200 秒内有效期、普通刷新、强制刷新限制。
- [消息推送](https://developers.weixin.qq.com/miniprogram/dev/framework/server-ability/message-push)：安全模式配置、签名、AES 协议和官方测试向量。
