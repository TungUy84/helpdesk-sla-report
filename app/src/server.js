import { createApp } from "./app.js";
import { HelpdeskClient } from "./helpdesk.js";
import { Store } from "./store.js";

const port = Number(process.env.PORT || 8080);

const store = new Store(new HelpdeskClient());
createApp({ store }).listen(port, "0.0.0.0", () => {
  console.log(`listening on http://0.0.0.0:${port}`);
});

// Load in the background so /health answers immediately; /ready flips when done.
// If the first load fails, retry instead of leaving the app stuck.
async function load() {
  try {
    await store.start();
  } catch (err) {
    console.error(`initial load failed: ${err.message}; retrying in 5s`);
    setTimeout(load, 5000);
  }
}
load();
