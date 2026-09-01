import fs from "node:fs";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { AppConfig } from "./config.js";
import { catalogSessionFile } from "./catalog.js";
import { PARSER_VERSION, ViewerDatabase } from "./database.js";
import type { ArchiveState, IndexStatus, SessionRoot } from "../shared/types.js";

export class SessionIndexer {
  private watcher: FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private status: IndexStatus = {
    running: false,
    lastRunAt: null,
    filesSeen: 0,
    filesIndexed: 0,
    filesSkipped: 0,
    sessions: 0,
    parseErrors: 0,
    error: null
  };

  constructor(
    private readonly config: AppConfig,
    private readonly database: ViewerDatabase
  ) {}

  getStatus(): IndexStatus {
    return { ...this.status, sessions: this.database.countSessions() };
  }

  async refreshAll(): Promise<IndexStatus> {
    if (this.status.running) {
      return this.getStatus();
    }
    this.status = {
      ...this.status,
      running: true,
      filesSeen: 0,
      filesIndexed: 0,
      filesSkipped: 0,
      parseErrors: 0,
      error: null
    };
    const validPaths = new Set<string>();
    const managedRoots = this.config.roots.filter((root) => fs.existsSync(root.path)).map((root) => root.path);
    try {
      for (const root of this.config.roots) {
        if (!fs.existsSync(root.path)) continue;
        const files = await collectSessionFiles(root);
        for (const file of files) {
          validPaths.add(file);
          this.status.filesSeen += 1;
          const stat = await fs.promises.stat(file);
          const known = this.database.getKnownFile(file);
          if (
            known &&
            known.bytes === stat.size &&
            Math.abs(known.sourceMtimeMs - stat.mtimeMs) < 1 &&
            known.parserVersion >= PARSER_VERSION
          ) {
            this.status.filesSkipped += 1;
            continue;
          }
          try {
            const parsed = await this.parseFile(root, file);
            this.database.upsertParsedSession(parsed);
            this.status.filesIndexed += 1;
            if (parsed.parseStatus !== "ok") this.status.parseErrors += 1;
          } catch (error) {
            this.status.parseErrors += 1;
            this.status.error = `Failed to parse ${file}: ${(error as Error).message}`;
          }
        }
      }
      this.database.pruneMissingSources(validPaths, managedRoots);
      this.status.lastRunAt = new Date().toISOString();
    } catch (error) {
      this.status.error = (error as Error).message;
    } finally {
      this.status.running = false;
      this.status.sessions = this.database.countSessions();
    }
    return this.getStatus();
  }

  startWatcher(): void {
    const roots = this.config.roots.filter((root) => fs.existsSync(root.path)).map((root) => root.path);
    if (roots.length === 0 || this.watcher) return;
    this.watcher = chokidar.watch(roots, {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 700,
        pollInterval: 100
      }
    });
    const schedule = () => this.scheduleRefresh();
    this.watcher.on("add", schedule);
    this.watcher.on("change", schedule);
    this.watcher.on("unlink", schedule);
  }

  async stopWatcher(): Promise<void> {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  private scheduleRefresh(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      void this.refreshAll();
    }, 1_000);
  }

  private parseFile(root: SessionRoot, file: string) {
    let cwd: string | null = null;
    if (root.provider === "gemini") {
      const relative = path.relative(root.path, file);
      const projectSlug = relative.split(path.sep)[0];
      cwd = this.config.geminiProjectPaths.get(projectSlug) || null;
    }
    return catalogSessionFile(root.provider, file, root.kind, cwd);
  }
}

async function collectSessionFiles(root: SessionRoot): Promise<string[]> {
  const results: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && isSupportedSessionFile(root, fullPath)) {
        results.push(fullPath);
      }
    }
  }
  await walk(root.path);
  return results;
}

function isSupportedSessionFile(root: SessionRoot, filePath: string): boolean {
  const fileName = path.basename(filePath).toLowerCase();
  if (root.provider === "gemini") {
    return path.basename(path.dirname(filePath)).toLowerCase() === "chats" && fileName.startsWith("session-") && /\.jsonl?$/.test(fileName);
  }
  return fileName.endsWith(".jsonl");
}

export function archiveStateForPath(config: AppConfig, filePath: string): ArchiveState {
  const archivedRoot = config.roots.find((root) => root.kind === "archived")?.path;
  return archivedRoot && filePath.toLowerCase().startsWith(archivedRoot.toLowerCase()) ? "archived" : "active";
}

export { SessionIndexer as CodexIndexer };
