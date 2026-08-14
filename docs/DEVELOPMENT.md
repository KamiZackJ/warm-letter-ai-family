# Development

The repository is a pnpm workspace. Use Node.js 22 or newer.

```powershell
pnpm install
pnpm check
pnpm dev:api
```

The default development configuration uses an in-memory repository and a
deterministic fake AI provider. External credentials are only required for
production adapters.
