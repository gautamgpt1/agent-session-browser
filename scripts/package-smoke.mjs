import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-session-browser-package-"));
const npmEntrypoint = process.env.npm_execpath;
if (!npmEntrypoint) throw new Error("Package smoke test must be started through npm");
let webProcess = null;

try {
  const pack = runNpm(["pack", "--silent", "--json", "--pack-destination", temporaryRoot], root);
  const metadata = parsePackMetadata(pack.stdout)[0];
  const paths = new Set(metadata.files.map((file) => file.path));
  for (const required of [
    "bin/asb.js",
    "dist/client/index.html",
    "dist/server/server/index.js",
    "dist/server/tui/index.js",
    "LICENSE",
    "README.md",
    "SECURITY.md"
  ]) {
    if (!paths.has(required)) throw new Error(`Packaged file is missing: ${required}`);
  }
  for (const forbidden of ["src/", "tests/", ".github/", "scripts/", "playwright.config"] ) {
    if ([...paths].some((entry) => entry.startsWith(forbidden))) throw new Error(`Unexpected packaged path: ${forbidden}`);
  }
  if ([...paths].some((entry) => entry.includes("large-record"))) throw new Error("Stale compiled large-record module was packaged");

  const tarball = path.join(temporaryRoot, metadata.filename);
  const installRoot = path.join(temporaryRoot, "installed");
  const runDirectory = path.join(temporaryRoot, "unrelated-working-directory");
  fs.mkdirSync(installRoot, { recursive: true });
  fs.mkdirSync(runDirectory, { recursive: true });
  fs.writeFileSync(path.join(installRoot, "package.json"), '{"name":"package-smoke","private":true}');
  runNpm(["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], installRoot);

  const installedPackage = path.join(installRoot, "node_modules", "agent-session-browser");
  const entrypoint = path.join(installedPackage, "bin", "asb.js");
  const shim = path.join(installRoot, "node_modules", ".bin", process.platform === "win32" ? "asb.cmd" : "asb");
  const longShim = path.join(installRoot, "node_modules", ".bin", process.platform === "win32" ? "agent-session-browser.cmd" : "agent-session-browser");
  if (!fs.existsSync(shim)) throw new Error("npm did not create the asb executable shim");
  if (!fs.existsSync(longShim)) throw new Error("npm did not create the agent-session-browser executable shim");
  const shimHelp = runNpm(["exec", "--offline", "--", "asb", "--help"], installRoot);
  if (!shimHelp.stdout.includes("terminal interface (default)")) throw new Error("The installed asb shim did not run");
  const help = run(process.execPath, [entrypoint, "--help"], runDirectory);
  if (!help.stdout.includes("terminal interface (default)")) throw new Error("Packaged asb help did not identify the default TUI");
  const installedManifest = JSON.parse(fs.readFileSync(path.join(installedPackage, "package.json"), "utf8"));
  const version = run(process.execPath, [entrypoint, "--version"], runDirectory);
  if (version.stdout.trim() !== installedManifest.version) throw new Error("Packaged asb version did not match package.json");
  expectFailure(entrypoint, ["unknown-command"], runDirectory, process.env, "Unknown command");
  expectFailure(entrypoint, ["web", "--port", "not-a-port"], runDirectory, process.env, "requires a number from 1 to 65535");
  const tuiHelp = run(process.execPath, [entrypoint, "tui", "--help"], runDirectory);
  if (!tuiHelp.stdout.includes("Agent Session Browser TUI")) throw new Error("Packaged TUI did not start");

  const dataDirectory = path.join(temporaryRoot, "data");
  const fixtureEnvironment = {
    ...process.env,
    AGENT_SESSION_BROWSER_CODEX_HOME: path.join(root, "tests", "fixtures", "codex-home"),
    AGENT_SESSION_BROWSER_CLAUDE_HOME: path.join(root, "tests", "fixtures", "claude-home"),
    AGENT_SESSION_BROWSER_GEMINI_HOME: path.join(root, "tests", "fixtures", "gemini-home"),
    AGENT_SESSION_BROWSER_PI_HOME: path.join(root, "tests", "fixtures", "pi-home"),
    AGENT_SESSION_BROWSER_DATA_DIR: dataDirectory,
    AGENT_SESSION_BROWSER_DISABLE_WATCHER: "1"
  };
  const defaultTui = run(process.execPath, [entrypoint], runDirectory, fixtureEnvironment);
  if (defaultTui.stdout.split(/\r?\n/).filter((line) => line.includes("\t")).length !== 5) {
    throw new Error("The bare packaged command did not default to the five-session TUI fixture listing");
  }
  const port = await availablePort();
  webProcess = spawn(process.execPath, [entrypoint, "web", "--port", String(port), "--no-open"], {
    cwd: runDirectory,
    env: fixtureEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  const stderr = [];
  webProcess.stderr.setEncoding("utf8");
  webProcess.stderr.on("data", (chunk) => stderr.push(chunk));
  await waitForWeb(webProcess, port, stderr);
  const rootResponse = await fetch(`http://127.0.0.1:${port}/`);
  const html = await rootResponse.text();
  if (!rootResponse.ok || !html.includes('id="root"')) throw new Error("Packaged web client was not served");
  const status = await waitForIndex(port);
  if (status.sessions !== 5) throw new Error(`Packaged server found ${status.sessions} fixture sessions instead of 5`);

  await stopWebProcess();
  const occupiedServer = net.createServer();
  const occupiedPort = await listenOnAvailablePort(occupiedServer);
  try {
    expectFailure(
      entrypoint,
      ["web", "--port", String(occupiedPort), "--no-open"],
      runDirectory,
      fixtureEnvironment,
      "already in use"
    );
  } finally {
    await new Promise((resolve, reject) => occupiedServer.close((error) => error ? reject(error) : resolve()));
  }
  process.stdout.write(`Package smoke test passed (${metadata.entryCount} files, ${metadata.size} byte tarball)\n`);
} finally {
  await stopWebProcess();
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed\n${result.stderr || result.stdout}`);
  return result;
}

function runNpm(args, cwd) {
  return run(process.execPath, [npmEntrypoint, ...args], cwd);
}

function expectFailure(entrypoint, args, cwd, env, expectedMessage) {
  const result = spawnSync(process.execPath, [entrypoint, ...args], {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000
  });
  if (result.error) throw result.error;
  if (result.status === 0) throw new Error(`asb ${args.join(" ")} unexpectedly succeeded`);
  if (!`${result.stderr}${result.stdout}`.includes(expectedMessage)) {
    throw new Error(`asb ${args.join(" ")} did not report ${expectedMessage}\n${result.stderr || result.stdout}`);
  }
}

function parsePackMetadata(output) {
  const match = output.match(/\[\s*\{\s*"id"[\s\S]*\}\s*\]\s*$/);
  if (!match) throw new Error(`Could not parse npm pack output:\n${output}`);
  return JSON.parse(match[0]);
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function listenOnAvailablePort(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || !address) return reject(new Error("Could not reserve a package smoke-test port"));
      resolve(address.port);
    });
  });
}

function waitForWeb(child, port, stderr) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Packaged web server did not start${stderr.length ? `:\n${stderr.join("")}` : ""}`)), 15_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Packaged web command exited with ${code}${stderr.length ? `:\n${stderr.join("")}` : ""}`));
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (!chunk.includes(`127.0.0.1:${port}`)) return;
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitForIndex(port) {
  const deadline = Date.now() + 15_000;
  let status = null;
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${port}/api/index/status`);
    status = await response.json();
    if (!status.running && status.sessions === 5) return status;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Packaged index did not settle: ${JSON.stringify(status)}`);
}

async function stopWebProcess() {
  if (!webProcess || webProcess.exitCode != null) return;
  const child = webProcess;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 4_000))
  ]);
  webProcess = null;
}
