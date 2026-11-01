// Filtering, sorting and keyset-cursor pagination for GET /api/requests (level 4).
import crypto from "node:crypto";
import { parseRange, rowsInRange } from "./report.js";

const VALID_SORTS = new Set(["id", "-id", "response_business_minutes", "-response_business_minutes"]);

// Secret used to sign cursors so cursors not issued by this process are rejected with 400.
const CURSOR_SECRET = crypto.randomBytes(32);

function parsePositiveInt(val) {
  if (typeof val !== "string" || !/^[1-9]\d*$/.test(val)) return null;
  const n = Number(val);
  return Number.isSafeInteger(n) ? n : null;
}

function parseBool(val) {
  if (val === "true") return true;
  if (val === "false") return false;
  return null;
}

// Compare two rows under the requested sort order.
// Nulls always come last; ties are broken by id ascending.
export function compareRows(a, b, sort) {
  if (sort === "id") return a.id - b.id;
  if (sort === "-id") return b.id - a.id;

  const av = a.response_business_minutes;
  const bv = b.response_business_minutes;
  if (av === null && bv === null) return a.id - b.id;
  if (av === null) return 1;
  if (bv === null) return -1;
  if (av !== bv) {
    return sort === "response_business_minutes" ? av - bv : bv - av;
  }
  return a.id - b.id;
}

// Sign and encode a keyset cursor containing the query signature and last seen row key.
export function encodeCursor(payload) {
  const data = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", CURSOR_SECRET).update(data).digest("base64url");
  return `${data}.${sig}`;
}

// Verify and decode a cursor; returns payload object or null if invalid/tampered.
export function decodeCursor(token) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  if (!data || !sig) return null;
  const expected = crypto.createHmac("sha256", CURSOR_SECRET).update(data).digest("base64url");
  const sigBuf = Buffer.from(sig, "utf8");
  const expBuf = Buffer.from(expected, "utf8");
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  try {
    const obj = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    if (!obj || typeof obj !== "object" || typeof obj.id !== "number") return null;
    return obj;
  } catch {
    return null;
  }
}

// Build a canonical string of the filter+sort parameters to bind a cursor to its walk.
function queryKey({ from, to, siteId, responderId, late, withinTarget, sort }) {
  return `${from}|${to}|${siteId ?? ""}|${responderId ?? ""}|${late ?? ""}|${withinTarget ?? ""}|${sort}`;
}

// Validate and parse all query parameters for GET /api/requests.
export function parseBrowseQuery(query) {
  const range = parseRange(query);
  if (range.error) return { error: range.error };

  let siteId = null;
  if (query.site_id !== undefined) {
    siteId = parsePositiveInt(query.site_id);
    if (siteId === null) return { error: "invalid site_id" };
  }

  let responderId = null;
  if (query.responder_id !== undefined) {
    responderId = parsePositiveInt(query.responder_id);
    if (responderId === null) return { error: "invalid responder_id" };
  }

  let late = null;
  if (query.late !== undefined) {
    late = parseBool(query.late);
    if (late === null) return { error: "invalid late" };
  }

  let withinTarget = null;
  if (query.within_target !== undefined) {
    withinTarget = parseBool(query.within_target);
    if (withinTarget === null) return { error: "invalid within_target" };
  }

  let sort = "id";
  if (query.sort !== undefined) {
    if (typeof query.sort !== "string" || !VALID_SORTS.has(query.sort)) {
      return { error: "invalid sort" };
    }
    sort = query.sort;
  }

  let limit = 50;
  if (query.limit !== undefined) {
    const n = parsePositiveInt(query.limit);
    if (n === null || n < 1 || n > 200) return { error: "invalid limit" };
    limit = n;
  }

  const params = {
    from: range.from,
    to: range.to,
    siteId,
    responderId,
    late,
    withinTarget,
    sort,
    limit,
    cursor: null,
  };

  if (query.cursor !== undefined) {
    const decoded = decodeCursor(query.cursor);
    if (!decoded || decoded.q !== queryKey(params)) {
      return { error: "invalid cursor" };
    }
    if ( decoded.v !== null && typeof decoded.v !== "number") {
      return { error: "invalid cursor" };
    }
    params.cursor = decoded;
  }

  return params;
}

// Execute filtered, sorted and keyset-paginated browse query against the store.
export function browseRequests(store, params) {
  const { from, to, siteId, responderId, late, withinTarget, sort, limit, cursor } = params;

  const filtered = rowsInRange(store, from, to).filter((r) => {
    if (siteId !== null && r.site_id !== siteId) return false;
    if (responderId !== null && r.responder_id !== responderId) return false;
    if (late !== null && r.completed_late !== late) return false;
    if (withinTarget !== null && r.within_target !== withinTarget) return false;
    return true;
  });

  filtered.sort((a, b) => compareRows(a, b, sort));

  // Keyset seek: keep only rows strictly after the cursor position in the sort order.
  let afterCursor = filtered;
  if (cursor) {
    const pivot = { id: cursor.id, response_business_minutes: cursor.v };
    afterCursor = filtered.filter((r) => compareRows(r, pivot, sort) > 0);
  }

  const page = afterCursor.slice(0, limit);
  const hasMore = afterCursor.length > limit;
  let nextCursor = null;
  if (hasMore && page.length > 0) {
    const last = page[page.length - 1];
    nextCursor = encodeCursor({
      q: queryKey(params),
      id: last.id,
      v: last.response_business_minutes,
    });
  }

  return { data: page, next_cursor: nextCursor };
}

