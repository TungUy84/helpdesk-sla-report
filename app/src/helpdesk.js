// Helpdesk API client with retry/backoff, pagination helpers and a concurrency limiter.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class HelpdeskError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "HelpdeskError";
    this.status = status;
  }
}

export class HelpdeskClient {
  constructor({
    baseUrl = process.env.HELPDESK_URL || "http://localhost:4010",
    token = process.env.HELPDESK_TOKEN || "",
    maxAttempts = 6,
    baseDelayMs = 500,
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token;
    this.maxAttempts = maxAttempts;
    this.baseDelayMs = baseDelayMs;
    this.fetch = fetchImpl;
  }

  // Delay before the next attempt: honour Retry-After (seconds) if present,
  // otherwise exponential backoff with a little jitter.
  retryDelay(attempt, res) {
    const header = res && res.headers && res.headers.get("retry-after");
    const seconds = header ? Number(header) : NaN;
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30000);
    return Math.min(this.baseDelayMs * 2 ** attempt, 15000) + Math.random() * 250;
  }

  // GET a path with optional query params; returns parsed JSON.
  // Retries on 429, 5xx and network errors. Other 4xx errors are thrown immediately.
  async get(pathname, params = {}) {
    const url = new URL(this.baseUrl + pathname);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, value);
    }
    let lastError;
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      let res;
      try {
        res = await this.fetch(url, {
          headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json" },
        });
      } catch (err) {
        lastError = new HelpdeskError(`Helpdesk API GET ${pathname} network error: ${err.message}`, 0);
        await sleep(this.retryDelay(attempt, null));
        continue;
      }
      if (res.ok) return res.json();
      const body = await res.text();
      lastError = new HelpdeskError(`Helpdesk API GET ${pathname} failed: ${res.status} ${body}`, res.status);
      if (res.status === 429 || res.status >= 500) {
        await sleep(this.retryDelay(attempt, res));
        continue;
      }
      throw lastError;
    }
    throw lastError;
  }

  // Walk every page of /v1/requests for the given filters.
  async *requestPages(params = {}, perPage = 100) {
    let page = 1;
    for (;;) {
      const body = await this.get("/v1/requests", { ...params, page, per_page: perPage });
      yield body;
      if (page >= body.total_pages || body.data.length === 0) return;
      page += 1;
    }
  }

  // All events of one request (the API pages them, newest first).
  async allEvents(requestId) {
    const events = [];
    for (let page = 1; ; page++) {
      const body = await this.get(`/v1/requests/${requestId}/events`, { page });
      events.push(...body.data);
      if (!body.has_more) return events;
    }
  }
}

// Run fn over items with at most `limit` calls in flight; results keep input order.
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
