import test from "node:test";
import assert from "node:assert/strict";
import { computeRow, effectiveEvents, isCountable, createdLocalDate, targetMinutes } from "../src/compute.js";
import { wallToEpoch } from "../src/time.js";
import { HelpdeskClient, mapLimit } from "../src/helpdesk.js";

const site = {
  timezone: "Asia/Singapore",
  business_hours: {
    mon: { open: "08:00", close: "18:00" }, tue: { open: "08:00", close: "18:00" },
    wed: { open: "08:00", close: "18:00" }, thu: { open: "08:00", close: "18:00" },
    fri: { open: "08:00", close: "18:00" }, sat: null, sun: null,
  },
};
const holidays = new Set();
const staffNames = new Map([[304, "Benjamin Tan"], [338, "Benjamin Tan"]]);
const at = (d, hh, mm) => wallToEpoch(2026, 10, d, hh, mm, site.timezone);

// Monday 2026-10-05 09:00 Singapore = 01:00Z
const request = { id: 1, site_id: 11, status: "complete", priority: "High", created_at: "2026-10-05T01:00:00Z", deleted_at: null, merged_into_id: null };
let nextId = 100;
const ev = (o) => ({ id: nextId++, status: "pending", at: 0, actor_id: null, actor_name: "System", due_at: null, reverts_id: null, ...o });
const run = (events, req = request) => computeRow({ request: req, events, site, holidays, staffNames });

test("rule 1: canceled, deleted and merged requests are not countable", () => {
  assert.equal(isCountable(request), true);
  assert.equal(isCountable({ ...request, status: "canceled" }), false);
  assert.equal(isCountable({ ...request, deleted_at: "2026-10-06T00:00:00Z" }), false);
  assert.equal(isCountable({ ...request, merged_into_id: 7 }), false);
});

test("rule 1: created date uses the site-local date", () => {
  // 2026-10-05T17:00Z is already 6 Oct in Singapore
  assert.equal(createdLocalDate({ created_at: "2026-10-05T17:00:00Z" }, site), "2026-10-06");
});

test("rule 2: reverted event and its reverting event are both ignored", () => {
  const a = ev({ id: 1, status: "processing", at: 10, actor_id: 304 });
  const b = ev({ id: 2, status: "processing", at: 20, actor_id: 304, reverts_id: 1 });
  const c = ev({ id: 3, status: "pending", at: 30 });
  assert.deepEqual(effectiveEvents([c, b, a]).map((e) => e.id), [3]);
});

test("rule 3: first processing event with an actor; System is skipped; current name used", () => {
  const events = [
    ev({ status: "processing", at: at(5, 9, 5), actor_id: null }),
    ev({ status: "processing", at: at(5, 9, 20), actor_id: 304, actor_name: "Old Name" }),
    ev({ status: "processing", at: at(5, 9, 40), actor_id: 338 }),
  ];
  const row = run(events);
  assert.equal(row.responder_id, 304);
  assert.equal(row.responder, "Benjamin Tan");
  assert.equal(row.response_business_minutes, 20);
});

test("rule 3: a reverted first response is ignored, the next one counts", () => {
  const first = ev({ id: 10, status: "processing", at: at(5, 9, 5), actor_id: 304 });
  const undo = ev({ id: 11, status: "pending", at: at(5, 9, 6), reverts_id: 10 });
  const second = ev({ id: 12, status: "processing", at: at(5, 9, 30), actor_id: 338 });
  const row = run([first, undo, second]);
  assert.equal(row.responder_id, 338);
  assert.equal(row.response_business_minutes, 30);
});

test("rule 4: response before created_at gives 0", () => {
  const row = run([ev({ status: "processing", at: at(5, 8, 0), actor_id: 304 })]);
  assert.equal(row.response_business_minutes, 0);
  assert.equal(row.within_target, true);
});

test("rule 5: targets per priority and the boundary is inclusive", () => {
  assert.equal(targetMinutes("High"), 60);
  assert.equal(targetMinutes("Medium"), 240);
  assert.equal(targetMinutes("Low"), 480);
  assert.equal(targetMinutes(null), 480);
  const exactly60 = run([ev({ status: "processing", at: at(5, 10, 0), actor_id: 304 })]);
  assert.equal(exactly60.within_target, true);
  const over = run([ev({ status: "processing", at: at(5, 10, 1), actor_id: 304 })]);
  assert.equal(over.within_target, false);
});

test("rule 6: late when the last complete is strictly after the latest deadline", () => {
  const events = [
    ev({ at: at(5, 9, 0), due_at: "05/10/2026 12:00" }),
    ev({ at: at(5, 10, 0), due_at: "05/10/2026 15:00" }),
    ev({ status: "complete", at: at(5, 15, 0) }),
  ];
  assert.equal(run(events).completed_late, false);
  events[2].at = at(5, 15, 0) + 1; // one second after the deadline is late
  assert.equal(run(events).completed_late, true);
});

test("rule 6: uses the last complete even if the request was reopened", () => {
  const events = [
    ev({ at: at(5, 9, 0), due_at: "05/10/2026 12:00" }),
    ev({ status: "complete", at: at(5, 11, 0) }),
    ev({ status: "processing", at: at(5, 11, 30), actor_id: 304 }),
    ev({ status: "complete", at: at(5, 13, 0) }),
  ];
  assert.equal(run(events).completed_late, true);
});

test("rule 7: no response, never completed, no deadline give nulls", () => {
  const row = run([ev({ status: "pending", at: at(5, 9, 0) })]);
  assert.equal(row.responder_id, null);
  assert.equal(row.responder, null);
  assert.equal(row.response_business_minutes, null);
  assert.equal(row.within_target, null);
  assert.equal(row.completed_late, null);
  const noDeadline = run([ev({ status: "complete", at: at(5, 9, 0) })]);
  assert.equal(noDeadline.completed_late, null);
});

test("client retries on 429 then succeeds", async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    if (calls < 3) return { ok: false, status: 429, headers: new Headers({ "retry-after": "0" }), text: async () => "slow down" };
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const client = new HelpdeskClient({ baseUrl: "http://x", token: "t", fetchImpl: fakeFetch });
  assert.deepEqual(await client.get("/v1/staff"), { ok: true });
  assert.equal(calls, 3);
});

test("client does not retry a 404", async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    return { ok: false, status: 404, headers: new Headers(), text: async () => "nope" };
  };
  const client = new HelpdeskClient({ baseUrl: "http://x", token: "t", fetchImpl: fakeFetch });
  await assert.rejects(() => client.get("/v1/missing"), { status: 404 });
  assert.equal(calls, 1);
});

test("mapLimit keeps order and respects the limit", async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    return n * 10;
  });
  assert.deepEqual(out, [10, 20, 30, 40, 50, 60]);
  assert.ok(peak <= 2);
});
