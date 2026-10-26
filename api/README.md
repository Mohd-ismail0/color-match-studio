# Private calibration + correction API

Loopback-only HTTP API for durable, versioned colour-calibration profiles and
image correction by explicit revision. It shares the exact engine used by the
browser (`src/lib/colorCorrection.ts`), so a revision saved from the UI and a
revision replayed through the API use the same fit and the same quantised LUT
encoding.

## Run

Requires Node.js >= 22.12 (`node:sqlite`).

```sh
COLOR_API_KEY="<at least 32 chars, 8+ distinct>" \
COLOR_DB_PATH="$HOME/.local/state/color-match-studio/calibrations.sqlite" \
npx tsx api/main.ts
```

- The API key is never logged or committed. It must be ≥32 characters, contain
  at least 8 distinct characters and not be a single repeated character.
- `COLOR_DB_PATH` defaults to
  `~/.local/state/color-match-studio/calibrations.sqlite`. A path inside the
  repository is refused (override only for throwaway local work with
  `COLOR_DB_ALLOW_REPO=1`).
- `PORT` defaults to `8081`; the server binds `127.0.0.1` only.
- Browser imports are CORS-allowed from `http://localhost:8080` and
  `http://127.0.0.1:8080` by default. Set `COLOR_API_ALLOWED_ORIGIN` to the exact
  production UI origin; there is no wildcard CORS.

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

Revisions are immutable. SQLite triggers reject `UPDATE`/`DELETE` on the
revisions table; the API appends a new revision instead of mutating one.
`latestRevision` is returned in listings for display only — **the correction
endpoint requires an explicit revision number and never falls back to latest**.

### Endpoints

All `/v1/*` routes require `Authorization: Bearer <COLOR_API_KEY>`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Liveness + queue stats (no auth, never blocked by image work) |
| POST | `/v1/calibrations` | Create profile + revision 1 |
| GET | `/v1/calibrations?limit=50` | List profiles with revision metadata |
| GET | `/v1/calibrations/:id` | Profile + revision summaries |
| POST | `/v1/calibrations/:id/revisions` | Append an immutable revision |
| GET | `/v1/calibrations/:id/revisions/:n` | Fetch one explicit revision (`:n` must be canonical: `^[1-9][0-9]*$`) |
| POST | `/v1/correct` | Correct a PNG/JPEG/WebP/TIFF with a revision or ad-hoc matrix |

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

## Production gate: external PostgreSQL

The durable store is SQLite for single-instance deployment on a persistent
volume. Production placement on external PostgreSQL is **not implemented** and
must not be implied by "database-backed". Before multi-instance or managed
deployment:

1. Translate `api/store.ts` schema (profiles/revisions, immutability triggers)
   to PostgreSQL, including a migration for existing SQLite rows.
2. Add a connection pool, retry/transaction policy and backup/restore runbook.
3. Re-run `api/acceptance.ts` and the full API test suite against PostgreSQL.
4. Load-test concurrent corrections; worker isolation is per-process, so the
   queue model needs a shared or per-instance admission policy.

Until then: one API instance, durable local disk, no horizontal scaling.

## Tests

```sh
npm test              # 90 tests including engine, storage, UI selection and API e2e
npm run acceptance    # real HTTP save → list → get → correct-by-revision
npm run typecheck
```

The API e2e suite covers save → reopen → select revision → correct, immutable
revisions, matrix/version mismatch, malformed base64 and nested schema,
destructive matrices, 16-bit preservation, 413 keep-alive, health during a
24 MP job, queue backpressure and job deadlines. Generated PNG fixtures are
used; no claim of real-world colour accuracy is made.
