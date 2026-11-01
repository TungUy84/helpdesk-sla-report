// In-memory store fed by the helpdesk change feed.
// Every change is applied idempotently (keyed by id), so duplicated or out-of-order
// feed items cannot corrupt the state. Report rows are precomputed per request.
import { computeRow, isCountable, createdLocalDate } from "./compute.js";
import { holidaySet } from "./time.js";

export class Store {
  constructor(client, { pollMs = 5000, log = console.log } = {}) {
    this.client = client;
    this.pollMs = pollMs;
    this.log = log;
    this.sites = new Map(); // site id -> site
    this.holidays = new Map(); // site id -> Set of "YYYY-MM-DD"
    this.staff = new Map(); // staff id -> current name
    this.requests = new Map(); // request id -> request
    this.events = new Map(); // request id -> Map(event id -> event)
    this.rows = new Map(); // request id -> { row, localDate, countable }
    this.cursor = undefined;
    this.ready = false;
    this.stopped = false;
  }

  // Load sites, holidays and staff (small, fetched once at start).
  async loadReference() {
    const sites = (await this.client.get("/v1/sites")).data;
    for (const s of sites) {
      this.sites.set(s.id, s);
      this.holidays.set(s.id, holidaySet((await this.client.get(`/v1/sites/${s.id}/holidays`)).data));
    }
    for (const s of (await this.client.get("/v1/staff")).data) this.staff.set(s.id, s.name);
  }

  // Apply one feed item; returns the set of request ids whose row must be recomputed.
  apply(change, dirty) {
    switch (change.type) {
      case "request.created":
      case "request.updated": {
        const incoming = change.request;
        const current = this.requests.get(incoming.id);
        // The feed carries the request "as it is now", so never let an older copy win.
        if (!current || String(incoming.updated_at) >= String(current.updated_at)) {
          this.requests.set(incoming.id, incoming);
          dirty.add(incoming.id);
        }
        break;
      }
      case "event.created": {
        const id = change.request_id;
        if (!this.events.has(id)) this.events.set(id, new Map());
        this.events.get(id).set(change.event.id, change.event);
        dirty.add(id);
        break;
      }
      case "staff.updated": {
        this.staff.set(change.staff.id, change.staff.name);
        // Rows store the responder name, so refresh the ones for this staff member
        for (const [id, entry] of this.rows) {
          if (entry.row.responder_id === change.staff.id) dirty.add(id);
        }
        break;
      }
      default:
        break; // unknown item types are ignored
    }
  }

  // Recompute the stored row of one request (needs the request and its site).
  recompute(id) {
    const request = this.requests.get(id);
    const site = request && this.sites.get(request.site_id);
    if (!request || !site) return;
    const events = [...(this.events.get(id)?.values() ?? [])];
    this.rows.set(id, {
      row: computeRow({ request, events, site, holidays: this.holidays.get(site.id), staffNames: this.staff }),
      localDate: createdLocalDate(request, site),
      countable: isCountable(request),
    });
  }

  // Read the feed until it reports no more changes. Returns the number of items applied.
  async sync() {
    let applied = 0;
    for (;;) {
      let body;
      try {
        body = await this.client.get("/v1/changes", { cursor: this.cursor, limit: 500 });
      } catch (err) {
        if (err.status === 410) {
          // Cursor expired: start again from the beginning; applying is idempotent.
          this.log("change cursor expired (410), restarting from the beginning");
          this.cursor = undefined;
          continue;
        }
        throw err;
      }
      const dirty = new Set();
      for (const change of body.data) this.apply(change, dirty);
      for (const id of dirty) this.recompute(id);
      applied += body.data.length;
      if (body.next_cursor) this.cursor = body.next_cursor;
      if (!body.has_more) return applied;
    }
  }

  // Initial load, then keep polling the feed in the background.
  async start() {
    const t0 = Date.now();
    await this.loadReference();
    await this.sync();
    this.ready = true;
    this.log(`store ready: ${this.requests.size} requests in ${Date.now() - t0} ms`);
    this.poll();
  }

  poll() {
    if (this.stopped) return;
    this.timer = setTimeout(async () => {
      try {
        await this.sync();
      } catch (err) {
        this.log(`sync failed: ${err.message}`);
      }
      this.poll();
    }, this.pollMs);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }
}

