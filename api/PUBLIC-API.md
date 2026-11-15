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
LC1-<T><PPPPPP…><CCCC>
```

| Part | Meaning |
| --- | --- |
| `LC1-` | version prefix; a future change gets `LC2-` rather than silently reinterpreting old codes |
| `T` | tier letter: `a` 1 point, `b` 2, `c` 3–5, `d` 6–12 |
| `PPPPPP…` | 6 chars per patch: 3 for the measured colour, 3 for the intended colour |
| `CCCC` | first 20 bits of SHA-256 over `<T><body>` |

Colours use 5 bits per channel (`step = 8`), packed r→g→b. Alphabet is Crockford-
style without `I L O U`, so a code read aloud or retyped is unlikely to be
ambiguous. The prefix is `LC1` plus a dash which the normaliser strips, so
`lc1 - dyx…`, `LC1-DYX…` and `LC1DYX…` all decode to the same thing.

A full 6-patch code is 45 characters — shorter than a URL and short enough to paste
into a chat message:

```
LC1-DYYXZZZKKJGGG776000RAARAAAKDAKD6DN6DN39Y1
```

## Endpoints

Both are public and stateless. Stored-calibration routes under `/v1/calibrations`
keep the bearer key and stay private.

### `POST /v1/public/preset`

Cheap validation: decode, re-fit, report. No image work.

```json
{ "code": "LC1-DYYX…" }
```

```json
{
  "code": "LC1-dYYX…",
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
{ "code": "LC1-DYYX…", "imageBase64": "iVBORw0KG…" }
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
