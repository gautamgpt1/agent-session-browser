import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-session-browser-production-"));
const port = await availablePort();
const child = spawn(process.execPath, [path.join(root, "scripts", "start-production.mjs")], {
  cwd: root,
  env: {
    ...process.env,
    AGENT_SESSION_BROWSER_CODEX_HOME: path.join(root, "tests", "fixtures", "codex-home"),
    AGENT_SESSION_BROWSER_CLAUDE_HOME: path.join(root, "tests", "fixtures", "claude-home"),
    AGENT_SESSION_BROWSER_GEMINI_HOME: path.join(root, "tests", "fixtures", "gemini-home"),
    AGENT_SESSION_BROWSER_PI_HOME: path.join(root, "tests", "fixtures", "pi-home"),
    AGENT_SESSION_BROWSER_DATA_DIR: dataDir,
    AGENT_SESSION_BROWSER_PORT: String(port),
    AGENT_SESSION_BROWSER_DISABLE_WATCHER: "1"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr += chunk; });

try {
  await waitForServer(child, port);
  const rootResponse = await fetch(`http://127.0.0.1:${port}/`);
  const { response: statusResponse, status } = await waitForIndex(port);
  const html = await rootResponse.text();
  if (!rootResponse.ok || !html.includes('id="root"')) throw new Error("Compiled client was not served");
  if (!statusResponse.ok || status.sessions !== 5) throw new Error(`Expected 5 indexed fixture sessions, received ${status.sessions}`);
  if (!rootResponse.headers.get("content-security-policy")) throw new Error("Security headers were not applied");
  process.stdout.write(`Production smoke test passed on http://127.0.0.1:${port}\n`);
} finally {
  child.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(3_000)]);
  fs.rmSync(dataDir, { recursive: true, force: true });
}

if (stderr) process.stderr.write(stderr);

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const selected = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(selected));
    });
  });
}

function waitForServer(processHandle, selectedPort) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Production server did not start in time${stderr ? `: ${stderr}` : ""}`)), 10_000);
    processHandle.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Production server exited with code ${code}${stderr ? `: ${stderr}` : ""}`));
    });
    processHandle.stdout.setEncoding("utf8");
    processHandle.stdout.on("data", (chunk) => {
      if (!chunk.includes(`127.0.0.1:${selectedPort}`)) return;
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitForIndex(selectedPort) {
  const deadline = Date.now() + 10_000;
  let response;
  let status;
  while (Date.now() < deadline) {
    response = await fetch(`http://127.0.0.1:${selectedPort}/api/index/status`);
    status = await response.json();
    if (!status.running && status.sessions === 5) return { response, status };
    await delay(50);
  }
  throw new Error(`Index did not settle at 5 sessions; last status: ${JSON.stringify(status)}`);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
