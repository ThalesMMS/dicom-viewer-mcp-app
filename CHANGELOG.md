# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Security

- The HTTP server binds to `127.0.0.1` by default instead of `0.0.0.0` (`--host` / `HOST` to change it, with a warning for non-loopback addresses), which keeps the SDK's DNS-rebinding protection active, and no longer enables CORS for every origin; cross-origin access is opt-in through the `CORS_ORIGIN` allow-list.
- Data embedded into the viewer HTML (`--embed-series`) is serialized so it cannot break out of its `<script>` element (XSS-safe embedding).
- Patient identifiers (such as Patient Name) are no longer read or sent to the UI or the model.

### Changed

- New architecture: the viewer is a static `ui://` HTML resource. The model-visible `view-dicom` tool returns series metadata plus a PNG key image the model can see; the UI fetches 16-bit pixel data on demand through the app-only `get-dicom-slices` tool. The data contract lives in `shared/protocol.ts`.
- Window/level is applied client-side on a canvas, with CT presets (soft tissue, lung, bone, brain, liver, mediastinum) and explicit center/width arguments on `view-dicom`.
- The DICOM folder is configurable with `--dir` / `DICOM_DIR` and defaults to `./dicom` relative to the current working directory. Extension-less files with the `DICM` signature are read as well as `*.dcm`. New `--port`, `--host` and `--help` options.
- Build uses `tsc`, Vite and esbuild (`scripts/build-server.mjs`); **bun is no longer required**. `sharp` was removed.
- Minimum Node.js version is 20.11 (`engines`); the development tooling (Vitest 5, concurrently 10) needs Node.js 22.12.

### Added

- Multiple series per folder, grouped by SeriesInstanceUID and selectable in the viewer; geometric slice ordering by Image Position (Patient).
- Multi-frame images, RGB / YBR_FULL / PALETTE COLOR, MONOCHROME1, signed/unsigned 8/16-bit data with BitsStored masking.
- Files that cannot be displayed (e.g. compressed transfer syntaxes) are listed with a reason in the viewer and the tool result.
- Viewer: window/level drag, pan, cursor-anchored zoom and pinch, invert, reset, fullscreen, overlays (window/level, orientation markers, scale bar), keyboard shortcuts, series dropdown; the current slice and window are reported to the model as text.
- `--embed-series` / `DICOM_EMBED=1` for hosts without the MCP Apps bridge (e.g. Open WebUI).
- `scripts/make-sample.mjs` generates a synthetic CT phantom series for trying the viewer without real data.
- Unit tests (Vitest), ESLint, GitHub Actions CI and Dependabot configuration.

### Fixed

- `dicom/.gitkeep` was never tracked because of a misspelled `.gitignore` exception, so fresh clones had no `dicom/` folder.
