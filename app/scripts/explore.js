// Exploration script: samples real data and reports anomalies. Run from app/ with
// HELPDESK_URL and HELPDESK_TOKEN set:  node scripts/explore.js [sampleSize]
import { HelpdeskClient, mapLimit } from "../src/helpdesk.js";

const client = new HelpdeskClient();
const sample = Number(process.argv[2] || 300);

const sites = (await client.get("/v1/sites")).data;
const staff = (await client.get("/v1/staff")).data;
const staffIds = new Set(staff.map((s) => s.id));
console.log("sites:", sites.map((s) => `${s.id}:${s.timezone}`).join(", "));
for (const s of sites) {
  const hol = (await client.get(`/v1/sites/${s.id}/holidays`)).data;
  console.log(`site ${s.id} holidays: ${hol.length}`, hol.slice(0, 3));
}

// Fetch a few pages of requests (October with a day of margin on each side)
const requests = [];
for await (const page of client.requestPages({ created_from: "30/09/2026", created_to: "01/11/2026" })) {
  requests.push(...page.data);
  if (requests.length >= sample * 2) break;
}
console.log("requests fetched:", requests.length);

const count = (arr, f) => arr.filter(f).length;
console.log("status counts:", Object.fromEntries(["pending", "processing", "complete", "canceled"].map((s) => [s, count(requests, (r) => r.status === s)])));
console.log("priority counts:", Object.fromEntries(["High", "Medium", "Low", null].map((p) => [String(p), count(requests, (r) => r.priority === p)])));
console.log("deleted:", count(requests, (r) => r.deleted_at), "merged:", count(requests, (r) => r.merged_into_id != null));

const subset = requests.slice(0, sample);
const t0 = Date.now();
const all = await mapLimit(subset, 5, (r) => client.allEvents(r.id));
console.log(`events for ${subset.length} requests in ${Date.now() - t0} ms`);

const stats = {
  withRevert: 0, revertTargetMissing: 0, revertOfRevert: 0, tiedAt: 0, unsortedFromApi: 0,
  badDueAt: 0, multiDueAt: 0, noEvents: 0, unknownActor: 0, processingNoActor: 0,
  multiPage: 0, maxEvents: 0, eventBeforeCreated: 0, nameMismatch: 0,
};
subset.forEach((r, i) => {
  const evs = all[i];
  stats.maxEvents = Math.max(stats.maxEvents, evs.length);
  if (evs.length === 0) stats.noEvents++;
  const byId = new Map(evs.map((e) => [e.id, e]));
  const created = Date.parse(r.created_at) / 1000;
  let hasRevert = false;
  const ats = new Set();
  let dueCount = 0;
  for (const e of evs) {
    if (e.reverts_id != null) {
      hasRevert = true;
      const target = byId.get(e.reverts_id);
      if (!target) stats.revertTargetMissing++;
      else if (target.reverts_id != null) stats.revertOfRevert++;
    }
    if (ats.has(e.at)) stats.tiedAt++;
    ats.add(e.at);
    if (e.due_at) {
      dueCount++;
      if (!/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/.test(e.due_at)) stats.badDueAt++;
    }
    if (e.actor_id != null && !staffIds.has(e.actor_id)) stats.unknownActor++;
    if (e.status === "processing" && e.actor_id == null) stats.processingNoActor++;
    if (e.at < created) stats.eventBeforeCreated++;
    if (e.actor_id != null) {
      const s = staff.find((x) => x.id === e.actor_id);
      if (s && s.name !== e.actor_name) stats.nameMismatch++;
    }
  }
  if (hasRevert) stats.withRevert++;
  if (dueCount > 1) stats.multiDueAt++;
  for (let k = 1; k < evs.length; k++) if (evs[k - 1].at < evs[k].at) { stats.unsortedFromApi++; break; }
});
console.log("anomaly stats over sample:", stats);
console.log("staff names:", staff.map((s) => `${s.id}:${s.name}`).join(" | "));

