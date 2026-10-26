# Private correction API prototype

Run `COLOR_API_KEY=<protected secret> npx tsx api/main.ts`. Loopback-only, not deployed. POST /v1/correct with Bearer authorization and JSON `{imageBase64,matrix}`. Matrix uses the existing shared correction engine's `{matrix:[[...],[...],[...]],offset:{r,g,b}}` format. Returns PNG; authentication failure 401, invalid input 422, body size 413 and busy 429. No arbitrary URL fetching. API key minimum 32 characters. Never place keys in committed files or chat.

Checks: `npx tsx api/acceptance.ts`, `npm test`, `npm run build`.

Not a complete production workflow: approval/calibration, audit/job persistence, worker isolation, strict MIME/base64 schema, ICC/fidelity fixtures, timeout/resource enforcement and dependency remediation remain release gates. Identity test uses a generated PNG test fixture, not real garment/color calibration evidence. No generated model calls or Saleor writes occur here.
