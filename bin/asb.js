#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packageMetadata = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
const args = process.argv.slice(2);
const command = args[0];

if (command === "--help" || command === "-h" || command === "help") {
  process.stdout.write(help());
} else if (command === "--version" || command === "-v" || command === "version") {
  process.stdout.write(`${packageMetadata.version}\n`);
} else if (command === "web") {
  await runWeb(args.slice(1));
} else if (command === "tui") {
  await runTui(args.slice(1));
} else if (!command || command.startsWith("-")) {
  await runTui(args);
} else {
  fail(`Unknown command: ${command}`);
}

async function runTui(tuiArgs) {
  const entrypoint = path.join(packageRoot, "dist", "server", "tui", "index.js");
  await runNode(entrypoint, tuiArgs, process.env);
}

async function runWeb(webArgs) {
  let port = "";
  let open = true;
  for (let index = 0; index < webArgs.length; index += 1) {
    const value = webArgs[index];
    if (value === "--help" || value === "-h") {
      process.stdout.write(webHelp());
      return;
    }
    if (value === "--no-open") {
      open = false;
      continue;
    }
    if (value === "--port") {
      port = webArgs[++index] || "";
      if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65_535) {
        fail("--port requires a number from 1 to 65535");
        return;
      }
      continue;
    }
    fail(`Unknown web option: ${value}`);
    return;
  }

  const entrypoint = path.join(packageRoot, "dist", "server", "server", "index.js");
  const env = { ...process.env, NODE_ENV: "production" };
  if (port) env.AGENT_SESSION_BROWSER_PORT = port;
  await runNode(entrypoint, [], env, open);
}

function runNode(entrypoint, childArgs, env, openWhenReady = false) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", entrypoint, ...childArgs], {
      env,
      stdio: openWhenReady ? ["inherit", "pipe", "inherit"] : "inherit",
      windowsHide: true
    });
    let opened = false;
    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        process.stdout.write(chunk);
        if (opened) return;
        const url = String(chunk).match(/https?:\/\/127\.0\.0\.1:\d+/)?.[0];
        if (!url) return;
        opened = true;
        openBrowser(url);
      });
    }

    let forwardingSignal = false;
    const forward = (signal) => {
      if (forwardingSignal) return;
      forwardingSignal = true;
      child.kill(signal);
    };
    const onSigint = () => forward("SIGINT");
    const onSigterm = () => forward("SIGTERM");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    child.once("error", (error) => {
      cleanup();
      process.stderr.write(`Unable to start Agent Session Browser: ${error.message}\n`);
      process.exitCode = 1;
      resolve();
    });
    child.once("exit", (code, signal) => {
      cleanup();
      process.exitCode = code ?? (signal ? 1 : 0);
      resolve();
    });

    function cleanup() {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    }
  });
}

function openBrowser(url) {
  const options = { detached: true, stdio: "ignore", windowsHide: true };
  const child = process.platform === "win32"
    ? spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], options)
    : process.platform === "darwin"
      ? spawn("open", [url], options)
      : spawn("xdg-open", [url], options);
  child.once("error", () => process.stderr.write(`Could not open a browser automatically. Open ${url}\n`));
  child.unref();
}

function fail(message) {
  process.stderr.write(`${message}\n\n${help()}`);
  process.exitCode = 1;
}

function help() {
  return `Agent Session Browser ${packageMetadata.version}

Usage:
  asb [tui options]          Open the terminal interface (default)
  asb tui [options]          Open the terminal interface explicitly
  asb web [options]          Start and open the browser interface

Commands:
  tui                        Browse, export, and resume in the terminal
  web                        Start the local web interface

Global options:
  -h, --help                 Show this help
  -v, --version              Show the installed version

Run "asb tui --help" or "asb web --help" for interface-specific options.
`;
}

function webHelp() {
  return `Agent Session Browser web interface

Usage:
  asb web [--port number] [--no-open]

Options:
  --port <number>            Local HTTP port (default: 4173)
  --no-open                  Print the URL without opening a browser
  -h, --help                 Show this help
`;
}
