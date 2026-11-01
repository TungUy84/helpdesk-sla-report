import test from "node:test";
import assert from "node:assert/strict";
import { businessMinutes, localDate, parseDueAt, holidaySet, wallToEpoch } from "../src/time.js";

const weekdays = (open, close) => ({
  mon: { open, close }, tue: { open, close }, wed: { open, close },
  thu: { open, close }, fri: { open, close }, sat: null, sun: null,
});

const sg = { timezone: "Asia/Singapore", business_hours: weekdays("08:00", "18:00") };
const syd = { timezone: "Australia/Sydney", business_hours: weekdays("07:30", "17:00") };
const jkt = {
  timezone: "Asia/Jakarta",
  business_hours: { ...weekdays("08:00", "17:00"), sat: { open: "08:00", close: "12:00" } },
};
const none = new Set();

// Helper: epoch from a site-local wall-clock time
const at = (site, y, m, d, hh, mm, ss = 0) => wallToEpoch(y, m, d, hh, mm, site.timezone) + ss;

test("within a single business day", () => {
  assert.equal(businessMinutes(at(sg, 2026, 10, 5, 9, 0), at(sg, 2026, 10, 5, 10, 30), sg, none), 90);
});

test("floors to whole minutes", () => {
  assert.equal(businessMinutes(at(sg, 2026, 10, 5, 9, 0), at(sg, 2026, 10, 5, 10, 30, 59), sg, none), 90);
});

test("skips the weekend", () => {
  // Fri 17:00 -> Mon 09:00 = 60 + 60
  assert.equal(businessMinutes(at(sg, 2026, 10, 9, 17, 0), at(sg, 2026, 10, 12, 9, 0), sg, none), 120);
});

test("skips public holidays", () => {
  const hol = holidaySet([{ date: "12/10/2026" }]);
  assert.equal(businessMinutes(at(sg, 2026, 10, 9, 17, 0), at(sg, 2026, 10, 13, 9, 0), sg, hol), 120);
});

test("end before start gives 0", () => {
  assert.equal(businessMinutes(at(sg, 2026, 10, 5, 10, 0), at(sg, 2026, 10, 5, 9, 0), sg, none), 0);
});

test("outside business hours gives 0", () => {
  assert.equal(businessMinutes(at(sg, 2026, 10, 5, 19, 0), at(sg, 2026, 10, 5, 23, 0), sg, none), 0);
});

test("Sydney across the DST change (2026-10-04) stays correct", () => {
  // Fri 16:00 (UTC+10) -> Mon 08:30 (UTC+11) = 60 + 60
  assert.equal(businessMinutes(at(syd, 2026, 10, 2, 16, 0), at(syd, 2026, 10, 5, 8, 30), syd, none), 120);
});

test("Jakarta works Saturday morning", () => {
  assert.equal(businessMinutes(at(jkt, 2026, 10, 10, 7, 0), at(jkt, 2026, 10, 10, 13, 0), jkt, none), 240);
});

test("localDate respects the timezone", () => {
  const t = Date.parse("2026-10-05T18:00:00Z") / 1000;
  assert.equal(localDate(t, "Asia/Jakarta"), "2026-10-06");
  assert.equal(localDate(t, "UTC"), "2026-10-05");
  assert.equal(localDate(Date.parse("2026-10-06T02:15:07Z") / 1000, "Australia/Sydney"), "2026-10-06");
});

test("parseDueAt reads the site-local wall-clock time", () => {
  assert.equal(parseDueAt("07/10/2026 10:00", "Asia/Singapore"), Date.parse("2026-10-07T02:00:00Z") / 1000);
  assert.equal(parseDueAt("bad", "Asia/Singapore"), null);
});
