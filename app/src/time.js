// Các hàm xử lý thời gian theo múi giờ của site và tính giờ làm việc.
// Không dùng offset cố định để xử lý đúng DST (ví dụ Sydney).

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

// Trả về các thành phần giờ địa phương của một thời điểm epoch (giây).
function localParts(epochSec, tz) {
  const parts = {};
  for (const p of formatter(tz).formatToParts(new Date(epochSec * 1000))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return parts;
}

// Độ lệch (giây) của múi giờ so với UTC tại thời điểm epochSec.
function offsetSec(epochSec, tz) {
  const p = localParts(epochSec, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000;
  return asUtc - epochSec;
}

const pad = (n) => String(n).padStart(2, "0");

// Ngày địa phương dạng YYYY-MM-DD của một thời điểm epoch (giây).
export function localDate(epochSec, tz) {
  const p = localParts(epochSec, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

// Đổi giờ treo tường địa phương (y, m, d, hh, mm) sang epoch giây.
export function wallToEpoch(y, m, d, hh, mm, tz) {
  const guess = Date.UTC(y, m - 1, d, hh, mm, 0) / 1000;
  let result = guess - offsetSec(guess, tz);
  // Tính lại offset tại kết quả để xử lý đúng khi qua mốc DST
  result = guess - offsetSec(result, tz);
  return result;
}

// Đổi chuỗi "DD/MM/YYYY HH:mm" (giờ địa phương của site) sang epoch giây.
export function parseDueAt(str, tz) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/.exec(str || "");
  if (!m) return null;
  return wallToEpoch(Number(m[3]), Number(m[2]), Number(m[1]), Number(m[4]), Number(m[5]), tz);
}

// Đổi danh sách ngày lễ [{date: "DD/MM/YYYY"}] sang Set các chuỗi "YYYY-MM-DD".
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

// Số phút giờ làm việc (làm tròn xuống) giữa startSec và endSec.
// site: { timezone, business_hours }, holidays: Set "YYYY-MM-DD".
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
