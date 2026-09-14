# 暖笺公网 API 部署与移交状态

- 状态时间：2026-09-15 02:20（Asia/Shanghai）
- 公网 API：<https://api.warmjiashu.xyz>
- 健康检查：<https://api.warmjiashu.xyz/health>
- 服务器：阿里云轻量应用服务器，中国香港，Ubuntu 24.04
- 服务模式：`demo + WeChat code2Session + Fake AI`
- 结论：可用于团队演示和微信开发版联调，不是生产放行

## 已完成

1. 阿里云 SSH 密钥对已创建并绑定，实例重启后密钥登录验证成功。
2. `api.warmjiashu.xyz` 已添加 A 记录并指向服务器公网 IP `47.82.109.222`，TTL 为 10 分钟。
3. 轻量服务器防火墙已确认开放 TCP `22`、`80` 和 `443`。
4. Node.js `22.23.2`、pnpm `11.19.0`、Caddy `2.11.4` 和 2 GiB swap 已安装。
5. API 以 `warmletter` 非登录系统用户运行；systemd 单元为 `warm-letter-api.service`。
6. Caddy 已获得 `api.warmjiashu.xyz` 的 Let’s Encrypt 证书，并自动完成 HTTP 到 HTTPS 跳转。
7. 私密环境文件只保存在服务器 `/etc/warm-letter/api.env`，所有者为 `root:root`，权限为 `0600`。
8. 可重复部署脚本已收窄为只安装、构建 API 及其共享契约，适配 1 GiB 主机。
9. 微信小程序 `develop` 环境已改为连接 `https://api.warmjiashu.xyz/v1`。

## 已验证

| 验收项 | 结果 |
| --- | --- |
| DNS A 记录 | `api.warmjiashu.xyz -> 47.82.109.222` |
| 严格 HTTPS 请求 | `GET /health` 返回 `200`，无需跳过证书校验 |
| HTTP 跳转 | `http://api.warmjiashu.xyz/health` 返回 `308` 到 HTTPS |
| 服务状态 | `warm-letter-api` 与 `caddy` 均为 `active + enabled` |
| 监听边界 | Node 仅监听 `127.0.0.1:8787`；Caddy 对外监听 `80/443` |
| 运行模式 | `deploymentMode=demo`、`nonProduction=true` |
| 能力声明 | `ai=fake`、`authentication=wechat`、`authenticationReady=true` |
| CORS 正向 | `Origin: https://warmjiashu.xyz` 获得允许头 |
| CORS 负向 | 非白名单 Origin 不获得允许头 |
| 错误脱敏 | 无效微信 code 返回通用 `WECHAT_LOGIN_REJECTED`，不暴露上游详情或凭据 |

`authenticationReady=true` 只证明服务端配置完整。必须在微信开发者工具中使用一次真实
`wx.login` code 并让 `/v1/auth/wx-login` 返回 `200`，才能认定 code2Session 端到端通过。

## 运行与复验

私钥不得进入仓库、压缩包、聊天截图或前端。由移交人通过团队认可的私密渠道交付后，执行：

```bash
ssh -i <PRIVATE_KEY_PATH> root@47.82.109.222
systemctl status warm-letter-api caddy --no-pager
journalctl -u warm-letter-api -n 100 --no-pager
journalctl -u caddy -n 100 --no-pager
caddy validate --config /etc/caddy/Caddyfile
curl --fail http://127.0.0.1:8787/health
curl --fail https://api.warmjiashu.xyz/health
```

部署配置位于：

- `/etc/warm-letter/api.env`：仅 root 可读的环境与凭据
- `/etc/systemd/system/warm-letter-api.service`：API systemd 单元
- `/etc/caddy/Caddyfile`：HTTPS 反向代理
- `/opt/warm-letter-ai-family`：服务器仓库工作树
- `/var/lib/warm-letter/uploads`：当前本地媒体目录

部署变更已快进合入 `master`，服务器也已从 `master` 完成一次重复部署验证：

```bash
install -m 0755 /opt/warm-letter-ai-family/deploy/ubuntu/bootstrap.sh /tmp/bootstrap.sh
WARM_LETTER_BRANCH=master bash /tmp/bootstrap.sh
```

## 当前边界和问题

1. AI 仍为确定性 Fake AI；没有配置任何真实 AI 服务端密钥。
2. 家书、会话和限流状态保存在单进程内存中，服务重启后丢失。
3. 媒体保存在单机文件系统，不是 OSS/S3；没有备份、迁移或多实例能力。
4. 回复安全为确定性规则，不是正式内容审核服务。
5. 无效 code 已证明请求链路可达微信，但尚未使用真实 `wx.login` code 完成成功登录。
6. 微信公众平台的 request、uploadFile、downloadFile 合法域名仍需配置并验证。
7. 香港服务器不能作为中国内地 ICP 备案接入服务器；微信后台是否接受当前域名必须实测。
8. `warmjiashu.xyz` 与 `www.warmjiashu.xyz` 的 GitHub Pages 证书仍不匹配自定义域名；2026-09-15 已重提相同 CNAME 并成功重跑 Pages，开启强制 HTTPS 仍返回 `The certificate does not exist yet`。这与 API 证书相互独立。
9. Pages 当前只发布静态成果展示，不会自动调用新 API。
10. 服务器到期时间为 2026-10-13 23:59:59，自动续费关闭；到期前必须决定续费或迁移。
11. AppSecret 曾进入协作聊天。用户当前决定暂不轮换，但进入真实测试或生产前必须轮换。

## 接手人的最短下一步

1. 在微信公众平台配置 `https://api.warmjiashu.xyz` 为 request、uploadFile、downloadFile 合法域名。
2. 用微信开发者工具导入 `apps/miniprogram`，确认 AppID 后编译 develop 版本。
3. 完成一次真实登录、素材上传、生成、确认、分享、阅读和回复闭环，并保留脱敏验收记录。
4. 修复 GitHub Pages 主域名证书，确认 `https://warmjiashu.xyz` 严格校验通过。
5. 后续部署先在功能分支通过 CI，再快进合入 `master`；服务器只从已审核的 `master` 重部署。
6. 若要声明真实 AI，先选定供应商、创建仅服务端可见的密钥，并完成事实约束、安全与费用验收。
7. 生产化前接入 PostgreSQL、OSS/S3、共享限流、删除链路、备份恢复和正式内容审核。

## 展示口径

可以说：“暖笺已经有公开 HTTPS API，微信鉴权适配器和小程序开发版已接线，当前以 Fake AI
稳定演示完整工程链路。”

不可以说：“暖笺已经生产上线、已经完成真实 AI 调用、已经通过微信真机端到端验收，或数据
已经持久化。”
