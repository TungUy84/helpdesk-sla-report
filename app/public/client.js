const SITES = { 11: "Singapore", 12: "Sydney", 13: "Jakarta" };
let cursorHistory = [null];
let pageIndex = 0;
let nextCursor = null;

const cell = (text, cls) => {
  const td = document.createElement("td");
  td.textContent = text;
  if (cls) td.className = cls;
  return td;
};

const pillCell = (v, badWhenTrue) => {
  const td = document.createElement("td");
  const span = document.createElement("span");
  if (v === null) {
    span.className = "pill neutral";
    span.textContent = "—";
  } else {
    const bad = badWhenTrue ? v : !v;
    span.className = "pill " + (bad ? "late" : "ok");
    span.textContent = v ? "Yes" : "No";
  }
  td.appendChild(span);
  return td;
};

const siteCell = (siteId) => {
  const td = document.createElement("td");
  const span = document.createElement("span");
  span.className = "site-tag";
  span.textContent = SITES[siteId] ? `${siteId} · ${SITES[siteId]}` : siteId;
  td.appendChild(span);
  return td;
};

function fill(table, rows) {
  const body = table.querySelector("tbody");
  body.replaceChildren();
  for (const item of rows) {
    const tr = document.createElement("tr");
    const cells = Array.isArray(item) ? item : item.cells;
    if (item.onClick) {
      tr.className = "clickable-row";
      tr.addEventListener("click", item.onClick);
    }
    cells.forEach((c) => tr.appendChild(c));
    body.appendChild(tr);
  }
}

async function checkReady() {
  const badge = document.getElementById("readyBadge");
  const text = document.getElementById("readyText");
  try {
    const res = await fetch("/ready");
    if (res.ok) {
      badge.classList.add("is-ready");
      text.textContent = "Store Ready (Live Syncing)";
      return true;
    }
  } catch {}
  badge.classList.remove("is-ready");
  text.textContent = "Syncing initial feed...";
  return false;
}

function buildBrowseParams(cursor) {
  const fd = new FormData(document.getElementById("f"));
  const params = new URLSearchParams();
  for (const [k, v] of fd.entries()) {
    if (v !== "") params.set(k, v);
  }
  if (cursor) params.set("cursor", cursor);
  return params;
}

async function loadSummary() {
  const fd = new FormData(document.getElementById("f"));
  const from = fd.get("from");
  const to = fd.get("to");
  const params = new URLSearchParams({ from, to });
  const t0 = performance.now();
  const res = await fetch("/api/sla-report?" + params);
  const data = await res.json();
  const elapsed = Math.round(performance.now() - t0);
  if (!res.ok) throw new Error(res.status + ": " + (data.error || "unknown"));

  const select = document.getElementById("responder_id");
  const current = select.value;
  select.replaceChildren(new Option("All responders", ""));
  for (const r of data.responders) {
    select.appendChild(new Option(`${r.name} (#${r.id})`, String(r.id)));
  }
  select.value = current;

  const total = data.requests.length;
  const responded = data.requests.filter((r) => r.within_target !== null);
  const within = responded.filter((r) => r.within_target === true).length;
  const withDeadline = data.requests.filter((r) => r.completed_late !== null);
  const late = withDeadline.filter((r) => r.completed_late === true).length;

  document.getElementById("kpiTotal").textContent = total.toLocaleString();
  document.getElementById("kpiRange").textContent = `${data.from} → ${data.to}`;
  document.getElementById("kpiTarget").textContent = responded.length
    ? `${Math.round((within / responded.length) * 100)}%`
    : "—";
  document.getElementById("kpiTargetSub").textContent = `${within.toLocaleString()} / ${responded.length.toLocaleString()} responded`;
  document.getElementById("kpiLate").textContent = withDeadline.length
    ? `${Math.round((late / withDeadline.length) * 100)}%`
    : "—";
  document.getElementById("kpiLateSub").textContent = `${late.toLocaleString()} / ${withDeadline.length.toLocaleString()} with deadline`;
  document.getElementById("kpiTime").textContent = `${elapsed} ms`;

  fill(document.getElementById("responders"), data.responders.map((r) => {
    const pct = r.requests ? Math.round((r.within_target / r.requests) * 100) + "%" : "—";
    return {
      onClick: () => {
        document.getElementById("responder_id").value = String(r.id);
        cursorHistory = [null];
        pageIndex = 0;
        loadPage(null);
      },
      cells: [
        cell("#" + r.id, "num"),
        cell(r.name),
        cell(r.requests, "num"),
        cell(r.within_target, "num"),
        cell(pct, "num"),
        cell(r.completed_late, "num"),
      ],
    };
  }));
  return total;
}

async function loadPage(cursor) {
  const status = document.getElementById("status");
  const params = buildBrowseParams(cursor);
  const res = await fetch("/api/requests?" + params);
  const body = await res.json();
  if (!res.ok) throw new Error(res.status + ": " + (body.error || "unknown"));
  nextCursor = body.next_cursor;
  fill(document.getElementById("report"), body.data.map((r) => [
    cell(r.id, "num"),
    siteCell(r.site_id),
    cell(r.responder ? `${r.responder} (#${r.responder_id})` : "—"),
    cell(r.response_business_minutes ?? "—", "num"),
    pillCell(r.within_target, false),
    pillCell(r.completed_late, true),
  ]));
  document.getElementById("pageInfo").textContent = `Page ${pageIndex + 1} (${body.data.length} rows)`;
  document.getElementById("firstBtn").disabled = pageIndex === 0;
  document.getElementById("prevBtn").disabled = pageIndex === 0;
  document.getElementById("nextBtn").disabled = !nextCursor;
  status.textContent = `Showing ${body.data.length} rows on page ${pageIndex + 1}`;
}

async function runAll() {
  const status = document.getElementById("status");
  status.textContent = "Loading...";
  cursorHistory = [null];
  pageIndex = 0;
  try {
    const total = await loadSummary();
    await loadPage(null);
    status.textContent += ` · ${total.toLocaleString()} total countable requests in range`;
  } catch (err) {
    status.textContent = "Error " + err.message;
  }
}

document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  await runAll();
});

for (const btn of document.querySelectorAll(".preset-btn[data-from]")) {
  btn.addEventListener("click", () => {
    document.getElementById("fromInput").value = btn.dataset.from;
    document.getElementById("toInput").value = btn.dataset.to;
    runAll();
  });
}

document.getElementById("resetFiltersBtn").addEventListener("click", () => {
  document.getElementById("site_id").value = "";
  document.getElementById("responder_id").value = "";
  document.getElementById("within_target").value = "";
  document.getElementById("late").value = "";
  document.getElementById("sort").value = "id";
  document.getElementById("limit").value = "50";
  runAll();
});

document.getElementById("nextBtn").addEventListener("click", async () => {
  if (!nextCursor) return;
  pageIndex += 1;
  cursorHistory[pageIndex] = nextCursor;
  await loadPage(nextCursor);
});

document.getElementById("prevBtn").addEventListener("click", async () => {
  if (pageIndex === 0) return;
  pageIndex -= 1;
  await loadPage(cursorHistory[pageIndex]);
});

document.getElementById("firstBtn").addEventListener("click", async () => {
  pageIndex = 0;
  await loadPage(null);
});

(async () => {
  const ok = await checkReady();
  if (ok) runAll();
  setInterval(async () => {
    const wasReady = document.getElementById("readyBadge").classList.contains("is-ready");
    const nowReady = await checkReady();
    if (!wasReady && nowReady) runAll();
  }, 4000);
})();

