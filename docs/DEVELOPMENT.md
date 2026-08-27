# Development

The repository is a pnpm workspace. Use Node.js `22.23.2` and pnpm `11.19.0`.
The exact versions are defined by `.node-version` and the root `packageManager`
field. Node 24 is outside this repository's supported runtime.

```powershell
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm check
pnpm build
```

Run the two persistent development processes in separate PowerShell windows:

```powershell
# Window 1
pnpm dev:api
```

```powershell
# Window 2
pnpm dev:web
```

The default development configuration uses an in-memory repository and a
deterministic fake AI provider. External credentials are only required for
production adapters.
