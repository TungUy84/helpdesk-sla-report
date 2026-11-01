// Applies the seven rules from docs/rules.md to one request.
import { businessMinutes, localDate, parseDueAt } from "./time.js";

const TARGET_MINUTES = { High: 60, Medium: 240 };
const DEFAULT_TARGET_MINUTES = 480; // Low or null priority

export function targetMinutes(priority) {
  return TARGET_MINUTES[priority] ?? DEFAULT_TARGET_MINUTES;
}

// Rule 1 (status/deleted/merged part): does this request count at all?
export function isCountable(request) {
  return request.status !== "canceled" && !request.deleted_at && request.merged_into_id == null;
}

// Rule 1 (date part): the site-local date the request was created on.
export function createdLocalDate(request, site) {
  return localDate(Date.parse(request.created_at) / 1000, site.timezone);
}

// Rule 2: drop reverted events and the events that revert them.
// Remaining events are sorted by time, then id, so "first"/"last" are deterministic.
export function effectiveEvents(events) {
  const ignored = new Set();
  for (const e of events) {
    if (e.reverts_id != null) {
      ignored.add(e.id);
      ignored.add(e.reverts_id);
    }
  }
  return events
    .filter((e) => !ignored.has(e.id))
    .sort((a, b) => a.at - b.at || a.id - b.id);
}

// Compute the report row for one request.
// staffNames: Map of staff id -> current name.
export function computeRow({ request, events, site, holidays, staffNames }) {
  const evs = effectiveEvents(events);
  const row = {
    id: request.id,
    site_id: request.site_id,
    responder_id: null,
    responder: null,
    response_business_minutes: null,
    within_target: null,
    completed_late: null,
  };

  // Rules 3-5: first response, responder, response minutes, target check
  const first = evs.find((e) => e.status === "processing" && e.actor_id != null);
  if (first) {
    const created = Date.parse(request.created_at) / 1000;
    const minutes = businessMinutes(created, first.at, site, holidays);
    row.responder_id = first.actor_id;
    row.responder = staffNames.get(first.actor_id) ?? first.actor_name ?? null;
    row.response_business_minutes = minutes;
    row.within_target = minutes <= targetMinutes(request.priority);
  }

  // Rule 6: last completion vs. latest deadline
  let lastComplete = null;
  let dueAt = null;
  for (const e of evs) {
    if (e.status === "complete") lastComplete = e;
    if (e.due_at) dueAt = e.due_at;
  }
  if (lastComplete && dueAt) {
    const deadline = parseDueAt(dueAt, site.timezone);
    if (deadline != null) row.completed_late = lastComplete.at > deadline;
  }

  return row;
}

