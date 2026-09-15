# Ubuntu API deployment

This directory contains the reproducible deployment files for the paid Hong Kong lightweight
server. It intentionally contains no credentials.

## Current target

- Host: Alibaba Cloud Lightweight Application Server, Hong Kong international plan
- OS: Ubuntu 24.04
- Public demo: `https://warmjiashu.xyz` (activate after the apex and `www` DNS cutover)
- Public API: `https://api.warmjiashu.xyz`
- Process: Node.js `22.23.2` under systemd
- TLS proxy: Caddy
- Initial release mode: `demo` with real WeChat authentication and deterministic AI

## Live status (2026-09-16)

- `api.warmjiashu.xyz` resolves to the Hong Kong server.
- The checked-in Caddy configuration is ready to serve `docs/product-demo` from the apex domain and
  redirect `www` to the apex. DNS still needs to point those two names at the server before Caddy can
  issue their certificates.
- Caddy serves a publicly trusted certificate and redirects HTTP to HTTPS.
- `warm-letter-api.service` and `caddy.service` are enabled and running.
- [`https://api.warmjiashu.xyz/health`](https://api.warmjiashu.xyz/health) returns HTTP 200.
- The live AI provider remains `fake`.
- The exact DashScope Beijing `qwen3.8-flash` + `qwen3.5-omni-flash` profile passed synthetic
  text/image/audio probes, but it is not enabled until the probe key is rotated and the remaining
  privacy, cost, authorized-material E2E and rollback gates are complete.
- The earlier Gemini-labelled third-party proxy remains rejected after all three text models
  returned `503 model_not_found`.
- The live mode is deliberately non-production: WeChat authentication is configured, but a real
  `wx.login` code still needs end-to-end verification in WeChat DevTools.

See [`../../docs/API_DEPLOYMENT_HANDOFF_2026-09-15.md`](../../docs/API_DEPLOYMENT_HANDOFF_2026-09-15.md)
for operations, verified evidence, limitations and the handoff checklist.
See [`../../docs/REAL_AI_PROVIDER_HANDOFF_2026-09-15.md`](../../docs/REAL_AI_PROVIDER_HANDOFF_2026-09-15.md)
for the failed proxy history, verified Qwen profile, privacy boundary and switch gate.

The initial release is an Internet-accessible demonstration, not a production release. The API
still uses in-memory records, local media files, single-process rate limits and deterministic reply
safety. Restarting the process loses letter/session records. Do not describe it as production or as
real-AI evidence.

## Secret setup

Copy `api.env.example` to `/etc/warm-letter/api.env` on the server, replace the two placeholders,
and keep the file owned by `root:root` with mode `0600`:

- `WECHAT_APP_SECRET`: current WeChat server credential
- `MEDIA_SIGNING_KEYS`: at least 32 random bytes encoded as canonical Base64URL

Never put this file in Git, GitHub Actions, Pages, the mini-program package or screenshots. The
credentials used during provider probing appeared in collaboration chat and must be revoked or
rotated. A replacement AI key may be stored only in this server environment after the remaining
switch gates in the real-provider handoff are complete.

## Bootstrap

After DNS points `api.warmjiashu.xyz` to the server and the secret environment file exists:

```bash
sudo install -m 0755 /opt/warm-letter-ai-family/deploy/ubuntu/bootstrap.sh /tmp/bootstrap.sh
sudo WARM_LETTER_BRANCH=master bash /tmp/bootstrap.sh
```

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

Expected live health output must explicitly say `deploymentMode: "demo"`, `nonProduction: true`,
and `capabilities.ai: "fake"`. Real AI requires a provider that passes text, structured-output,
image, audio, privacy and cost gates. Production mode additionally requires persistence, object
storage, content-safety, deletion and shared-rate-limit work.
