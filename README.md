# Agent Session Browser

Agent Session Browser turns the local history written by Codex CLI, Claude Code, Gemini CLI, and Pi into searchable, readable conversations without modifying the source files.

## Why Agent Session Browser

Important decisions and final answers often disappear inside long terminal transcripts. Keeping a separate notebook of useful agent outputs duplicates information that already exists on disk, while opening raw JSONL makes the conversation difficult to follow. Agent Session Browser provides one local interface to:

- Browse sessions by working directory and recency.
- Search message, reasoning, tool, and metadata content directly in the original session files.
- Read clean user/final-answer conversations or inspect the full provider trace.
- Filter individual message, reasoning, lifecycle, error, and tool categories.
- Inspect the lossless raw source record and provider metadata for any item.
- Copy provider-native resume commands.
- Export a session as portable Markdown or self-contained offline HTML.
- Browse, search, export, and resume from a keyboard-first TUI.

Everything runs on the local machine. Agent Session Browser does not upload session data, call an AI API, or write to agent history files.

## Supported Sources

| Agent | Default history location | Resume command |
| --- | --- | --- |
| Codex CLI | `~/.codex/sessions` and `~/.codex/archived_sessions` | `codex resume <id>` |
| Claude Code | `~/.claude/projects` | `claude --resume <id>` |
| Gemini CLI | `~/.gemini/tmp/<project>/chats` | `gemini --resume <id>` |
| Pi | `~/.pi/agent/sessions` | `pi --session <id>` |

Claude subagent transcripts remain distinct from their parent sessions. Gemini project paths are recovered from `projects.json` and `.project_root` markers. Pi v3 branches, compactions, summaries, model changes, usage, and tool results are retained.

Provider formats are external, versioned contracts. Unknown records are preserved and remain available under additional provider events and raw JSON instead of being silently discarded.

## Requirements

- Node.js 22.13 or newer.
- npm 10 or newer.
- At least one supported agent history folder for real data.
- A modern Chromium, Firefox, or Safari browser for the web UI.

The matching agent CLI is only required when resuming a session. Reading and exporting history does not require provider authentication.

## Quick Start

> The npm package will be published with the first release. Until then, use the source instructions below.

After the package is published, open the terminal interface without cloning the repository:

```sh
npx agent-session-browser
```

Agent Session Browser works from any directory and discovers histories from their standard user-level locations. Install it globally to keep the short command available:

```sh
npm install --global agent-session-browser
asb
```

The bare command opens the TUI. Start the browser interface explicitly:

```sh
asb web
```

`asb web` starts the local server and opens it in the default browser. Use `asb web --no-open` to print the URL without opening it, or `asb web --port 4180` to choose another port.

## Run From Source

Clone the repository and install its locked dependencies:

```sh
git clone https://github.com/gautamgpt1/agent-session-browser.git
cd agent-session-browser
npm ci
npm run dev
```

Open `http://127.0.0.1:4173`. The server builds a lightweight session catalog on startup and watches available source folders for changes. Transcript content is read from the original files only when it is opened, searched, or exported.

For a production build:

```sh
npm run build
npm start
```

`npm start` serves the compiled application on the same loopback address. Agent Session Browser intentionally has no option to bind to a network interface.

## Terminal UI

When running from source, start the interactive TUI with:

```sh
npm run tui
```

| Key | Action |
| --- | --- |
| `Left` / `Right` | Focus the session list or transcript |
| `Up` / `Down` | Move through sessions or scroll the focused transcript by one wrapped line |
| `Page Up` / `Page Down` | Move ten sessions or one transcript viewport |
| Type / `Backspace` | Search |
| `Ctrl+S` | Switch session filtering and transcript preview search |
| `Tab` | Cycle agents |
| `F2` | Cycle conversation, readable, and trace views |
| `Ctrl+O` | Expand the selected shortened record from its original source |
| `Ctrl+E` | Export offline HTML |
| `Ctrl+R` | Show the resume command |
| `Enter` | Resume with the provider CLI |
| `Esc` | Exit |

Installed command examples:

```sh
asb --query "authentication failure"
asb --provider claude --query "migration"
asb --session <id-or-jsonl-path> --print-resume
asb --session <id-or-jsonl-path> --export html --mode conversation
asb tui --help
```

When stdout is redirected, the TUI command prints tab-separated session results instead of terminal control sequences.

## Configuration

Agent Session Browser auto-detects standard user-level history locations. Override any location with environment variables when histories live on another drive, in WSL, or on a mounted remote home.

| Variable | Purpose |
| --- | --- |
| `AGENT_SESSION_BROWSER_CODEX_HOME` | Codex home containing `sessions` and `archived_sessions` |
| `AGENT_SESSION_BROWSER_CLAUDE_HOME` | Claude home containing `projects` |
| `AGENT_SESSION_BROWSER_GEMINI_HOME` | Gemini home containing `tmp` |
| `AGENT_SESSION_BROWSER_PI_HOME` | Pi home containing `agent/sessions` |
| `AGENT_SESSION_BROWSER_DATA_DIR` | Lightweight SQLite catalog and exported TUI files |
| `AGENT_SESSION_BROWSER_PORT` | Local HTTP port; defaults to `4173` |

Official `CODEX_HOME` and `CLAUDE_CONFIG_DIR` settings are respected.

Examples:

```sh
# Linux, macOS, or WSL
AGENT_SESSION_BROWSER_CODEX_HOME=/mnt/c/Users/alice/.codex npm run dev
```

```powershell
# Windows PowerShell
$env:AGENT_SESSION_BROWSER_CLAUDE_HOME = 'D:\agent-data\claude'
npm run dev
```

The default index location follows each platform:

| Platform | Data directory |
| --- | --- |
| Windows | `%LOCALAPPDATA%\Agent Session Browser` |
| macOS | `~/Library/Application Support/Agent Session Browser` |
| Linux / WSL | `${XDG_DATA_HOME:-~/.local/share}/agent-session-browser` |

For SSH-hosted histories, mount or sync the remote agent home locally and point the matching environment variable at it. Agent Session Browser does not open SSH connections or copy source data itself.

## Search and Views

The sidebar search streams through the original session files without storing a second transcript copy. Searches over very large histories can take a few seconds; a visible status remains until the scan finishes. Pressing Enter also tries an exact internal ID, provider-native ID, or cataloged JSONL path, which makes deeply nested sessions directly addressable.

Session filters narrow candidates by agent, working directory, date, archive state, and parse errors. Large catalogs load in explicit pages, so the sidebar and TUI never silently discard sessions. Transcript filters only change what is visible inside the selected session; selecting tool checkboxes does not hide unrelated session cards.

The default transcript shows user messages and source-confirmed final answers. Progress messages, reasoning, plans, tool calls, tool output, lifecycle events, token updates, warnings, and unknown provider records are individually selectable.

## Exports

- **Offline HTML** is styled, self-contained, dark-mode aware, printable, and escapes all stored content.
- **Markdown** is portable plain text suitable for source control, notes, and audits.
- **Conversation** contains user messages and provider-confirmed final replies.
- **Readable** adds progress, reasoning, and tool activity.
- **Trace** also includes raw source records and is available from the TUI/API internals.

To keep unusually large sessions responsive without hiding history, Codex, Claude Code, Gemini CLI, and Pi files are normalized into a compact one-session semantic cache and one filtered transcript page is mounted in the browser at a time. First, previous, next, last, and direct page controls keep every matching item reachable without allowing the DOM to grow indefinitely. Parsing has no record-count or record-size sampling path: valid oversized records are fully decoded, including every nested message in legacy monolithic Gemini sessions. Long bodies use an explicit presentation preview that can be expanded inline from the unchanged source file.

Conversation, readable, and raw trace exports stream incrementally through a temporary file instead of constructing the complete transcript in memory. Browser download files are removed after delivery. TUI exports use mode-specific names and add a numeric suffix rather than overwriting an existing export.

Exports can contain prompts, source code, command output, local paths, environment details, and secrets captured by an agent. Review them before sharing.

## Privacy and Security

Agent Session Browser is read-only with respect to provider history. Its SQLite catalog stores paths and small session summaries, not transcript records or tool output. Opening a session parses its source file into temporary process memory; exports intentionally contain the selected content.

- The web server binds only to `127.0.0.1`.
- Requests with non-loopback Host headers or cross-origin browser origins are rejected.
- API responses are not cached and browser security headers are enabled.
- Resume execution uses direct executable arguments, not a command shell.
- No telemetry or external network request is implemented.

Anyone who can read your OS user account can usually read the original agent files and any exports you create. Use normal full-disk encryption and account permissions for sensitive work. See [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## Development

```sh
npm ci
npm run build
npm test
npm run test:package
npx playwright install chromium
npm run test:e2e
```

Run the complete suite with `npm run check` after the Playwright browser is installed. Tests cover all four providers, active and archived sessions, malformed and truncated data, lossless oversized records, streamed complete exports, incremental refresh, deletion pruning, indexed raw lookup, complete catalog and transcript paging, responsive layout, keyboard-accessible dialogs, XSS-safe export, HTTP boundary checks, clipboard feedback, filtering, themes, and resume commands.

Run `npm run clean` to remove build output, coverage, Playwright output, and temporary test databases.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution workflow and parser expectations.

## Upstream References

- [Claude Code session storage and resume](https://code.claude.com/docs/en/sessions)
- [Gemini CLI session management](https://geminicli.com/docs/cli/session-management/)
- [Pi session file format](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/session.md)

Provider fixtures are synthetic and contain no real user conversations.

## License

[MIT](LICENSE)
