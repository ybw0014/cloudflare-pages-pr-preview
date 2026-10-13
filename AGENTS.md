# Repository constraints

- `action.yml` is a composite action; triggers, permissions, and cross-event concurrency belong in the caller workflow.
- Run TypeScript directly on Node 26 with Bun and `bun.lock`; do not add generated `dist` files.
- Never execute PR code; treat artifacts as untrusted and preserve source-identity, stale-run watermark, ZIP-safety, and actual Cloudflare production-branch checks. Only the trusted project lookup and official Wrangler deploy/guard may receive the Cloudflare token.
- Validate with `bun ci`, `bun run format:check`, `bun run lint -- --max-warnings 0`, `bun run typecheck`, `bun run test`, actionlint, action.yml JSON Schema validation, and zizmor. actionlint 1.7.12 may falsely flag `queue: max` in the README caller example; suppress only that exact diagnostic/location, never use broad ignores.
- Focused association test: `node --test test/associate.test.ts`.
