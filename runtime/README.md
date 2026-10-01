Bundled runtime payload directory.

Expected layout for Windows:

- `runtime/manifest.json`
- `runtime/ollama/ollama.exe`

`manifest.json` controls install source and checksum verification.

Source kinds:

- `bundled_file`: copy from this folder into `%APPDATA%/.../runtime`.
- `external_url`: download from URL and verify `sha256`.

Runtime source can be overridden by env vars at install/runtime:

- `OLLAMA_BUNDLED_URL`
- `OLLAMA_BUNDLED_SHA256`

If `sha256` is empty, checksum verification is skipped.
