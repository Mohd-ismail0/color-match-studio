# Stateless colour codes (no database)

This adds a public path that needs **no database, no stored profile and no per-user
credential**. A user opens the site, uploads a photo of their reference card, marks
the patches, and gets a short code. That code is the only thing that leaves the
browser.

## Why a code instead of a stored preset

A stored profile means a lookup key, so a lookup means either authentication or an
open door onto everybody's calibrations. A code carries its own evidence: for each
patch, the colour the camera measured and the colour the patch is supposed to be.
The server re-fits the matrix from that evidence with the same engine the
interactive app uses. Nothing is trusted from the client except measurements, and
measurements are range-checked.

Trade-off worth knowing: a code is longer than a profile ID, and it cannot be
revoked or updated in place. For a shop with one card that is a feature — you paste
the same code into every job — and for a one-off user there is nothing to manage.

## Format

```
LC2-<T><RR><CCCCCCCC…><KKKK>
```

| Part | Meaning |
| --- | --- |
| `LC2-` | version prefix; a future change gets `LC3-` rather than silently reinterpreting old codes |
| `T` | tier letter: `a` 1 point, `b` 2, `c` 3–5, `d` 6–12 |
| `RR` | patch roles, 2 bits each, 5 patches per 2-char group |
| `CCCCCCCC…` | 8 chars per patch: 4 for the measured colour, 4 for the intended colour |
| `KKKK` | first 20 bits of SHA-256 over everything before it |

Colours use 6 bits per channel — 64 levels spread across the full 0–255 range, so
pure white and pure black are exact and worst-case error is ~2/255 — packed r→g→b
into 4 chars. Alphabet is
Crockford-style without `I L O U`, so a code read aloud or retyped is unlikely to be
ambiguous. Every dash and space is stripped before parsing, so `lc2 - d7kn…`,
`LC2-D7KN…` and `LC2D7KN…` decode identically.

A full 6-patch code is 57 characters:

```
LC2-D7KNQ7ZZZ460Y3XYZ0MA40C63618J650D2E2Q1Y2N29K91NHBS9RB
```

### Two format changes that were not cosmetic

**5 → 6 bits per channel.** With steps of 8, the quantised matrix differed enough
from the browser's own fit to move output pixels by up to 45/255. 6 bits keeps the
code short enough to paste while staying inside a card reading's noise. The levels
are spread across the whole range rather than stepped from zero: stepping put white
on 252, quietly biasing every target by three counts.

**Roles are carried.** The engine branches on white/grey/black anchors, so the same
six patches fitted without roles produced a visibly different image (up to 59/255 —
gamma makes that gap large near black). The code now says which patch is which, and
the parity test asserts a **0/255** difference against the browser's own path.

The remaining rule for callers: **quantise before you fit.** `quantiseColour()` on
both sides means both fit from identical integers. Fitting the raw values in the
browser and the quantised ones on the server leaves two slightly different matrices,
which is exactly the drift this format exists to prevent.

## Endpoints

Both are public and stateless. Stored-calibration routes under `/v1/calibrations`
keep the bearer key and stay private.

### `POST /v1/public/preset`

Cheap validation: decode, re-fit, report. No image work.

```json
{ "code": "LC2-D7KN…" }
```

```json
{
  "code": "LC2-d7KN…",
  "tier": "d",
  "points": 6,
  "residual": 7.78,
  "warnings": ["This calibration clips about 29% of typical colour channels."],
  "diagnostics": { "clippingFraction": 0.289, "saturationRetention": 0.905, "rank1": false }
}
```

Limit: 60/minute per client.

### `POST /v1/public/correct`

Returns a corrected PNG. Requires the shared access word in
`X-Calibration-Word` (case- and whitespace-insensitive, compared in constant time).

```json
{ "code": "LC2-D7KN…", "imageBase64": "iVBORw0KG…" }
```

Response headers: `X-Calibration-Tier`, `X-Calibration-Points`,
`X-Calibration-Residual`, plus `X-RateLimit-*`.

Limits: 20/minute per client, plus a 600/minute service ceiling.

If `COLOR_API_PUBLIC_PASSPHRASE` is unset the route answers `503
PUBLIC_CORRECTION_DISABLED` rather than quietly accepting anonymous work.

## What is enforced server-side

- **Re-fit, not accept.** Any `matrix` field in the body is rejected as an unknown
  field. The matrix always comes from the engine.
- **Guardrails.** Rank-collapse, midtone crush, clipping and saturation checks run
  on the derived matrix. A code that trips them is refused, not applied.
- **Identity fallback refused.** When the engine decides the patches would destroy
  the image it falls back to identity. For an anonymous request that is an error
  (`PRESET_UNUSABLE`), because "no change" reported as success is worse than a
  refusal.
- **Residual ceiling.** A fit worse than 48/255 display units means the patches
  described nothing usable.
- **Integrity.** Checksum catches transcription damage; rejected points can never
  be fitted or surviving.
- **Parity with the browser.** `src/test/presetParity.test.ts` fits the same card
  both ways and demands byte-identical output.

## Rate limiting behind a proxy

Limits key on the *resolved client address*. `X-Forwarded-For` and
`CF-Connecting-IP` are only read when the TCP peer is listed in
`COLOR_API_TRUSTED_PROXIES`, and even then the nearest untrusted hop wins — a
caller cannot spoof its way around a limit by prepending headers. IPv6 clients are
grouped by /64 for the service-wide ceiling so one host cannot rotate addresses.

Set this to your proxy addresses before exposing the service:

```
COLOR_API_TRUSTED_PROXIES=172.18.0.1,10.0.0.5
```

Without it, every request looks like the proxy and one visitor can exhaust the
allowance for everyone. That failure mode has already been observed on this API
when limits keyed on the socket.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `COLOR_API_KEY` | yes | bearer key for the private `/v1` routes |
| `COLOR_API_PUBLIC_PASSPHRASE` | no | 5–64 chars, ≥3 distinct; opens `/v1/public/correct` |
| `COLOR_API_TRUSTED_PROXIES` | no | comma-separated proxy addresses allowed to forward client IPs |
| `COLOR_API_ALLOWED_ORIGIN` | no | single browser origin allowed to call the API |

Pick a word that is not a dictionary common noun and not your brand name: it is the
only thing between an anonymous caller and CPU time. Rotating it invalidates
nothing else, since no state refers to it.

## Browser page

`/colour-code` (`src/pages/PublicCalibrate.tsx`):

1. upload a card photo (size-capped before any decode)
2. tap each patch; the canvas assigns roles and seeds the target
3. type or pick what each patch should be
4. build the code, copy it

Everything is local until the copy button. The page warns when no white/grey/black
patch was marked, because a colour-only card produces a fit that is hard to trust.

Encoding lives in `src/lib/presetCode.ts` and is compared byte-for-byte against the
server encoder in `api/public.test.ts`, so the two cannot drift apart silently.
The page quantises each measurement before encoding, and shows the quantised value,
so the number a user reads is the number the code carries.

Each patch also has a role selector (white/grey/black/colour). That is not
decoration: role drives which fit the engine performs.

## Testing

```bash
npx vitest run api/public.test.ts   # 20 tests: codes, routes, limits, proxying
npx vitest run                     # full suite
npm run typecheck && npm run build
```

The cross-implementation test is the important one: it feeds 1–12 patch sets into
both encoders and demands identical strings, including the checksum.

## Not covered yet

- No revocation. A leaked code stays valid; the guardrails bound the damage.
- No per-user history. Saving codes is the user's clipboard problem by design.
- Generation, publishing and Saleor writes are unchanged and still disabled.
