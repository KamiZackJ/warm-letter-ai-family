# Warm Letter API development skeleton

Fastify and TypeScript backend for local development and competition demonstrations. All state is held in memory and AI output is produced by a deterministic fake provider, so the product flow can be demonstrated without cloud credentials. This is not an MVP, public-beta, or production release.

## Run

```sh
pnpm --filter @warm-letter/api dev
pnpm --filter @warm-letter/api typecheck
pnpm --filter @warm-letter/api test
pnpm --filter @warm-letter/api demo
```

The server listens on `http://localhost:8787` by default. Set `PORT` or `HOST` to override it.

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

Private endpoints use the development bearer token returned by `wx-login`. Reader and public reply endpoints use the share token returned by the confirm endpoint; public media endpoints use a separate short-lived `mediaToken` bound to one share, letter, and material.

The `AIProvider` interface is the production integration boundary. The default `AI_PROVIDER=fake` path does not require or read an OpenAI key. Real provider mode must be selected explicitly:

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

Set `OPENAI_MODEL` to a model ID enabled for the target OpenAI project; the repository does not hard-code an account-dependent model. The real provider uses Responses structured outputs, sends image bytes as data URLs, uses `original` detail for screenshot OCR, transcribes audio before generation, disables response storage, and records the model ID returned by OpenAI in the draft provider field. Timeout, retry, and image-detail settings are validated at startup. Unknown provider names are rejected, and `NODE_ENV=production` requires an explicit `AI_PROVIDER=openai`; production cannot silently fall back to fake output. Real supplier evidence still requires an authorized photo, screenshot, voice note, and text sample plus an actual API credential; mock-client tests do not satisfy that gate.
