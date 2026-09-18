# Warm Letter API development skeleton

Fastify and TypeScript backend for local development and competition demonstrations. All state is held in memory and AI output is produced by a deterministic fake provider, so the product flow can be demonstrated without cloud credentials. This is not an MVP, public-beta, or production release.

## Run

```sh
pnpm --filter @warm-letter/api dev
pnpm --filter @warm-letter/api typecheck
pnpm --filter @warm-letter/api test
pnpm --filter @warm-letter/api demo
```

The runtime does not infer a deployment mode. Provide the required values shown in the repository
`.env.example` through the process environment before starting the server; the example is a local
`demo` profile and is not loaded automatically. The server listens on port `8787` and host
`0.0.0.0` by default when those optional values are omitted.

## Runtime isolation

`DEPLOYMENT_MODE` is required and must agree with `NODE_ENV`:

| Mode | Required `NODE_ENV` | AI policy | Current adapters | Release meaning |
| --- | --- | --- | --- | --- |
| `demo` | `development` | Explicit `fake`, `openai`, `deepseek`, or `openai-compatible` | Development auth, memory repository, local files | Non-production demonstration |
| `test` | `test` | Explicit `fake`, `openai`, `deepseek`, or `openai-compatible` | Development auth, memory repository, local files | Automated tests only |
| `competition` | `production` | `openai`, or the exact verified Qwen `openai-compatible` profile | Development auth, memory repository, local files | Non-production competition evidence |
| `production` | `production` | No release configuration is currently accepted | Rejected while development adapters remain | Not currently available |

`PUBLIC_BASE_URL` must be a credential-free HTTP(S) origin. `CORS_ORIGINS`, `UPLOAD_DIR`, and
`AI_PROVIDER` and `AUTH_PROVIDER` are also required. `AUTH_PROVIDER=development` is usable only in
`demo` and `test`. `AUTH_PROVIDER=wechat` uses the server-side `code2Session` adapter and requires
`WECHAT_APP_ID` plus `WECHAT_APP_SECRET`; health reports whether that adapter was actually composed.
Competition mode additionally requires stable `MEDIA_SIGNING_KEYS` and either the OpenAI
credentials or the exact `dashscope-qwen-2026-09-16` OpenAI-compatible profile. Missing,
misspelled, or conflicting values stop startup before storage, AI clients, or the listener are
created.

`GET /health` reports `deploymentMode`, `nonProduction`, and non-sensitive capability labels,
including the configured authentication provider and whether that provider is ready. In
competition mode it deliberately discloses whether authentication is ready, that the repository is
in memory, object storage is local, and reply safety is deterministic. It never returns credentials
or the configured model.

## Demonstrable evidence

`pnpm demo` prints one `DEMO_EVIDENCE` JSON line proving that:

- the input was explicitly registered by the user;
- the generated paragraph contains the selected material ID in `sourceRefs`;
- confirmation time was recorded before publication;
- a tokenized reader link was issued; and
- a family reply was accepted.

The regular tests additionally cover all four MVP material types, user editing, illegal state changes, deleted material rejection, and reader denial before confirmation.

## Development API

- `GET /health`
- `POST /v1/auth/wx-login`
- `GET|POST /v1/materials`
- `POST /v1/materials/presign`
- `PUT /v1/materials/:id/content`
- `POST /v1/materials/complete`
- `DELETE /v1/materials/:id`
- `POST /v1/letters`
- `GET|PATCH /v1/letters/:id`
- `POST /v1/letters/:id/generate`
- `GET /v1/jobs/:id`
- `POST /v1/letters/:id/confirm`
- `POST /v1/letters/:id/share/reissue`
- `DELETE /v1/letters/:id/share`
- `GET /v1/letters/:id/reader?token=...`
- `GET /v1/letters/:letterId/sources/:materialId/content?mediaToken=...`
- `GET|POST /v1/letters/:id/replies`

Private endpoints, including material `presign` and `complete`, use the development bearer token
returned by `wx-login`. The upload PUT is a separate capability-authenticated boundary: send only the
headers returned by `presign`, including the short-lived `x-warm-letter-upload-token` bound to that
material and MIME type. Never forward the API `Authorization` header or cookies to an external
upload URL. Reader and public reply endpoints use the share token returned by the confirm endpoint;
public media endpoints use a separate short-lived `mediaToken` bound to one share, letter, and
material.

`POST /v1/letters/:id/generate` has a single-instance in-memory cost guard with independent IP and
authenticated-user buckets. Defaults are 10 new generation jobs per IP per minute and 3 per user per
minute, configured through `GENERATION_RATE_LIMIT_WINDOW_SECONDS`,
`GENERATION_RATE_LIMIT_MAX_BUCKETS`, `GENERATION_RATE_LIMIT_PER_IP`, and
`GENERATION_RATE_LIMIT_PER_USER`. A rejected request returns `429 RATE_LIMITED` with `Retry-After`.
Replaying an existing job with the same valid `Idempotency-Key` returns that job without consuming a
bucket and remains available even after the caller reaches the limit. This protection is local to one
API process; a multi-instance deployment still requires a shared limiter and trusted-proxy review.

The `AIProvider` interface is the production integration boundary. `AI_PROVIDER` must always be
selected explicitly. The `fake` path is limited to demo and test modes and does not require or read
an OpenAI key. Real provider mode is configured with:

```sh
AI_PROVIDER=openai
OPENAI_API_KEY=...
OPENAI_MODEL=
OPENAI_TRANSCRIPTION_MODEL=gpt-transcribe
OPENAI_TIMEOUT_MS=60000
OPENAI_MAX_RETRIES=2
OPENAI_PHOTO_DETAIL=auto
OPENAI_SCREENSHOT_DETAIL=original
```

Set `OPENAI_MODEL` to a model ID enabled for the target OpenAI project; the repository does not hard-code an account-dependent model. The real provider uses Responses structured outputs, sends image bytes as data URLs, uses `original` detail for screenshot OCR, transcribes audio before generation, disables response storage, and records the model ID returned by OpenAI in the draft provider field. Timeout, retry, and image-detail settings are validated at startup. Unknown provider names are rejected, and competition and production modes cannot silently fall back to fake output. Production startup is additionally blocked until formal authentication, persistent repository, object storage, and reply-safety adapters replace the current development implementations. Real supplier evidence still requires an authorized photo, screenshot, voice note, and text sample plus an actual API credential; mock-client tests do not satisfy that gate.

An endpoint that implements OpenAI-style Chat Completions must use the separately named
`openai-compatible` provider. It is never reported as OpenAI, DeepSeek, Gemini, or Qwen based only
on a configured URL or model string.

The following exact DashScope Beijing profile passed synthetic text, structured-JSON, image, and
M4A transcription probes on 2026-09-16. It is the only OpenAI-compatible profile accepted by
competition mode:

```env
AI_PROVIDER=openai-compatible
OPENAI_COMPATIBLE_API_KEY=replace-with-a-new-server-side-secret
OPENAI_COMPATIBLE_MODEL=qwen3.8-flash
OPENAI_COMPATIBLE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
OPENAI_COMPATIBLE_IMAGE_MODE=native
OPENAI_COMPATIBLE_AUDIO_MODE=streaming-chat-transcription
OPENAI_COMPATIBLE_TRANSCRIPTION_MODEL=qwen3.5-omni-flash
OPENAI_COMPATIBLE_JSON_MODE=json-object
OPENAI_COMPATIBLE_IMAGE_DETAIL=omit
OPENAI_COMPATIBLE_STORE_MODE=omit
OPENAI_COMPATIBLE_VERIFICATION_PROFILE=dashscope-qwen-2026-09-16
OPENAI_COMPATIBLE_MAX_TOTAL_MEDIA_BYTES=12582912
OPENAI_COMPATIBLE_MAX_TRANSCRIPT_CHARACTERS=12000
OPENAI_COMPATIBLE_TIMEOUT_MS=60000
OPENAI_COMPATIBLE_MAX_RETRIES=1
```

`qwen3.8-flash` performs the two non-streaming Chat Completions calls used for drafting and factual
review. Photos and screenshots are sent as `image_url` parts. `qwen3.5-omni-flash` is used only as
a streaming Chat Completions transcription step; MP3, WAV, M4A, and AAC are accepted, and the
transcript is then passed to the writing model as text. `json-object` requests structured JSON.
`IMAGE_DETAIL=omit` and `STORE_MODE=omit` remove unsupported `detail` and `store` request fields;
`omit` is a wire-compatibility setting and is not evidence that the supplier retains no data.

The provider rejects selected image and audio bytes above `12 MiB` in aggregate before inference,
and aborts streaming transcription above `12,000` Unicode characters. For any other compatible
endpoint, keep `OPENAI_COMPATIBLE_VERIFICATION_PROFILE=unverified`, image/audio disabled, and
perform new synthetic probes. `/health` reports configured input modes and whether they are backed
by a named profile matching a prior synthetic probe, but never returns the key, endpoint, or model.

The public non-production API now uses the exact Qwen profile above. A server-side synthetic
text/image/audio probe completed successfully after deployment, but it does not replace an
authorized four-material mini-program E2E, supplier privacy/cost approval, or production evidence.
The active credential appeared in collaboration chat and must be revoked or rotated before broader
distribution. The earlier 2026-09-15 Gemini-labelled proxy failure and the Qwen switch checklist are recorded in
[`../../docs/REAL_AI_PROVIDER_HANDOFF_2026-09-15.md`](../../docs/REAL_AI_PROVIDER_HANDOFF_2026-09-15.md).

For text-only personalization in demo or test mode, an OpenAI-compatible DeepSeek provider is also available:

```env
AI_PROVIDER=deepseek
DEEPSEEK_API_KEY=replace-with-a-server-side-secret
DEEPSEEK_MODEL=deepseek-chat
DEEPSEEK_BASE_URL=https://api.deepseek.com
```

Keep the key only in the API server environment. Never put it in the mini-program, static demo, source code, screenshots, or Git history. This provider deliberately rejects photo, screenshot, and audio materials because a text-only model cannot inspect those bytes. Use a verified multimodal provider when uploaded media must be understood. DeepSeek generation rotates writing direction by draft version and uses a high-diversity prompt while retaining source references and rejecting invented facts. Competition mode rejects DeepSeek because its evidence flow requires all four material types.
