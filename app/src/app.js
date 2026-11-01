import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildReport, parseRange } from "./report.js";
import { browseRequests, parseBrowseQuery } from "./browse.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp({ store } = {}) {
  const app = express();

  app.use(express.static(path.join(here, "..", "public")));

  app.get("/health", (req, res) => {
    res.json({ ok: true });
  });

  app.get("/ready", (req, res) => {
    // Ready once the store has finished its initial load of the change feed
    if (store && store.ready) return res.json({ ready: true });
    res.status(503).json({ ready: false });
  });

  app.get("/api/requests", (req, res) => {
    const parsed = parseBrowseQuery(req.query);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    if (!store || !store.ready) return res.status(503).json({ error: "not ready" });
    res.json(browseRequests(store, parsed));
  });

  app.get("/api/sla-report", (req, res) => {
    const range = parseRange(req.query);
    if (range.error) return res.status(400).json({ error: range.error });
    if (!store || !store.ready) return res.status(503).json({ error: "not ready" });
    res.json(buildReport(store, range.from, range.to));
  });

  return app;
}
