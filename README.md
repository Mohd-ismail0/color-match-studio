# ColorFix

ColorFix is a browser-based colour calibration and batch correction tool for
product photos. Use a reference colour card to build a correction matrix, save
versioned calibration presets, and apply a selected revision to large batches of
images in the browser. An optional loopback API stores durable calibration
profiles for workflow use.

## Features

- Calibrate using white/grey/black or a multi-point colour chart
- Rank/conditioning, chromatic-evidence, clipping and desaturation guardrails
  reject destructive fits instead of silently producing a grey batch. The API
  refuses (`422 MATRIX_REJECTED`) a calibration whose only fit is the engine's
  identity fallback, and imported presets are checked with the same guardrail.
- Versioned presets: every save appends an immutable revision with points,
  targets, matrix, algorithm version, diagnostics, fingerprint and provenance.
  Unreadable stored presets are quarantined verbatim (never deleted by a later
  save) and can be exported for recovery.
- Batch workflows select a preset **and an explicit revision** — never an
  implicit "latest"
- Save revisions to a private API, list/get them, and correct by
  `profileId + revision`
- Batch process up to 100 images at once
- Export to JPEG or PNG with configurable quality and suffixes
- Browser batch processing stays local; the API import path fetches calibration
  metadata only

## Tech stack

- Vite + React + TypeScript
- Tailwind CSS + shadcn/ui
- TanStack Query
- JSZip for bulk downloads
- Node.js API (`api/`) with PostgreSQL in deployment (`node:sqlite` for local
  development), worker-thread image jobs, `sharp`

## Getting started

### Prerequisites

- Node.js >= 22.12 and npm

### Local development

```sh
npm install
npm run dev
```

Open http://localhost:8080 in your browser.

Optional API:

```sh
COLOR_API_KEY="<32+ char secret with 8+ distinct chars>" npm run start:api
```

The default store is `~/.local/state/color-match-studio/calibrations.sqlite`
(outside the repo). See [api/README.md](api/README.md) for the full contract,
limits and the PostgreSQL production gate.

## Available scripts

- `npm run dev` - Start the Vite dev server
- `npm run build` - Production build
- `npm run preview` - Preview the production build
- `npm run lint` - Run ESLint
- `npm run typecheck` - Type-check app + API
- `npm test` - Run all Vitest suites (engine, storage, API e2e)
- `npm run test:watch` - Run Vitest in watch mode
- `npm run acceptance` - Real HTTP save → reopen → select → correct check
- `npm run start:api` - Run the loopback calibration API
- `npm run db:migrate` - Apply the checked-in PostgreSQL migrations (one-off)
- `npm run db:verify` - Verify the deployed PostgreSQL schema without changing it
- `npm run test:api:pg` - Run the storage contract against PostgreSQL (opt-in)

## Project structure

```
src/
  components/        UI and feature components
  lib/               Shared engine, storage, API client, limits
  pages/             Route-based pages
  types/             Shared TypeScript types
api/
  server.ts          HTTP routes, auth, body limits, protocol safety
  storeContract.ts   Storage interface shared by both backends
  store.ts           SQLite dev store (immutable revisions)
  pg/pgStore.ts      PostgreSQL adapter (pool, transactions, idempotency)
  pg/migrate.ts      Transactional migrations + boot-time schema verification
  migrations/        Checked-in SQL schema
  workerPool.ts      Worker isolation, queue, deadlines
  imagePipeline.ts/sharp decode → shared LUT → PNG
Dockerfile           Stateless API image (pinned Node, PostgreSQL only)
```

## Colour and fidelity contract

- Corrections run in linear sRGB. Browser and API share one quantised 16-bit LUT
  encode, so an 8-bit correction is pixel-identical in both paths. The PNG
  encoders differ (`sharp` vs `canvas.toBlob`), so output files are not
  byte-identical; only the decoded pixels are.
- The API preserves 16-bit input at 16 bits and tags output with sRGB
  `gAMA`/`cHRM`; 8-bit output carries an sRGB ICC profile.
- Untagged wide-gamut inputs are assumed sRGB.
- There are **no ΔE or colorimetric accuracy fixtures**. Guardrails prevent
  known-destructive fits (rank-1 desaturation, midtone crush, extreme clipping)
  but do not certify colour accuracy. "Identity preserves pixels" is a
  plumbing test, not colour evidence.

## Deployment notes

The SPA is static; build it and serve `dist/`. The API image is stateless and
stores calibration data in a dedicated PostgreSQL database/role; the checked-in
migration is applied as a separate controlled step and the API refuses to boot
against an absent or mismatched schema. SQLite remains a local-development
backend only. See [api/README.md](api/README.md) for environment variables,
migration and TLS details. Four remaining `npm audit` moderate advisories are
build-time Tailwind 3 packages; runtime dependencies are clear of high/critical
advisories.

## Contributing

Please read [CONTRIBUTING.md](CONTRIBUTING.md) for development workflow and
submission guidelines. All contributors are expected to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Security

If you discover a vulnerability, please follow the guidance in
[SECURITY.md](SECURITY.md).

## License

Licensed under the [MIT License](LICENSE).
