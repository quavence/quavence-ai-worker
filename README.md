# Quavence AI Worker Desktop

Desktop shell for the Quavence AI worker agent:
- configure worker token (stored in OS keychain)
- connect to LM Studio or Ollama via Hub runtime policy
- start/stop worker and view live activity
- tray, autostart, and lifecycle controls

## Lightweight Windows build

The packaged app is a **worker shell only**. It does **not** bundle:
- LM Studio
- Ollama
- model files (`.gguf`, caches)
- dev tools / smoke scripts
- local `.env`, tokens, or user config

Install LM Studio (or Ollama) and load Hub-approved models separately. Hub runtime policy remains the source of truth.

Default runtime endpoint for LM Studio: `http://localhost:1234/v1`  
Default Hub API: `https://quavence.com`

The packaged app window title remains **Quavence AI Worker Desktop**; NSIS wizard and shortcuts use the shorter **Quavence AI Worker** name to avoid header clipping on localized Windows installs.

User config is written to Electron `userData/worker-config.json` after first run. Tokens stay in the OS keychain.

## Run (developer)

```bash
cd worker_desktop
npm install
npm run dev
```

## Icons (Logo1 — Worker AI)

Tray/window icons use **Logo1** (not Logo5) so the worker is distinct from the Qt wallet.

```bash
cd ../quavence_app
python scripts/normalize_logo1.py
python scripts/generate_icon_pack.py --deploy worker-desktop
```

Or from `worker_desktop` after normalization:

```bash
npm run generate:tray
npm run preview:icons   # optional: assets/icon-preview.png
```

Source: `quavence_app/public/images/Logo1-centered-1024.png`

Outputs: `assets/app.ico`, `assets/tray.ico`, `assets/app-icon.png`

## Build Windows artifacts

```bash
cd worker_desktop
npm install
npm run build:renderer
npm run generate:tray
npm run dist:win
```

Verify unpacked layout:

```bash
npm run pack:dir
npm run verify:dist
```

Artifacts (`worker_desktop/release/`):
- `Quavence-AI-Worker-Setup-<version>.exe` (NSIS installer)
- `Quavence-AI-Worker-Portable-<version>.exe` (portable)
- `win-unpacked/` (directory build for verification)

## Included in the artifact

- Electron main/preload/lifecycle modules
- Renderer UI (`dist-renderer/`)
- Worker agent (`agent/`)
- Icons (`assets/app.ico`, `assets/tray.ico`, `assets/app-icon.png`)
- Production dependency: `keytar`

## Excluded from the artifact

- `tools/`, smoke scripts, dev scripts
- Source maps
- React sources (bundled into renderer build)
- Bundled Ollama/runtime payloads
- Repo-level `quavence-dao` files

## Notes

- App ID: `com.quavence.ai-worker`
- Worker token is securely stored and isolated in your OS keychain.
- `npm run verify:dist` checks forbidden paths and required packaged files after `pack:dir`.
