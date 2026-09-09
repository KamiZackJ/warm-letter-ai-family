# 暖笺主域名接入状态与 DNS 交接

- 状态时间：2026-09-09（Asia/Shanghai）
- 公开仓库：<https://github.com/KamiZackJ/warm-letter-ai-family>
- 当前线上地址：<https://kamizackj.github.io/warm-letter-ai-family/>
- 当前 GitHub Pages 自定义域名：未配置（GitHub API `cname: null`）
- 当前仓库 `CNAME` 文件：不存在
- 候选主域名：`warmjiashu.xyz`（截图中看到的待购买/待确认域名；尚未在本仓库确认已购买）

这份文件是关机前的移交记录。当前没有执行购买、DNS 修改或 GitHub Pages 自定义域名写入，因此现有 Pages 地址不会受影响。

## 当前完成度

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| GitHub Pages 展示站 | 已完成 | `https://kamizackj.github.io/warm-letter-ai-family/` 可访问 |
| 主域名购买 | 待负责人确认 | 仅有 `warmjiashu.xyz` 候选，不把截图当作付款或实名完成凭证 |
| DNS 解析 | 未开始 | 尚未添加 A/CNAME 记录 |
| GitHub Pages 自定义域名 | 未开始 | `cname` 为空，未开通域名 HTTPS 证书 |
| HTTPS 展示站 | 待绑定后自动签发 | GitHub Pages 会在 DNS 正确后申请证书 |
| API 子域名 | 未开始 | `api.warmjiashu.xyz` 预留给未来后端，不应指向 GitHub Pages |
| 微信小程序 | 后续工作 | 还需要可用 HTTPS 后端、备案/主体材料和微信服务器域名配置 |

## 域名确认后的一次性操作

### 1. 在注册商完成域名状态

确认域名已付款、实名认证通过，并能进入 DNS 解析页面。不要购买“AI 建站”、ECS 或其他推荐附加服务；它们不是 GitHub Pages 绑定的前置条件。

### 2. 添加 GitHub Pages DNS 记录

以 `warmjiashu.xyz` 为主域名时，在注册商 DNS 中添加以下四条 A 记录：

| 主机记录 | 类型 | 记录值 |
| --- | --- | --- |
| `@` | A | `185.199.108.153` |
| `@` | A | `185.199.109.153` |
| `@` | A | `185.199.110.153` |
| `@` | A | `185.199.111.153` |

可再添加：

| 主机记录 | 类型 | 记录值 |
| --- | --- | --- |
| `www` | CNAME | `KamiZackJ.github.io` |

如果注册商已有冲突的 `@` A 记录或 `www` CNAME，先删除冲突记录。DNS 生效可能需要几分钟到 24 小时。

### 3. 在 GitHub Pages 设置自定义域名

进入仓库 `Settings` → `Pages`：

1. 确认来源仍为 GitHub Actions。
2. 在 `Custom domain` 填写 `warmjiashu.xyz` 并保存。
3. 等待 DNS 检查通过和证书签发。
4. 出现 `Enforce HTTPS` 后再勾选它。

绑定成功后，GitHub 可能在 Pages 设置中维护域名记录；不要手动把 `CNAME` 写入 `docs/product-demo`，除非确认工作流会把它复制到 Pages artifact。当前工作流发布目录是 `docs/product-demo`，所以域名尚未确认前不预先添加 CNAME，以免误改线上配置。

### 4. 验收命令

在 PowerShell 中执行：

```powershell
nslookup warmjiashu.xyz
nslookup www.warmjiashu.xyz
Invoke-WebRequest https://warmjiashu.xyz/ -UseBasicParsing
Invoke-WebRequest https://www.warmjiashu.xyz/ -UseBasicParsing
```

两个网址都返回 `200` 后，再把主入口改为：

```text
https://warmjiashu.xyz/
```

仓库 README、比赛文案和视频字幕中的旧 Pages 地址可以保留为备用链接，确认新域名稳定后再统一替换。

## 小程序的域名规划

主域名只负责展示站，未来后端另用子域名：

```text
warmjiashu.xyz       GitHub Pages 展示站
www.warmjiashu.xyz   展示站备用入口
api.warmjiashu.xyz   小程序和 H5 后端 API
media.warmjiashu.xyz 媒体服务（如后续拆分）
```

不要把 `api.warmjiashu.xyz` 的 DNS 指向 GitHub Pages，也不要把 DeepSeek、OpenAI 或豆包密钥放进 Pages、HTML 或小程序代码。小程序正式上线前，需由后端提供稳定 HTTPS、正式鉴权、持久化、限流和内容安全，并在微信公众平台配置合法域名；面向中国大陆的正式服务还要按主体和服务器提供商要求办理 ICP 备案。

## 关机前交接结论

1. 当前项目可继续使用默认 GitHub Pages 地址，未进行任何域名变更。
2. 域名购买和实名审核由负责人登录注册商完成，不能由仓库提交代替。
3. 购买完成后只需把最终域名发给接手人，不要发送注册商密码、支付信息或 API Key。
4. 接手人按本文 DNS → GitHub Pages → HTTPS → 验收顺序操作，再决定是否部署 API 和小程序后端。
