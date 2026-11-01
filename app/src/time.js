// Timezone-aware time helpers and business-hours calculation.
// No fixed offsets are used, so DST (e.g. Sydney) is handled correctly.

const fmtCache = new Map();

function formatter(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

// Local wall-clock components of an epoch (seconds) in the given timezone.
function localParts(epochSec, tz) {
  const parts = {};
  for (const p of formatter(tz).formatToParts(new Date(epochSec * 1000))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return parts;
}

// Offset (seconds) of the timezone from UTC at the given instant.
function offsetSec(epochSec, tz) {
  const p = localParts(epochSec, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000;
  return asUtc - epochSec;
}

const pad = (n) => String(n).padStart(2, "0");

// Local date (YYYY-MM-DD) of an epoch in seconds.
export function localDate(epochSec, tz) {
  const p = localParts(epochSec, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

// Convert a local wall-clock time (y, m, d, hh, mm) to epoch seconds.
export function wallToEpoch(y, m, d, hh, mm, tz) {
  const guess = Date.UTC(y, m - 1, d, hh, mm, 0) / 1000;
  let result = guess - offsetSec(guess, tz);
  // Recompute the offset at the result so DST transitions are handled
  result = guess - offsetSec(result, tz);
  return result;
}

// Convert "DD/MM/YYYY HH:mm" (site local time) to epoch seconds, or null if malformed.
export function parseDueAt(str, tz) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/.exec(str || "");
  if (!m) return null;
  return wallToEpoch(Number(m[3]), Number(m[2]), Number(m[1]), Number(m[4]), Number(m[5]), tz);
}

// Convert holidays [{date: "DD/MM/YYYY"}] to a Set of "YYYY-MM-DD" strings.
export function holidaySet(list) {
  const set = new Set();
  for (const h of list || []) {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(h.date || "");
    if (m) set.add(`${m[3]}-${m[2]}-${m[1]}`);
  }
  return set;
}

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function addDays(y, m, d, n) {
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return [dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()];
}

// Business minutes (floored) between startSec and endSec.
// site: { timezone, business_hours }, holidays: Set of "YYYY-MM-DD".
export function businessMinutes(startSec, endSec, site, holidays) {
  if (endSec <= startSec) return 0;
  const tz = site.timezone;
  const s = localParts(startSec, tz);
  const e = localParts(endSec, tz);
  const endKey = Date.UTC(e.year, e.month - 1, e.day);
  let [y, m, d] = [s.year, s.month, s.day];
  let seconds = 0;

  while (Date.UTC(y, m - 1, d) <= endKey) {
    const dateStr = `${y}-${pad(m)}-${pad(d)}`;
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    const hours = site.business_hours[DAY_KEYS[dow]];
    if (hours && !holidays.has(dateStr)) {
      const [oh, om] = hours.open.split(":").map(Number);
      const [ch, cm] = hours.close.split(":").map(Number);
      const open = wallToEpoch(y, m, d, oh, om, tz);
      const close = wallToEpoch(y, m, d, ch, cm, tz);
      const from = Math.max(open, startSec);
      const to = Math.min(close, endSec);
      if (to > from) seconds += to - from;
    }
    [y, m, d] = addDays(y, m, d, 1);
  }
  return Math.floor(seconds / 60);
}
