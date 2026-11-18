/**
 * Flow Sidecar Orchestrator - Alembic Bridge (`bridge/alembic-bridge.js`)
 *
 * Content script injected into Alembic Generative Studio pages (see manifest `content_scripts`).
 * It lets the page drive Google Flow through this extension with `window.postMessage`:
 *
 *   page → bridge:  { __flowSidecar: "request", id, action, params }
 *   bridge → page:  { __flowSidecar: "response", id, ok, result?, error?, code? }
 *                   { __flowSidecar: "event", id, event: "progress", stage, detail? }
 *                   { __flowSidecar: "ready", protocol, version }   (on load)
 *
 * Each request is forwarded to the service worker over its own long-lived port, which keeps the
 * worker alive while Flow generates (up to a few minutes). The bridge only answers messages from
 * this same window; whether Alembic may control Flow at all is decided in the side panel
 * ("Allow Alembic to control Flow"), enforced in the service worker.
 */

(function initAlembicBridge() {
  if (window.__FLOW_SIDECAR_BRIDGE__) return;
  window.__FLOW_SIDECAR_BRIDGE__ = true;

  const PROTOCOL = 1;
  const VERSION = chrome.runtime.getManifest().version;
  const KEEPALIVE_MS = 20000;

  function post(message) {
    window.postMessage({ __flowSidecar: message.kind, ...message.body }, window.location.origin);
  }

  function respond(id, payload) {
    post({ kind: "response", body: { id, ...payload } });
  }

  function extensionAlive() {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || data.__flowSidecar !== "request" || typeof data.id !== "string" || typeof data.action !== "string") {
      return;
    }

    const { id, action } = data;
    const params = data.params && typeof data.params === "object" ? data.params : {};

    if (!extensionAlive()) {
      respond(id, {
        ok: false,
        code: "EXTENSION_RELOADED",
        error: "Flow Sidecar was updated or reloaded. Refresh this page to reconnect."
      });
      return;
    }

    let port;
    try {
      port = chrome.runtime.connect({ name: "flow-sidecar-bridge" });
    } catch (err) {
      respond(id, { ok: false, code: "EXTENSION_UNAVAILABLE", error: String(err && err.message ? err.message : err) });
      return;
    }

    let settled = false;
    // Port messages keep the service worker alive during long generations
    const keepAlive = setInterval(() => {
      try {
        port.postMessage({ type: "keepalive" });
      } catch (_) {
        // port closed
      }
    }, KEEPALIVE_MS);

    const finish = () => {
      settled = true;
      clearInterval(keepAlive);
      try {
        port.disconnect();
      } catch (_) {
        // already closed
      }
    };

    port.onMessage.addListener((msg) => {
      if (!msg || msg.id !== id) return;
      if (msg.type === "event") {
        post({ kind: "event", body: { id, event: msg.event, stage: msg.stage, detail: msg.detail } });
        return;
      }
      if (msg.type === "response") {
        respond(id, { ok: msg.ok, result: msg.result, error: msg.error, code: msg.code });
        finish();
      }
    });

    port.onDisconnect.addListener(() => {
      if (settled) return;
      clearInterval(keepAlive);
      respond(id, {
        ok: false,
        code: "DISCONNECTED",
        error: "Lost the connection to Flow Sidecar (was the extension reloaded?). Refresh this page and try again."
      });
      settled = true;
    });

    port.postMessage({ type: "request", id, action, params, origin: window.location.origin });
  });

  // Let the page know the bridge is present (it can also send action "hello" at any time)
  post({ kind: "ready", body: { protocol: PROTOCOL, version: VERSION } });
})();
