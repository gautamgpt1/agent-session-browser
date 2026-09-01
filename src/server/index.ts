import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import express from "express";
import { resolveAppConfig } from "./config.js";
import { ViewerDatabase } from "./database.js";
import { SessionIndexer } from "./indexer.js";
import { exportFileName } from "./session-actions.js";
import { localOnlySecurity } from "./security.js";
import { SessionSourceReader } from "./source-reader.js";
import type { ExportMode } from "../shared/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main(): Promise<void> {
  const config = resolveAppConfig();
  const database = new ViewerDatabase(config.dbPath);
  const indexer = new SessionIndexer(config, database);
  const sourceReader = new SessionSourceReader(database);
  const app = express();

  app.disable("x-powered-by");
  app.use(localOnlySecurity(config.port, config.isDev));
  app.use(express.json({ limit: "2mb" }));

  app.get("/api/index/status", (_req, res) => {
    res.json(indexer.getStatus());
  });

  app.post("/api/index/refresh", async (_req, res) => {
    res.json(await indexer.refreshAll());
  });

  app.get("/api/facets", (_req, res) => {
    res.json(database.getFacets());
  });

  app.get("/api/resolve", (req, res) => {
    res.json(database.resolveSession(String(req.query.value || "")));
  });

  app.get("/api/sessions", async (req, res) => {
    const abort = new AbortController();
    req.on("aborted", () => abort.abort());
    try {
      res.json(await database.listSessions(req.query as Record<string, string>, indexer.getStatus(), abort.signal));
    } catch (error) {
      if ((error as Error).name === "AbortError") return;
      res.status(400).json({ error: (error as Error).message });
    }
  });

  app.get("/api/sessions/:id", async (req, res) => {
    const detail = await sourceReader.getPage(req.params.id, {
      offset: Number(req.query.offset || 0),
      limit: Number(req.query.limit || 100),
      tools: req.query.tool == null ? undefined : parseList(req.query.tool),
      categories: req.query.category == null ? undefined : parseList(req.query.category),
      knownCategories: parseList(req.query.knownCategory),
      includeTools: req.query.includeTools !== "false"
    });
    if (!detail) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json(detail);
  });

  app.get("/api/sessions/:id/export", async (req, res) => {
    const format = req.query.format === "html" ? "html" : "markdown";
    const requestedMode = String(req.query.mode || "conversation");
    const mode: ExportMode = requestedMode === "trace" || requestedMode === "readable" ? requestedMode : "conversation";
    const exportDirectory = path.join(path.dirname(config.dbPath), "exports");
    await fs.promises.mkdir(exportDirectory, { recursive: true });
    const temporaryPath = path.join(exportDirectory, `.download-${randomUUID()}.${format === "html" ? "html" : "md"}`);
    try {
      const session = await sourceReader.writeExport(req.params.id, temporaryPath, format, mode);
      if (!session) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      const filename = exportFileName({ session }, format, mode);
      const stat = await fs.promises.stat(temporaryPath);
      res.status(200);
      res.setHeader("Content-Type", format === "html" ? "text/html; charset=utf-8" : "text/markdown; charset=utf-8");
      res.setHeader("Content-Length", stat.size);
      res.setHeader("Content-Disposition", `${req.query.inline === "true" ? "inline" : "attachment"}; filename="${filename}"`);
      await pipeline(fs.createReadStream(temporaryPath), res);
      await fs.promises.rm(temporaryPath, { force: true });
    } catch (error) {
      await fs.promises.rm(temporaryPath, { force: true });
      if (res.headersSent) res.destroy(error as Error);
      else res.status(500).json({ error: (error as Error).message });
    }
  });

  app.get("/api/sessions/:id/raw/:itemId", async (req, res) => {
    const id = Number(req.params.itemId);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid item id" });
      return;
    }
    const rawJson = await sourceReader.getRawItem(req.params.id, id);
    if (rawJson == null) {
      res.status(404).json({ error: "Raw item not found" });
      return;
    }
    res.json({ id, rawJson });
  });

  if (config.isDev) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        ws: {
          port: config.port + 10_000
        }
      },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    const clientDir = path.resolve(__dirname, "../../client");
    app.use(express.static(clientDir));
    app.get(/.*/, (_req, res) => {
      res.sendFile(path.join(clientDir, "index.html"));
    });
  }

  const server = app.listen(config.port, config.bindHost);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
  } catch (error) {
    await indexer.stopWatcher();
    database.close();
    throw error;
  }
  console.log(`Agent Session Browser listening at http://${config.bindHost}:${config.port}`);
  void indexer.refreshAll();
  if (config.watchSources) indexer.startWatcher();

  const shutdown = async () => {
    server.close();
    await indexer.stopWatcher();
    database.close();
  };
  process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
  process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));
}

main().catch((error) => {
  const systemError = error as NodeJS.ErrnoException & { port?: number };
  if (systemError.code === "EADDRINUSE") {
    console.error(`Agent Session Browser could not start because port ${systemError.port || "4173"} is already in use. Choose another with: asb web --port <number>`);
  } else {
    console.error(error);
  }
  process.exit(1);
});

function parseList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.join(",") : String(value || "");
  return Array.from(new Set(raw.split(",").map((entry) => entry.trim()).filter(Boolean)));
}
