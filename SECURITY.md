# Security Policy

## Reporting a Vulnerability

Please do **NOT** create public GitHub issues for security vulnerabilities.

Report security issues privately to: **security@quavence.com**

Include in your report:
- Description of the vulnerability
- Steps to reproduce
- Potential impact assessment
- Suggested mitigation if available

## Response SLA

| Severity | Initial Response | Remediation SLA |
|---|---|---|
| **Critical** | Within 24 hours | 7 days |
| **High** | Within 48 hours | 14 days |
| **Medium** | Within 7 days | 30 days |
| **Low** | Within 14 days | Next release |

## Scope

### In Scope
- `worker_desktop/` Electron application & IPC bridge
- Runtime validation and model probe integrity
- QVNC Hub API endpoints and worker consensus
- On-chain Proof-of-Useful-Stake attestation verification

### Out of Scope
- Attacks requiring physical root access to an unlocked host OS
- Third-party dependency issues (report directly to upstream maintainers)

## Supported Versions

| Version | Supported |
|---|---|
| `1.x` (Latest) | ✅ Supported |
| `< 1.0.0` | ❌ Not supported |
