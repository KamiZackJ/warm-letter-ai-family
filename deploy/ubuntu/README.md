# Ubuntu API deployment

This directory contains the reproducible deployment files for the paid Hong Kong lightweight
server. It intentionally contains no credentials.

## Current target

- Host: Alibaba Cloud Lightweight Application Server, Hong Kong international plan
- OS: Ubuntu 24.04
- Public API: `https://api.warmjiashu.xyz`
- Process: Node.js `22.23.2` under systemd
- TLS proxy: Caddy
- Initial release mode: `demo` with real WeChat authentication and deterministic AI

## Live status (2026-09-15)

- `api.warmjiashu.xyz` resolves to the Hong Kong server.
- Caddy serves a publicly trusted certificate and redirects HTTP to HTTPS.
- `warm-letter-api.service` and `caddy.service` are enabled and running.
- [`https://api.warmjiashu.xyz/health`](https://api.warmjiashu.xyz/health) returns HTTP 200.
- The live mode is deliberately non-production: WeChat authentication is configured, but a real
  `wx.login` code still needs end-to-end verification in WeChat DevTools.

See [`../../docs/API_DEPLOYMENT_HANDOFF_2026-09-15.md`](../../docs/API_DEPLOYMENT_HANDOFF_2026-09-15.md)
for operations, verified evidence, limitations and the handoff checklist.

The initial release is an Internet-accessible demonstration, not a production release. The API
still uses in-memory records, local media files, single-process rate limits and deterministic reply
safety. Restarting the process loses letter/session records. Do not describe it as production or as
real-AI evidence.

## Secret setup

Copy `api.env.example` to `/etc/warm-letter/api.env` on the server, replace the two placeholders,
and keep the file owned by `root:root` with mode `0600`:

- `WECHAT_APP_SECRET`: current WeChat server credential
- `MEDIA_SIGNING_KEYS`: at least 32 random bytes encoded as canonical Base64URL

Never put this file in Git, GitHub Actions, Pages, the mini-program package or screenshots.

## Bootstrap

After DNS points `api.warmjiashu.xyz` to the server and the secret environment file exists, use the
feature branch until the deployment changes have been merged to `master`:

```bash
sudo WARM_LETTER_BRANCH=codex/warm-letter-mvp bash /tmp/bootstrap.sh
```

After merge, install the repository copy at `/opt/warm-letter-ai-family/deploy/ubuntu/bootstrap.sh`
and switch `WARM_LETTER_BRANCH` to `master`.

The script installs an exact Node version, pnpm, Caddy and a 2 GiB swap file on a 1 GiB host;
pulls the public repository; installs/builds the workspace; installs systemd/Caddy configs; and
checks the loopback health endpoint.

## Verification

```bash
systemctl status warm-letter-api --no-pager
journalctl -u warm-letter-api -n 100 --no-pager
caddy validate --config /etc/caddy/Caddyfile
curl --fail https://api.warmjiashu.xyz/health
```

Expected health output must explicitly say `deploymentMode: "demo"` and `nonProduction: true`.
Real AI and production mode require separate provider, persistence, object storage, content-safety,
deletion and shared-rate-limit work.
