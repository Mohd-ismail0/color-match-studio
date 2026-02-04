# ColorFix

ColorFix is a browser-based color calibration and batch correction tool for
product photos. Use a reference color card to build a correction matrix, save
presets for your studio lighting, and apply the correction to large batches of
images entirely in the browser.

## Features

- Calibrate using white/grey/black or custom color points
- Advanced multi-point correction for higher accuracy
- Save presets locally for repeatable workflows
- Batch process up to 100 images at once
- Export to JPEG or PNG with configurable quality and suffixes
- All processing happens locally for privacy

## Tech stack

- Vite + React + TypeScript
- Tailwind CSS + shadcn/ui
- TanStack Query
- JSZip for bulk downloads

## Getting started

### Prerequisites

- Node.js 18+ and npm

### Local development

```sh
git clone <YOUR_GIT_URL>
cd <YOUR_PROJECT_NAME>
npm install
npm run dev
```

Open http://localhost:8080 in your browser.

## Available scripts

- `npm run dev` - Start the Vite dev server
- `npm run build` - Production build
- `npm run preview` - Preview the production build
- `npm run lint` - Run ESLint
- `npm run test` - Run Vitest once
- `npm run test:watch` - Run Vitest in watch mode

## Project structure

```
src/
  components/        UI and feature components
  lib/               Color correction utilities
  pages/             Route-based pages
  types/             Shared TypeScript types
```

## Deployment

This is a static single-page app. Build the project and host the `dist/`
folder with any static host.

```sh
npm run build
```

## Contributing

Please read [CONTRIBUTING.md](CONTRIBUTING.md) for development workflow and
submission guidelines. All contributors are expected to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Security

If you discover a vulnerability, please follow the guidance in
[SECURITY.md](SECURITY.md).

## License

Licensed under the [MIT License](LICENSE).
