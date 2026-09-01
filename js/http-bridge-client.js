/*
 * HTTP bridge client — connects the live studio to the companion Node server
 * (server/http-api.mjs) so external LLMs can call the WebMCP tools over a public
 * HTTP API. The tab long-polls the server, executes one job at a time through
 * the same window.webMCPStudio bridge the local in-page agent uses, and posts
 * the result back. All relative URLs — no localhost assumptions — so it works
 * unchanged behind the hosted preview proxy.
 */
(() => {
  const CLIENT_ID = `tab-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
  const POLL_TIMEOUT_SENTINEL = 204;
  let callsExecuted = 0;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function setBadge(state) {
    const footer = document.querySelector('.app-footer');
    if (!footer) return;
    let badge = document.getElementById('http-bridge-status');
    if (!badge) {
      badge = document.createElement('span');
      badge.id = 'http-bridge-status';
      footer.append(badge);
    }
    const dot = state === 'live' ? '●' : '◦';
    const label =
      state === 'live'
        ? `HTTP API ${dot} live · ${callsExecuted} call${callsExecuted === 1 ? '' : 's'}`
        : state === 'execution-error'
          ? `HTTP API ◇ job failed · retrying`
          : `HTTP API ${dot} listening…`;
    badge.textContent = label;
    badge.title = 'This studio tab is reachable by external LLMs over the /api/webmcp HTTP bridge (see server/http-api.mjs).';
  }

  async function waitForLocalBridge() {
    for (let attempt = 0; attempt < 240; attempt += 1) {
      if (window.webMCPStudio && typeof window.webMCPStudio.callTool === 'function') return true;
      await sleep(250);
    }
    return false;
  }

  async function executeJob(job) {
    try {
      let result;
      if (job.tool === '__describe_tools') {
        result = typeof window.webMCPStudio.describeTools === 'function'
          ? window.webMCPStudio.describeTools()
          : window.webMCPStudio.listTools();
      } else {
        result = await window.webMCPStudio.callTool(job.tool, job.arguments || {});
      }
      callsExecuted += 1;
      setBadge('live');
      await postResult({ id: job.id, ok: true, result: result === undefined ? { success: true } : result });
    } catch (error) {
      setBadge('execution-error');
      await postResult({ id: job.id, ok: false, error: error?.message || String(error) });
    }
  }

  async function postResult(payload) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await fetch('/api/bridge/result', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        return;
      } catch {
        await sleep(1000 * (attempt + 1));
      }
    }
  }

  async function pollLoop() {
    for (;;) {
      let job = null;
      try {
        const response = await fetch(`/api/bridge/poll?client=${encodeURIComponent(CLIENT_ID)}`, { cache: 'no-store' });
        if (response.status === 200) job = await response.json();
        else if (response.status !== POLL_TIMEOUT_SENTINEL) await sleep(1500);
      } catch {
        // Server restarting or offline (e.g. static-only hosting) — back off quietly.
        await sleep(3000);
        continue;
      }
      if (job && job.id) await executeJob(job);
    }
  }

  async function start() {
    const ready = await waitForLocalBridge();
    if (!ready) return; // Studio never initialised — leave the panel-only app untouched.
    setBadge('listening');
    await pollLoop();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
