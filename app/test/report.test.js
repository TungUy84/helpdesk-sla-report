import test from "node:test";
import assert from "node:assert/strict";
import { parseDate, parseRange, buildReport } from "../src/report.js";
import { createApp } from "../src/app.js";

const row = (id, over = {}) => ({
  id, site_id: 11, responder_id: null, responder: null,
  response_business_minutes: null, within_target: null, completed_late: null, ...over,
});
const entry = (r, localDate, countable = true) => ({ row: r, localDate, countable });

function fakeStore() {
  return {
    ready: true,
    rows: new Map([
      [1, entry(row(1, { responder_id: 304, responder: "Ben", response_business_minutes: 10, within_target: true, completed_late: false }), "2026-10-01")],
      [2, entry(row(2, { responder_id: 304, responder: "Ben", response_business_minutes: 500, within_target: false, completed_late: true }), "2026-10-15")],
      [3, entry(row(3, { responder_id: 338, responder: "Ben", response_business_minutes: 5, within_target: true }), "2026-10-31")],
      [4, entry(row(4), "2026-10-10")], // no response at all
      [5, entry(row(5), "2026-10-10", false)], // not countable (canceled etc.)
      [6, entry(row(6), "2026-11-01")], // outside the range
    ]),
  };
}

test("parseDate accepts only real YYYY-MM-DD dates", () => {
  assert.equal(parseDate("2026-10-01"), "2026-10-01");
  assert.equal(parseDate("2026-02-30"), null);
  assert.equal(parseDate("2026-13-01"), null);
  assert.equal(parseDate("01/10/2026"), null);
  assert.equal(parseDate(undefined), null);
  assert.equal(parseDate(["2026-10-01"]), null);
});

test("parseRange rejects missing, invalid and reversed ranges", () => {
  assert.ok(parseRange({}).error);
  assert.ok(parseRange({ from: "2026-10-01" }).error);
  assert.ok(parseRange({ from: "2026-10-31", to: "2026-10-01" }).error);
  assert.deepEqual(parseRange({ from: "2026-10-01", to: "2026-10-01" }), { from: "2026-10-01", to: "2026-10-01" });
});

test("buildReport keeps countable rows in range, inclusive on both ends", () => {
  const report = buildReport(fakeStore(), "2026-10-01", "2026-10-31");
  assert.deepEqual(report.requests.map((r) => r.id), [1, 2, 3, 4]);
});

test("buildReport summarizes responders by id, even when names match", () => {
  const { responders } = buildReport(fakeStore(), "2026-10-01", "2026-10-31");
  assert.deepEqual(responders, [
    { id: 304, name: "Ben", requests: 2, within_target: 1, completed_late: 1 },
    { id: 338, name: "Ben", requests: 1, within_target: 1, completed_late: 0 },
  ]);
});

async function withServer(store, fn) {
  const server = createApp({ store }).listen(0);
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

test("GET /api/sla-report returns the contract shape", async () => {
  await withServer(fakeStore(), async (base) => {
    const res = await fetch(`${base}/api/sla-report?from=2026-10-01&to=2026-10-31`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.from, "2026-10-01");
    assert.equal(body.to, "2026-10-31");
    assert.equal(body.requests.length, 4);
    assert.deepEqual(Object.keys(body.requests[0]).sort(), [
      "completed_late", "id", "responder", "responder_id",
      "response_business_minutes", "site_id", "within_target",
    ]);
    assert.equal(body.responders.length, 2);
  });
});

test("GET /api/sla-report answers 400 for bad input", async () => {
  await withServer(fakeStore(), async (base) => {
    for (const q of ["", "?from=2026-10-01", "?from=x&to=y", "?from=2026-10-31&to=2026-10-01"]) {
      assert.equal((await fetch(`${base}/api/sla-report${q}`)).status, 400, q);
    }
  });
});

test("GET /api/sla-report answers 503 before the store is ready", async () => {
  const store = fakeStore();
  store.ready = false;
  await withServer(store, async (base) => {
    assert.equal((await fetch(`${base}/api/sla-report?from=2026-10-01&to=2026-10-31`)).status, 503);
  });
});

