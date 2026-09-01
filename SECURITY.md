# Security Policy

## Supported Versions

Until the first stable release, security fixes are made on the latest `main` branch only.

## Reporting a Vulnerability

Please report vulnerabilities privately through the repository's [Security tab](https://github.com/gautamgpt1/agent-session-browser/security) using **Report a vulnerability**. Do not include session files, credentials, or other private trace data in a public issue.

Include the affected commit or version, operating system, reproduction steps using synthetic data, impact, and any suggested mitigation. A report should receive an initial response within seven days.

## Security Boundary

Agent Session Browser is designed as a single-user, local application:

- It reads local coding-agent history and writes a lightweight metadata-only SQLite catalog plus any exports requested by the user.
- It binds to `127.0.0.1` and rejects non-loopback Host headers and cross-origin browser requests.
- It has no authentication and must not be exposed through port forwarding, a reverse proxy, a shared host, or a public network interface.
- Its catalog can contain local paths and short session summaries; exports can contain the same sensitive material as source sessions.
- Resume actions launch an already-installed provider CLI with the selected session identifier.

Issues caused only by intentionally exposing the local server to untrusted users are outside the supported deployment model, but defense-in-depth improvements are still welcome.
