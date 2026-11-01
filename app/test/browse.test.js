import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";

const row = (id, over = {}) => ({
  id, site_id: 11, responder_id: null, responder: null,
  response_business_minutes: null, within_target: null, completed_late: null, ...over,
});
const entry = (r, localDate = "2026-10-10", countable = true) => ({ row: r, localDate, countable });

function sampleStore() {
  return {
    ready: true,
    rows: new Map([
      [1, entry(row(1, { site_id: 11, responder_id: 304, responder: "Ben", response_business_minutes: 30, within_target: true, completed_late: false }))],
      [2, entry(row(2, { site_id: 12, responder_id: 304, responder: "Ben", response_business_minutes: 10, within_target: true, completed_late: true }))],
      [3, entry(row(3, { site_id: 11, responder_id: 338, responder: "Marcus", response_business_minutes: 30, within_target: false, completed_late: false }))],
      [4, entry(row(4, { site_id: 13, responder_id: null, responder: null, response_business_minutes: null, within_target: null, completed_late: null }))],
      [5, entry(row(5, { site_id: 11, responder_id: 338, responder: "Marcus", response_business_minutes: 120, within_target: false, completed_late: true }))],
      [6, entry(row(6, { site_id: 12, responder_id: null, responder: null, response_business_minutes: null, within_target: null, completed_late: null }))],
    ]),
  };
}

async function withServer(store, fn) {
  const server = createApp({ store }).listen(0);
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

test("GET /api/requests filters by site_id, responder_id, late and within_target", async () => {
  await withServer(sampleStore(), async (base) => {
    const getIds = async (q) => {
      const res = await fetch(`${base}/api/requests?from=2026-10-01&to=2026-10-31&${q}`);
      assert.equal(res.status, 200, q);
      const body = await res.json();
      return body.data.map((r) => r.id);
    };
    assert.deepEqual(await getIds("site_id=11"), [1, 3, 5]);
    assert.deepEqual(await getIds("responder_id=304"), [1, 2]);
    assert.deepEqual(await getIds("late=true"), [2, 5]);
    assert.deepEqual(await getIds("late=false"), [1, 3]);
    assert.deepEqual(await getIds("within_target=true"), [1, 2]);
    assert.deepEqual(await getIds("within_target=false"), [3, 5]);
    assert.deepEqual(await getIds("site_id=11&within_target=false&late=true"), [5]);
  });
});

test("GET /api/requests sorts correctly with nulls last and ties broken by id ascending", async () => {
  await withServer(sampleStore(), async (base) => {
    const getIds = async (sort) => {
      const res = await fetch(`${base}/api/requests?from=2026-10-01&to=2026-10-31&sort=${sort}`);
      assert.equal(res.status, 200);
      return (await res.json()).data.map((r) => r.id);
    };
    assert.deepEqual(await getIds("id"), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(await getIds("-id"), [6, 5, 4, 3, 2, 1]);
    // 10 -> [2], 30 -> [1, 3] (tie by id asc), 120 -> [5], null -> [4, 6] (tie by id asc)
    assert.deepEqual(await getIds("response_business_minutes"), [2, 1, 3, 5, 4, 6]);
    // 120 -> [5], 30 -> [1, 3] (tie by id asc), 10 -> [2], null -> [4, 6] (tie by id asc)
    assert.deepEqual(await getIds("-response_business_minutes"), [5, 1, 3, 2, 4, 6]);
  });
});

test("GET /api/requests walks pages with cursor and stays stable when rows are added/removed mid-walk", async () => {
  const store = sampleStore();
  await withServer(store, async (base) => {
    // Walk with sort=response_business_minutes, limit=2 -> expected full order [2, 1, 3, 5, 4, 6]
    const seen = [];
    let cursor = null;

    // Page 1: [2, 1]
    const res1 = await fetch(`${base}/api/requests?from=2026-10-01&to=2026-10-31&sort=response_business_minutes&limit=2`);
    const body1 = await res1.json();
    assert.deepEqual(body1.data.map((r) => r.id), [2, 1]);
    assert.ok(body1.next_cursor);
    seen.push(...body1.data.map((r) => r.id));
    cursor = body1.next_cursor;

    // Mutate store mid-walk: remove already-seen row 2, and insert a new row 0 with 5 minutes (before pivot)
    store.rows.delete(2);
    store.rows.set(0, entry(row(0, { site_id: 11, response_business_minutes: 5 })));

    // Page 2: should still pick up right after (30, id=1) -> [3, 5] without repeating 1 or skipping 3
    const res2 = await fetch(`${base}/api/requests?from=2026-10-01&to=2026-10-31&sort=response_business_minutes&limit=2&cursor=${encodeURIComponent(cursor)}`);
    const body2 = await res2.json();
    assert.deepEqual(body2.data.map((r) => r.id), [3, 5]);
    assert.ok(body2.next_cursor);
    seen.push(...body2.data.map((r) => r.id));
    cursor = body2.next_cursor;

    // Page 3: [4, 6], last page so next_cursor is null
    const res3 = await fetch(`${base}/api/requests?from=2026-10-01&to=2026-10-31&sort=response_business_minutes&limit=2&cursor=${encodeURIComponent(cursor)}`);
    const body3 = await res3.json();
    assert.deepEqual(body3.data.map((r) => r.id), [4, 6]);
    assert.equal(body3.next_cursor, null);
    seen.push(...body3.data.map((r) => r.id));

    // Every row that existed for the whole walk (1, 3, 4, 5, 6) appeared exactly once
    for (const id of [1, 3, 4, 5, 6]) {
      assert.equal(seen.filter((x) => x === id).length, 1, `id ${id} appears once`);
    }
  });
});

test("GET /api/requests rejects invalid parameters and forged or mismatched cursors with 400, ignores unknown params", async () => {
  await withServer(sampleStore(), async (base) => {
    const status = async (q) => (await fetch(`${base}/api/requests?${q}`)).status;
    assert.equal(await status("from=2026-10-01&to=2026-10-31&unknown_param=xyz"), 200);
    assert.equal(await status("from=2026-10-01"), 400);
    assert.equal(await status("from=2026-10-01&to=2026-10-31&site_id=abc"), 400);
    assert.equal(await status("from=2026-10-01&to=2026-10-31&responder_id=0"), 400);
    assert.equal(await status("from=2026-10-01&to=2026-10-31&late=yes"), 400);
    assert.equal(await status("from=2026-10-01&to=2026-10-31&within_target=1"), 400);
    assert.equal(await status("from=2026-10-01&to=2026-10-31&sort=priority"), 400);
    assert.equal(await status("from=2026-10-01&to=2026-10-31&limit=0"), 400);
    assert.equal(await status("from=2026-10-01&to=2026-10-31&limit=201"), 400);
    assert.equal(await status("from=2026-10-01&to=2026-10-31&cursor=not-a-valid-cursor"), 400);

    // Cursor issued for sort=id must be rejected when reused with sort=-id
    const res = await fetch(`${base}/api/requests?from=2026-10-01&to=2026-10-31&sort=id&limit=2`);
    const { next_cursor } = await res.json();
    assert.equal(await status(`from=2026-10-01&to=2026-10-31&sort=-id&limit=2&cursor=${encodeURIComponent(next_cursor)}`), 400);
  });
});

