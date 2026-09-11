# 暖笺主域名绑定执行状态

- 状态时间：2026-09-12 00:31（Asia/Shanghai）
- 主域名：`warmjiashu.xyz`
- GitHub 仓库：<https://github.com/KamiZackJ/warm-letter-ai-family>
- 绑定提交：`346a7f3a659905536a3d4a4084fc601863fd5307`
- 当前阶段：DNS 已开始传播，HTTP 已可访问，等待 GitHub TLS 证书签发

## 已完成

1. `.xyz` 官方 RDAP 已确认域名存在，注册日期为 2026-09-09，到期日为 2027-09-09。
2. 阿里云域名列表显示状态“正常”，注册商和 `.xyz` 官方 RDAP 均记录权威 DNS 为 `dns15.hichina.com` 和 `dns16.hichina.com`。
3. GitHub Pages 已将自定义域名设置为 `warmjiashu.xyz`。
4. 发布目录已加入 `docs/product-demo/CNAME`，内容为 `warmjiashu.xyz`。
5. `master` 与 `codex/warm-letter-mvp` 均已更新到 `346a7f3`，CI 与最终 Pages 部署成功。
6. 阿里云云解析已添加并启用以下 5 条记录：

| 主机记录 | 类型 | 记录值 | TTL |
| --- | --- | --- | --- |
| `@` | A | `185.199.108.153` | 10 分钟 |
| `@` | A | `185.199.109.153` | 10 分钟 |
| `@` | A | `185.199.110.153` | 10 分钟 |
| `@` | A | `185.199.111.153` | 10 分钟 |
| `www` | CNAME | `kamizackj.github.io` | 10 分钟 |

## 已验证

- 直接查询 `dns15.hichina.com`：根域返回全部 4 个 GitHub Pages IP。
- 直接查询 `dns15.hichina.com`：`www` 返回 `kamizackj.github.io`。
- `.xyz` 官方 RDAP 返回域名对象和两条正确 NS；其中 `last changed` 为 2026-09-11 23:50（Asia/Shanghai）。
- 2026-09-12 00:16 直接查询 `.xyz` 顶级域名权威服务器 `x.nic.xyz` 时仍返回 `NXDOMAIN`，说明父区尚未发布约 26 分钟前的注册局更新。
- 2026-09-12 00:31 通过 Google (`8.8.8.8`) 和 114 DNS 查询根域均已返回 GitHub Pages IP；阿里公共 DNS (`223.5.5.5`) 仍返回 `NXDOMAIN`，传播尚未覆盖所有递归节点。
- 将 `warmjiashu.xyz` 临时解析到 `185.199.108.153` 后访问：GitHub Pages 返回项目首页 `HTTP 200`。
- 当前直接访问 `http://warmjiashu.xyz/` 已返回 `HTTP 200`；`https://warmjiashu.xyz/` 和 `https://www.warmjiashu.xyz/` 的证书尚未匹配新域名。
- 最新 Pages 健康检查显示 `dns_resolves=true`、`is_valid=true`、`is_https_eligible=true`、`caa_error=null`；仅 `responds_to_https=false`，`https_error=peer_failed_verification`。
- 2026-09-12 00:34 重新提交相同 Pages 配置时，GitHub 返回 `The certificate does not exist yet`（HTTP 404），确认当前阻塞是证书异步签发而非配置错误。
- GitHub Pages API：`cname=warmjiashu.xyz`，当前 `https_enforced=false`。
- 原 `https://kamizackj.github.io/warm-letter-ai-family/` 已返回 `301` 到 `http://warmjiashu.xyz/`。

## 当前传播状态

`.xyz` 父区更新已经开始向公共递归 DNS 传播，但不同网络仍可能得到 `NXDOMAIN`。阿里云控制台刷新后仍提示 NS 不一致，但注册商和官方 RDAP 中的 NS 已经正确，因此当前不需要再次修改 NS，也不应重复添加或更换 A/CNAME 记录。阿里云提示当日注册、实名或 NS 更新可能存在同步延迟，建议继续等待缓存自然过期。

传播完成前，部分网络可能仍无法打开新域名；已能解析的网络可先通过 HTTP 查看页面。GitHub 仍需为新域名签发 TLS 证书，证书就绪后才能开启强制 HTTPS；在此之前不要把 HTTPS 链接作为正式入口。GitHub 的证书申请是异步流程，通常等待数分钟到数小时，必要时按 24 小时窗口复查。

若到 2026-09-13 00:00（Asia/Shanghai）后，直接查询 `x.nic.xyz` 仍返回 `NXDOMAIN`，应携带域名订单号和本页时间点联系阿里云域名支持，要求核查注册局父区委派；不要先删除现有解析记录。

## 后续验收

按顺序执行：

```powershell
Resolve-DnsName warmjiashu.xyz -Type A
Resolve-DnsName www.warmjiashu.xyz -Type CNAME
curl.exe -I http://warmjiashu.xyz/
curl.exe -I https://warmjiashu.xyz/
gh api repos/KamiZackJ/warm-letter-ai-family/pages
```

完成标准：

1. 主要公共 DNS 均返回 4 个 A 记录，`www` 返回 GitHub CNAME。
2. `https://warmjiashu.xyz/` 返回 `200` 且证书包含该域名。
3. GitHub Pages 显示 `https_enforced=true`。
4. 主页面、`/create.html` 和 `/warm-letter-public-demo.mp4` 均能通过新域名访问。
5. 桌面和手机网络各验证一次，保留旧 GitHub Pages 地址作为排障依据。

## 后续小程序边界

`api.warmjiashu.xyz` 与 `media.warmjiashu.xyz` 本次没有添加任何 DNS 记录，它们继续为后端和媒体服务预留。主域名绑定只解决展示站网址，不会自动获得 API、数据库、AI 密钥或微信小程序生产能力。
