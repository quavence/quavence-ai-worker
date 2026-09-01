# Quavence AI Worker Desktop

Official desktop worker application for the **Quavence (QVNC)** DePIN AI Compute Network.

Connect your local LLM (Ollama or LM Studio) to participate in decentralized compute tasks and earn native network rewards.

---

## Key Features

- **Decentralized AI Compute:** Executes consensus scoring, governance intelligence, and verification tasks locally.
- **Local LLM Support:** Seamlessly integrates with Ollama and OpenAI-compatible runtimes (LM Studio).
- **Secure Token Storage:** Node authentication tokens are stored securely in the OS Keychain (Windows Credential Manager / macOS Keychain).
- **Hardware Attestation:** Automated multi-factor hardware and model runtime attestation.
- **Background Daemon:** System tray controls, ambient background mode, and automated reconnects.

---

## Quick Start (Pre-built Binaries)

For most users, simply download the latest installer from [GitHub Releases](https://github.com/quavence/quavence-ai-worker/releases):

1. Download **`Quavence-AI-Worker-Setup-1.0.0.exe`**.
2. Run the installer and launch the application.
3. Paste your Worker Token obtained from the Quavence Dashboard.
4. Ensure your local Ollama or LM Studio is running, and click **Start Worker**.

---

## Building from Source

### Prerequisites

- **Node.js:** v18.0.0 or higher
- **Package Manager:** npm
- **Local LLM Runtime:** Ollama (default `http://localhost:11434`) or LM Studio (default `http://localhost:1234/v1`)

### Installation & Run

```bash
# Clone the repository
git clone https://github.com/quavence/quavence-ai-worker.git
cd quavence-ai-worker

# Install dependencies
npm install

# Run in development mode
npm run dev
```

### Build Installers

```bash
# Build production renderer UI
npm run build:renderer

# Build Windows NSIS Installer & Portable binary
npm run dist:win
```

Built artifacts will be generated in the `release/` directory:
- `Quavence-AI-Worker-Setup-<version>.exe`
- `Quavence-AI-Worker-Portable-<version>.exe`

---

## Security & Responsible Disclosure

Security is a priority for the Quavence ecosystem. Please report any potential vulnerabilities to **security@quavence.com**. See [SECURITY.md](SECURITY.md) for details on our response SLAs and disclosure policy.

---

## License

Licensed under the **Business Source License 1.1 (BSL-1.1)**. See [LICENSE](LICENSE) for terms.
