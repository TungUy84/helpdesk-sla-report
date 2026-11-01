import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { createApp } from "../src/app.js";

const site = {
  id: 11,
  timezone: "Asia/Singapore",
  business_hours: {
    mon: { open: "08:00", close: "18:00" }, tue: { open: "08:00", close: "18:00" },
    wed: { open: "08:00", close: "18:00" }, thu: { open: "08:00", close: "18:00" },
    fri: { open: "08:00", close: "18:00" }, sat: null, sun: null,
  },
};

// Monday 2026-10-05 09:00 Singapore
const baseRequest = {
  id: 1, site_id: 11, status: "processing", priority: "High",
  created_at: "2026-10-05T01:00:00Z", updated_at: "2026-10-05T01:00:00Z",
  deleted_at: null, merged_into_id: null,
};
const at = (min) => Date.parse("2026-10-05T01:00:00Z") / 1000 + min * 60;
const reqChange = (seq, type, over = {}) => ({ seq, type, request: { ...baseRequest, ...over } });
const evChange = (seq, e) => ({
  seq, type: "event.created", request_id: 1,
  event: { status: "pending", actor_id: null, actor_name: "System", due_at: null, reverts_id: null, ...e },
});

// Fake client serving a scripted list of feed pages
function fakeClient(pages, { fail410Once = false } = {}) {
  let call = 0;
  let failed = false;
  return {
    async get(path, params = {}) {
      if (path === "/v1/sites") return { data: [site] };
      if (path === "/v1/sites/11/holidays") return { data: [] };
      if (path === "/v1/staff") return { data: [{ id: 304, name: "Benjamin Tan" }] };
      if (path === "/v1/changes") {
        if (fail410Once && !failed && params.cursor) {
          failed = true;
          const err = new Error("expired");
          err.status = 410;
          throw err;
        }
        const i = params.cursor ? Number(params.cursor) : 0;
        call++;
        const data = pages[i] ?? [];
        return { data, next_cursor: String(i + 1), has_more: i + 1 < pages.length };
      }
      throw new Error(`unexpected path ${path}`);
    },
    get calls() { return call; },
  };
}

const quiet = { log: () => {} };

test("loads the feed and computes a row", async () => {
  const store = new Store(fakeClient([[
    reqChange(1, "request.created"),
    evChange(2, { id: 10, status: "processing", at: at(30), actor_id: 304 }),
  ]]), quiet);
  await store.loadReference();
  await store.sync();
  const { row, localDate, countable } = store.rows.get(1);
  assert.equal(row.responder_id, 304);
  assert.equal(row.responder, "Benjamin Tan");
  assert.equal(row.response_business_minutes, 30);
  assert.equal(localDate, "2026-10-05");
  assert.equal(countable, true);
});

test("duplicated and out-of-order items do not corrupt state", async () => {
  const ev = evChange(2, { id: 10, status: "processing", at: at(30), actor_id: 304 });
  const store = new Store(fakeClient([[
    reqChange(5, "request.updated", { status: "complete", updated_at: "2026-10-05T05:00:00Z" }),
    ev,
    ev, // duplicate
    reqChange(1, "request.created"), // older copy arrives late
  ]]), quiet);
  await store.loadReference();
  await store.sync();
  assert.equal(store.requests.get(1).status, "complete"); // older copy did not win
  assert.equal(store.events.get(1).size, 1); // duplicate event stored once
});

test("an event that arrives before its request is used once the request shows up", async () => {
  const store = new Store(fakeClient([[
    evChange(1, { id: 10, status: "processing", at: at(15), actor_id: 304 }),
    reqChange(2, "request.created"),
  ]]), quiet);
  await store.loadReference();
  await store.sync();
  assert.equal(store.rows.get(1).row.response_business_minutes, 15);
});

test("staff.updated renames the responder in existing rows", async () => {
  const store = new Store(fakeClient([[
    reqChange(1, "request.created"),
    evChange(2, { id: 10, status: "processing", at: at(30), actor_id: 304 }),
    { seq: 3, type: "staff.updated", staff: { id: 304, name: "Ben Tan" } },
  ]]), quiet);
  await store.loadReference();
  await store.sync();
  assert.equal(store.rows.get(1).row.responder, "Ben Tan");
});

test("a canceled request is stored but flagged not countable", async () => {
  const store = new Store(fakeClient([[reqChange(1, "request.created", { status: "canceled" })]]), quiet);
  await store.loadReference();
  await store.sync();
  assert.equal(store.rows.get(1).countable, false);
});

test("an expired cursor (410) restarts from the beginning", async () => {
  const pages = [[reqChange(1, "request.created")], [evChange(2, { id: 10, status: "processing", at: at(10), actor_id: 304 })]];
  const store = new Store(fakeClient(pages, { fail410Once: true }), quiet);
  await store.loadReference();
  await store.sync();
  assert.equal(store.rows.get(1).row.response_business_minutes, 10);
});

test("/ready is 503 until the store is ready, then 200", async () => {
  const store = new Store(fakeClient([[reqChange(1, "request.created")]]), quiet);
  const server = createApp({ store }).listen(0);
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address();
    assert.equal((await fetch(`http://127.0.0.1:${port}/ready`)).status, 503);
    store.ready = true;
    const res = await fetch(`http://127.0.0.1:${port}/ready`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ready: true });
  } finally {
    server.close();
  }
});

