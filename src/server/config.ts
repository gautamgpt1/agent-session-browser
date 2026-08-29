import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { AgentProvider, SessionRoot } from "../shared/types.js";

export interface AppConfig {
  agentHomes: Record<AgentProvider, string>;
  roots: SessionRoot[];
  geminiProjectPaths: Map<string, string>;
  dbPath: string;
  bindHost: string;
  port: number;
  version: string;
  isDev: boolean;
  watchSources: boolean;
}

export function resolveCodexHome(): string {
  const configured = process.env.AGENT_SESSION_BROWSER_CODEX_HOME || process.env.CODEX_HOME;
  if (configured) {
    return path.resolve(configured);
  }
  return path.join(os.homedir(), ".codex");
}

export function resolveClaudeHome(): string {
  return path.resolve(process.env.AGENT_SESSION_BROWSER_CLAUDE_HOME || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"));
}

export function resolveGeminiHome(): string {
  return path.resolve(process.env.AGENT_SESSION_BROWSER_GEMINI_HOME || path.join(os.homedir(), ".gemini"));
}

export function resolvePiHome(): string {
  return path.resolve(process.env.AGENT_SESSION_BROWSER_PI_HOME || path.join(os.homedir(), ".pi"));
}

export function resolveAppConfig(): AppConfig {
  const codexHome = resolveCodexHome();
  const claudeHome = resolveClaudeHome();
  const geminiHome = resolveGeminiHome();
  const piHome = resolvePiHome();
  const roots: SessionRoot[] = [
    {
      provider: "codex",
      kind: "active",
      path: path.join(codexHome, "sessions"),
      exists: fs.existsSync(path.join(codexHome, "sessions"))
    },
    {
      provider: "codex",
      kind: "archived",
      path: path.join(codexHome, "archived_sessions"),
      exists: fs.existsSync(path.join(codexHome, "archived_sessions"))
    },
    {
      provider: "claude",
      kind: "active",
      path: path.join(claudeHome, "projects"),
      exists: fs.existsSync(path.join(claudeHome, "projects"))
    },
    {
      provider: "gemini",
      kind: "active",
      path: path.join(geminiHome, "tmp"),
      exists: fs.existsSync(path.join(geminiHome, "tmp"))
    },
    {
      provider: "pi",
      kind: "active",
      path: path.join(piHome, "agent", "sessions"),
      exists: fs.existsSync(path.join(piHome, "agent", "sessions"))
    }
  ];

  const appDataRoot = path.resolve(
    process.env.AGENT_SESSION_BROWSER_DATA_DIR ||
    defaultDataRoot()
  );

  return {
    agentHomes: { codex: codexHome, claude: claudeHome, gemini: geminiHome, pi: piHome },
    roots,
    geminiProjectPaths: loadGeminiProjectPaths(geminiHome),
    dbPath: path.join(appDataRoot, "index.sqlite"),
    bindHost: "127.0.0.1",
    port: parsePort(process.env.PORT || process.env.AGENT_SESSION_BROWSER_PORT),
    version: "0.1.0",
    isDev: process.env.NODE_ENV !== "production",
    watchSources: process.env.AGENT_SESSION_BROWSER_DISABLE_WATCHER !== "1"
  };
}

export function defaultDataRoot(platform = process.platform, home = os.homedir(), env = process.env): string {
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  if (platform === "win32") {
    return platformPath.join(env.LOCALAPPDATA || env.APPDATA || platformPath.join(home, "AppData", "Local"), "Agent Session Browser");
  }
  if (platform === "darwin") return platformPath.join(home, "Library", "Application Support", "Agent Session Browser");
  return platformPath.join(env.XDG_DATA_HOME || platformPath.join(home, ".local", "share"), "agent-session-browser");
}

function parsePort(value: string | undefined): number {
  if (!value) return 4173;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid Agent Session Browser port: ${value}`);
  }
  return port;
}

function loadGeminiProjectPaths(geminiHome: string): Map<string, string> {
  const result = new Map<string, string>();
  const registryPath = path.join(geminiHome, "projects.json");
  try {
    const registry = JSON.parse(fs.readFileSync(registryPath, "utf8")) as { projects?: Record<string, string> };
    for (const [projectPath, slug] of Object.entries(registry.projects || {})) {
      result.set(slug, projectPath);
    }
  } catch {
    // Gemini creates the registry after its first project session.
  }

  const tempRoot = path.join(geminiHome, "tmp");
  if (fs.existsSync(tempRoot)) {
    for (const entry of fs.readdirSync(tempRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const projectPath = fs.readFileSync(path.join(tempRoot, entry.name, ".project_root"), "utf8").trim();
        if (projectPath) result.set(entry.name, projectPath);
      } catch {
        // Legacy hashed directories may not have an ownership marker.
      }
    }
  }
  return result;
}
