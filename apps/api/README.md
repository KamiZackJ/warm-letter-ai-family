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
| `demo` | `development` | Explicit `fake` or `openai` | Development auth, memory repository, local files | Non-production demonstration |
| `test` | `test` | Explicit `fake` or `openai` | Development auth, memory repository, local files | Automated tests only |
| `competition` | `production` | `openai` with credentials is mandatory | Development auth, memory repository, local files | Non-production competition evidence |
| `production` | `production` | `openai` is mandatory | Rejected while development adapters remain | Not currently available |

`PUBLIC_BASE_URL` must be a credential-free HTTP(S) origin. `CORS_ORIGINS`, `UPLOAD_DIR`, and
`AI_PROVIDER` are also required. Competition
mode additionally requires `OPENAI_API_KEY`, `OPENAI_MODEL`, and stable `MEDIA_SIGNING_KEYS`.
Missing, misspelled, or conflicting values stop startup before storage, AI clients, or the listener
are created.

`GET /health` reports `deploymentMode`, `nonProduction`, and non-sensitive capability labels. In
competition mode it deliberately discloses that authentication is developmental, the repository is
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

Set `OPENAI_MODEL` to a model ID enabled for the target OpenAI project; the repository does not hard-code an account-dependent model. The real provider uses Responses structured outputs, sends image bytes as data URLs, uses `original` detail for screenshot OCR, transcribes audio before generation, disables response storage, and records the model ID returned by OpenAI in the draft provider field. Timeout, retry, and image-detail settings are validated at startup. Unknown provider names are rejected, and both competition and production modes require an explicit `AI_PROVIDER=openai`; neither can silently fall back to fake output. Production startup is additionally blocked until formal authentication, persistent repository, object storage, and reply-safety adapters replace the current development implementations. Real supplier evidence still requires an authorized photo, screenshot, voice note, and text sample plus an actual API credential; mock-client tests do not satisfy that gate.
