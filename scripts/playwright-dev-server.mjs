import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const env = {
  ...process.env,
  AGENT_SESSION_BROWSER_CODEX_HOME: path.join(root, "tests", "fixtures", "codex-home"),
  AGENT_SESSION_BROWSER_CLAUDE_HOME: path.join(root, "tests", "fixtures", "claude-home"),
  AGENT_SESSION_BROWSER_GEMINI_HOME: path.join(root, "tests", "fixtures", "gemini-home"),
  AGENT_SESSION_BROWSER_PI_HOME: path.join(root, "tests", "fixtures", "pi-home"),
  AGENT_SESSION_BROWSER_DATA_DIR: path.join(root, "tests", ".tmp", "playwright-data"),
  AGENT_SESSION_BROWSER_PORT: process.env.AGENT_SESSION_BROWSER_PORT || "4174"
};

const command = process.execPath;
const args = [
  "--disable-warning=ExperimentalWarning",
  "--import",
  "tsx",
  "src/server/index.ts"
];

const child = spawn(command, args, {
  cwd: root,
  env,
  stdio: "inherit"
});

function shutdown() {
  child.kill("SIGTERM");
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
child.on("exit", (code) => process.exit(code ?? 0));
