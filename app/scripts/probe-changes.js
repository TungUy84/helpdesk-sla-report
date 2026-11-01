// Probe the change feed: how long a full read takes and what it contains.
// Run from app/ with HELPDESK_URL and HELPDESK_TOKEN set:  node scripts/probe-changes.js [maxPages]
import { HelpdeskClient } from "../src/helpdesk.js";

const client = new HelpdeskClient();
const maxPages = Number(process.argv[2] || 1000);

const t0 = Date.now();
const types = {};
let cursor;
let pages = 0;
let items = 0;
let first = null;
let last = null;
let lastSeq = 0;
let nonMonotonic = 0;
const requestIds = new Set();
const requestsWithEvents = new Set();

for (; pages < maxPages; ) {
  const body = await client.get("/v1/changes", { cursor, limit: 500 });
  pages++;
  for (const c of body.data) {
    items++;
    types[c.type] = (types[c.type] || 0) + 1;
    if (!first) first = c;
    last = c;
    if (c.seq <= lastSeq) nonMonotonic++;
    lastSeq = Math.max(lastSeq, c.seq);
    if (c.request) requestIds.add(c.request.id);
    if (c.type === "event.created") requestsWithEvents.add(c.request_id);
  }
  cursor = body.next_cursor;
  if (!body.has_more) break;
}

console.log(`pages: ${pages}, items: ${items}, elapsed: ${Date.now() - t0} ms`);
console.log("types:", types);
console.log("first:", JSON.stringify(first).slice(0, 400));
console.log("last:", JSON.stringify(last).slice(0, 400));
console.log("non-monotonic seq:", nonMonotonic);
console.log("distinct requests in request.* items:", requestIds.size);
console.log("distinct requests with event.created:", requestsWithEvents.size);

