// Builds the SLA report from the store's precomputed rows.

// Strict YYYY-MM-DD that is also a real calendar date; returns the string or null.
export function parseDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) return null;
  return value;
}

// Validate from/to query values. Returns { from, to } or { error }.
export function parseRange(query) {
  const from = parseDate(query.from);
  const to = parseDate(query.to);
  if (!from || !to) return { error: "from and to are required as YYYY-MM-DD" };
  if (from > to) return { error: "from must not be after to" };
  return { from, to };
}

// Rows of every countable request created (site-local date) within [from, to].
export function rowsInRange(store, from, to) {
  const rows = [];
  for (const entry of store.rows.values()) {
    if (entry.countable && entry.localDate >= from && entry.localDate <= to) rows.push(entry.row);
  }
  return rows;
}

// Per-responder summary, grouped by staff id.
export function summarize(rows) {
  const byId = new Map();
  for (const r of rows) {
    if (r.responder_id == null) continue;
    let s = byId.get(r.responder_id);
    if (!s) {
      s = { id: r.responder_id, name: r.responder, requests: 0, within_target: 0, completed_late: 0 };
      byId.set(r.responder_id, s);
    }
    s.requests += 1;
    if (r.within_target === true) s.within_target += 1;
    if (r.completed_late === true) s.completed_late += 1;
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

export function buildReport(store, from, to) {
  const requests = rowsInRange(store, from, to).sort((a, b) => a.id - b.id);
  return { from, to, requests, responders: summarize(requests) };
}

