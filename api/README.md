# Private calibration + correction API

Loopback-only HTTP API for durable, versioned colour-calibration profiles and
image correction by explicit revision. It shares the exact engine used by the
browser (`src/lib/colorCorrection.ts`), so a revision saved from the UI and a
revision replayed through the API use the same fit and the same quantised LUT
encoding.

## Run

Requires Node.js >= 22.12.

### Local development (SQLite)

```sh
COLOR_API_KEY="<at least 32 chars, 8+ distinct>" \
COLOR_DB_PATH="$HOME/.local/state/color-match-studio/calibrations.sqlite" \
npx tsx api/main.ts
```

- The API key is never logged or committed. It must be ≥32 characters, contain
  at least 8 distinct characters and not be a single repeated character.
- With no `DATABASE_URL`, the backend is SQLite. The path defaults to
  `~/.local/state/color-match-studio/calibrations.sqlite`; a path inside the
  repository is refused (override only for throwaway local work with
  `COLOR_DB_ALLOW_REPO=1`). SQLite is refused under `NODE_ENV=production`
  unless `COLOR_DB_ALLOW_SQLITE=1` is set explicitly.
- `PORT` defaults to `8081`. `COLOR_API_HOST` defaults to `127.0.0.1`; set
  `COLOR_API_HOST=0.0.0.0` only for a container or another deliberate
  externally-reachable listener.
- Browser imports are CORS-allowed from `http://localhost:8080` and
  `http://127.0.0.1:8080` by default. Set `COLOR_API_ALLOWED_ORIGIN` to the exact
  production UI origin; there is no wildcard CORS.

### Deployed (PostgreSQL)

```sh
DATABASE_URL="postgresql://color_calibration_app:***@db-host:5432/color_calibration" \
COLOR_PG_SCHEMA=public \
COLOR_PG_SSL=verify-full \
COLOR_PG_SSL_CA=/run/secrets/color-pg-ca.pem \
COLOR_PG_SSL_SERVERNAME=postgres.tail3aaf05.ts.net \
COLOR_API_KEY="<32+ chars>" \
COLOR_API_HOST=0.0.0.0 \
npx tsx api/main.ts
```

`api/.env.example` is the full template. The `Dockerfile` builds the stateless
API image (pinned `node:22.23.1-bookworm-slim`, only `api/package.json`
runtime dependencies, no SQLite volume). It sets `COLOR_API_HOST=0.0.0.0`,
`COLOR_DB_BACKEND=postgres` and `COLOR_DB_MIGRATE=verify` explicitly; every other
value comes from the platform environment.

## Calibration model

A **profile** has a name and an append-only list of **revisions**. Every
revision stores:

- the sampled points and their targets,
- the server-recomputed 3×3 matrix + linear offset,
- mode, `algorithmVersion` (`2.0.0`), mean residual and fit diagnostics,
- guardrail flags (chromatic evidence, conditioning ratio, clipping forecast,
  duplicate roles, destructive fallback),
- a 16-hex content fingerprint and a SHA-256 content hash,
- provenance (source, warnings, notes, revision number, profile id).

Revisions are immutable. SQLite triggers (development) and PostgreSQL triggers
(deployment) reject `UPDATE`/`DELETE` on the revisions table; the API appends a
new revision instead of mutating one.
`latestRevision` is returned in listings for display only — **the correction
endpoint requires an explicit revision number and never falls back to latest**.

### Endpoints

All `/v1/*` routes require `Authorization: Bearer <COLOR_API_KEY>`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Liveness + queue stats (no auth, never blocked by image work) |
| GET | `/ready` | Readiness: pings the durable store (no auth) |
| POST | `/v1/calibrations` | Create profile + revision 1 |
| GET | `/v1/calibrations?limit=50` | List profiles with revision metadata |
| GET | `/v1/calibrations/:id` | Profile + revision summaries |
| POST | `/v1/calibrations/:id/revisions` | Append an immutable revision |
| GET | `/v1/calibrations/:id/revisions/:n` | Fetch one explicit revision (`:n` must be canonical: `^[1-9][0-9]*$`) |
| POST | `/v1/correct` | Correct a PNG/JPEG/WebP/TIFF with a revision or ad-hoc matrix |

`POST /v1/calibrations` and `POST /v1/calibrations/:id/revisions` accept an
optional `Idempotency-Key` header (8–200 characters of `A–Z a–z 0–9 . _ : -`).
Repeating the same request with the same key returns the originally stored
revision (still `201`) instead of appending another one; the key is bound to the
operation, so a create key and an append key never collide.

Create/append body:

```json
{
  "name": "Studio A",
  "points": [
    {
      "id": "p1",
      "label": "White",
      "role": "white",
      "x": 0.1,
      "y": 0.1,
      "sampledColor": { "r": 220, "g": 210, "b": 200 },
      "targetColor": { "r": 255, "g": 255, "b": 255 }
    }
  ],
  "mode": "simple",
  "matrix": { "matrix": [[1,0,0],[0,1,0],[0,0,1]], "offset": { "r": 0, "g": 0, "b": 0 } },
  "algorithmVersion": "2.0.0",
  "notes": ["optional"]
}
```

`matrix` is optional and, when supplied, must match the server-side fit for
those points/mode/version within fingerprint equality; otherwise the API
returns `409 MATRIX_MISMATCH`. The server is authoritative.

Correction body (choose exactly one calibration source):

```json
{
  "imageBase64": "<canonical base64>",
  "calibration": { "profileId": "cal_...", "revision": 3 }
}
```

or `{ "imageBase64": "...", "matrix": { ... } }` for ad-hoc matrices.

A revision-based response includes `X-Calibration-Profile`,
`X-Calibration-Revision` and `X-Calibration-Hash`. The stored revision is
re-hashed, re-validated and re-fit on every use: its matrix must equal the
engine fit for its stored points, so rewriting the matrix — even with a
recomputed content hash — yields `500 REVISION_INTEGRITY`. A stored revision
that can only resolve to the engine's identity fallback is refused with `500
REVISION_REJECTED` rather than used as a no-op correction. The hash and
fingerprint are unkeyed detectors: a full-row rewrite by someone with database
write access is outside this scheme's threat model.

Create/append refuses a destructive fit with `422 MATRIX_REJECTED`. A `201`
therefore always represents a usable correction; it is never an identity
no-op written under a successful status. Revision path segments must be
canonical positive integers — `01`, `1e0`, `1.0` and `+1` return `422
INVALID_REQUEST`.

## Limits and safety

- JSON body ≤ 30 MB, decoded image ≤ 20 MB, ≤ 24 MP / 8192 px edge
  (16-bit images ≤ 12 MP). These match the browser constants in
  `src/lib/calibrationLimits.ts`.
- Strict schemas: exact top-level and nested keys, integer RGB 0–255, finite
  coordinates in [0,1], 1–64 points, bounded names/notes.
- Canonical base64 validation (Node otherwise silently drops junk).
- Image formats: PNG, JPEG, WebP, TIFF. SVG/GIF/HEIF are rejected.
- Each correction runs in a fresh worker thread; the HTTP event loop never
  executes per-pixel code. Jobs have a 30 s deadline and are terminated; queue
  depth is 8 with `429 QUEUE_FULL` + `Retry-After`.
- Oversized bodies receive `413` with `Connection: close` and the socket is
  closed after the response — no half-read keep-alive socket.
- Auth failures are rate-limited per IP (20/min). Errors are structured:
  `{ "error": { "code", "message", "requestId" } }`.

## Fidelity contract (deliberately bounded)

- All maths is in linear sRGB with one shared 16-bit LUT encode; browser and
  API outputs are pixel-identical for 8-bit images. File bytes differ because
  the PNG encoders differ (`sharp` vs `canvas.toBlob`).
- 8-bit output is PNG tagged with an sRGB ICC profile.
- 16-bit input is preserved at 16 bits and encoded as a 16-bit PNG tagged with
  sRGB `gAMA`/`cHRM` (not a full ICC profile).
- Untagged wide-gamut inputs are still assumed sRGB. There are **no ΔE /
  colorimetric reference fixtures**; the guardrails (rank/conditioning,
  chromatic evidence, clipping, desaturation) reject destructive fits —
  including the engine's identity fallback, which is refused with `422` — but
  do not certify colour accuracy.

## PostgreSQL storage (deployed)

The API container is stateless; durable calibration data lives in a dedicated
PostgreSQL database and role. `api/pg/pgStore.ts` implements the same
`CalibrationStoreAdapter` contract as the SQLite dev store
(`api/storeContract.ts`), and every caller awaits it — PostgreSQL access is
asynchronous, so no synchronous shortcut exists.

### Schema and migrations

- `api/migrations/0001_calibration_store.sql` is the checked-in schema:
  `profiles`, `revisions`, `idempotency_keys`, a `reject_revision_mutation()`
  function and `BEFORE UPDATE OR DELETE` / `BEFORE TRUNCATE` triggers.
  `revisions` is keyed by `(profile_id, revision)` and its JSONB columns are
  shape-checked.
- `api/pg/migrate.ts` applies migrations inside **one transaction** (including
  `CREATE SCHEMA` and the `schema_migrations` ledger rows), under an advisory
  lock. It records a SHA-256 checksum per migration and refuses a database whose
  ledger contains an unknown migration or a changed checksum.
- Controlled migration (run as a one-off step, not on every boot):

  ```sh
  DATABASE_URL=... COLOR_PG_SCHEMA=public npm run db:migrate   # --apply
  DATABASE_URL=... COLOR_PG_SCHEMA=public npm run db:verify    # verify only
  ```

- At boot the API **verifies** and refuses to serve unless the schema is present
  and matches this build: schema exists, ledger matches every checked-in
  migration, required tables/columns/types, primary keys, foreign key
  (`ON DELETE RESTRICT`), the immutability triggers and function. It then runs a
  rolled-back write probe that proves `UPDATE`/`DELETE` on `revisions` are
  rejected. A missing table, a dropped trigger, a stale ledger or missing grants
  all stop the process with `SCHEMA_MISSING`/`SCHEMA_MISMATCH`/`SCHEMA_UNVERIFIED`
  and a non-zero exit. `COLOR_DB_MIGRATE=apply` opts into the transactional
  initialise at boot; the default is `verify`.

### Write semantics

- Appending a revision locks the profile row (`SELECT ... FOR UPDATE`), reads
  `MAX(revision)` under that lock and inserts the next number, so concurrent
  appends serialise instead of colliding. Retries re-read after commit.
- Revisions are immutable at the database layer; the API never updates one in
  place. `latestRevision` remains display-only and a correction still requires an
  explicit `revision`.
- Idempotency keys resolve to exactly one revision, so a client retry after a
  timeout does not append a duplicate.

### TLS

`COLOR_PG_SSL=disable | require | verify-full`, default `disable`
(`require` = encrypted without certificate verification, libpq semantics).
`COLOR_PG_SSL_CA` accepts PEM text or a mounted file; `COLOR_PG_SSL_SERVERNAME`
supplies the certificate identity when the connection is made to an IP whose
certificate carries only a DNS SAN.

The homelab database at `192.168.29.175` presents a self-signed certificate with
`CN=postgres.tail3aaf05.ts.net`, a **DNS-only** SAN (no IP SAN), valid to
2036-08-03, SHA-256 `FB:25:C6:28:64:87:BD:F8:48:38:EF:E9:4F:4A:B6:7D:1E:7D:3B:7D:54:4C:22:B3:EA:B0:FD:F7:9C:3A:E0:24`.
Because there is no IP SAN, verify-full against the IP needs
`COLOR_PG_SSL_SERVERNAME=postgres.tail3aaf05.ts.net` alongside the CA, which is
the configuration exercised by the PostgreSQL test suite:

```sh
COLOR_PG_SSL=verify-full
COLOR_PG_SSL_CA=/run/secrets/color-pg-ca.pem   # mount the server certificate/CA
COLOR_PG_SSL_SERVERNAME=postgres.tail3aaf05.ts.net
```

Alternatively, connect through a name that resolves to the database host and
matches the certificate SAN, and omit `COLOR_PG_SSL_SERVERNAME`.

## Tests

```sh
npm test              # engine, storage contract, UI selection and API e2e
npm run acceptance    # real HTTP save → list → get → correct-by-revision
npm run typecheck
```

The storage contract (`api/testing/storeContract.ts`: immutable revisions,
concurrent append numbering, explicit revision lookup, idempotent replay,
reopen) runs against SQLite on every `npm test`. The PostgreSQL suite is
opt-in and only runs against a dedicated test schema:

```sh
COLOR_PG_TEST_URL="postgresql://color_calibration_app:***@db-host:5432/color_calibration" \
COLOR_PG_TEST_SCHEMA=color_match_test \
COLOR_PG_TEST_SSL=verify-full \
COLOR_PG_TEST_SSL_CA=/path/to/ca.pem \
COLOR_PG_TEST_SSL_SERVERNAME=postgres.tail3aaf05.ts.net \
npm run test:api:pg
```

`COLOR_PG_TEST_SCHEMA` must match `^color_match_test[a-z0-9_]*$`; the suite
drops and recreates only schemas with that prefix and never touches `public`.

The API e2e suite covers save → reopen → select revision → correct, immutable
revisions, matrix/version mismatch, malformed base64 and nested schema,
destructive matrices, 16-bit preservation, 413 keep-alive, health during a
24 MP job, queue backpressure and job deadlines. Generated PNG fixtures are
used; no claim of real-world colour accuracy is made.
