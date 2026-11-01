import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildReport, parseRange } from "./report.js";

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
    // TODO (level 4): filters, sorting and cursor pagination, see docs/contract.md.
    res.status(501).json({ error: "not implemented" });
  });

  app.get("/api/sla-report", (req, res) => {
    const range = parseRange(req.query);
    if (range.error) return res.status(400).json({ error: range.error });
    if (!store || !store.ready) return res.status(503).json({ error: "not ready" });
    res.json(buildReport(store, range.from, range.to));
  });

  return app;
}
