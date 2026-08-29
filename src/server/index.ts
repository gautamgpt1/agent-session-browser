import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { resolveAppConfig } from "./config.js";
import { ViewerDatabase } from "./database.js";
import { SessionIndexer } from "./indexer.js";
import { exportFileName, exportSession } from "./session-actions.js";
import { localOnlySecurity } from "./security.js";
import type { ExportMode } from "../shared/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main(): Promise<void> {
  const config = resolveAppConfig();
  const database = new ViewerDatabase(config.dbPath);
  const indexer = new SessionIndexer(config, database);
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

  app.get("/api/sessions", (req, res) => {
    try {
      res.json(database.listSessions(req.query as Record<string, string>, indexer.getStatus()));
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  app.get("/api/sessions/:id", (req, res) => {
    const detail = database.getSessionDetail(req.params.id);
    if (!detail) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json(detail);
  });

  app.get("/api/sessions/:id/export", (req, res) => {
    const detail = database.getSessionDetail(req.params.id);
    if (!detail) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const format = req.query.format === "html" ? "html" : "markdown";
    const requestedMode = String(req.query.mode || "conversation");
    const mode: ExportMode = requestedMode === "trace" || requestedMode === "readable" ? requestedMode : "conversation";
    const body = exportSession(detail, format, mode, mode === "trace" ? database.getSessionRawItems(detail.session.id) : []);
    const filename = exportFileName(detail, format);
    res.setHeader("Content-Type", format === "html" ? "text/html; charset=utf-8" : "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(body);
  });

  app.get("/api/raw/:itemId", (req, res) => {
    const id = Number(req.params.itemId);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid item id" });
      return;
    }
    const rawJson = database.getRawItem(id);
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

  const server = app.listen(config.port, config.bindHost, () => {
    console.log(`Agent Session Browser listening at http://${config.bindHost}:${config.port}`);
    void indexer.refreshAll();
    if (config.watchSources) indexer.startWatcher();
  });

  const shutdown = async () => {
    server.close();
    await indexer.stopWatcher();
    database.close();
  };
  process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
  process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
