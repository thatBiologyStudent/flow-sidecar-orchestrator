/**
 * Flow Sidecar Orchestrator - Background Service Worker (Manifest V3)
 * Manages the side panel lifecycle, content script injection, and image downloads.
 */

import "../update-check.js";

// Configure side panel to open automatically when the extension toolbar icon is clicked
function initSidePanelBehavior() {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch((err) => console.error("[FlowSidecar SW] Failed to set panel behavior:", err));
  }
}

chrome.runtime.onInstalled.addListener(() => {
  initSidePanelBehavior();
  globalThis.ExtensionUpdate?.updateBadge(true);
});

chrome.runtime.onStartup.addListener(() => {
  initSidePanelBehavior();
  globalThis.ExtensionUpdate?.updateBadge(true);
});

// Initialize immediately on worker evaluation as well (the update check is cached for 12 h)
globalThis.ExtensionUpdate?.updateBadge(false);
initSidePanelBehavior();

/**
 * Sanitizes a user-provided subfolder string so it forms a valid relative path
 * inside Chrome's default Downloads directory.
 * @param {string} rawSubfolder
 * @returns {string}
 */
function sanitizeSubfolder(rawSubfolder) {
  if (!rawSubfolder || typeof rawSubfolder !== "string") {
    return "";
  }
  return rawSubfolder
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) =>
      segment
        .trim()
        .replace(/[<>:"|?*\x00-\x1F]/g, "_")
        .replace(/^\.+|\.+$/g, "")
    )
    .filter(Boolean)
    .join("/");
}

/**
 * Formats a timestamp string for downloaded image filenames.
 * @param {number} [epochMs]
 * @returns {string}
 */
function formatTimestamp(epochMs = Date.now()) {
  const d = new Date(epochMs);
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_${pad(d.getMilliseconds(), 3)}`
  );
}

/**
 * Downloads a generated image into `${targetFolder}/flow_${timestamp}.png`.
 * @param {object} payload
 * @param {string} payload.imageDataUrl
 * @param {string} [payload.subfolder]
 * @param {number} [payload.timestamp]
 * @returns {Promise<{downloadId: number, filename: string}>}
 */
async function handleImageDownload({ imageDataUrl, subfolder, timestamp, saveAs }) {
  if (!imageDataUrl || typeof imageDataUrl !== "string") {
    throw new Error("Missing or invalid imageDataUrl for download.");
  }

  const targetFolder = sanitizeSubfolder(subfolder);
  const ts = formatTimestamp(timestamp || Date.now());
  const ext = /^data:image\/jpeg/i.test(imageDataUrl) ? "jpg" : "png";
  const filename = targetFolder ? `${targetFolder}/flow_${ts}.${ext}` : `flow_${ts}.${ext}`;

  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url: imageDataUrl,
        filename,
        conflictAction: "uniquify",
        saveAs: Boolean(saveAs)
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (typeof downloadId !== "number") {
          reject(new Error("chrome.downloads.download did not return a valid downloadId."));
          return;
        }
        resolve({ downloadId, filename });
      }
    );
  });
}

/**
 * Routing for downloads that Flow itself starts (its native Download button), which would
 * otherwise land in the root of the Downloads folder. Stored in `chrome.storage.session` so it
 * survives service-worker restarts; it expires so manual downloads later are left alone.
 */
const FLOW_DOWNLOAD_ROUTE_KEY = "flowDownloadRoute";
const FLOW_DOWNLOAD_ROUTE_TTL_MS = 10 * 60 * 1000;

/**
 * @param {{subfolder?: string, useDirectFolder?: boolean}} route
 */
async function setFlowDownloadRoute(route) {
  await chrome.storage.session.set({
    [FLOW_DOWNLOAD_ROUTE_KEY]: {
      subfolder: sanitizeSubfolder(route.subfolder || ""),
      useDirectFolder: Boolean(route.useDirectFolder),
      until: Date.now() + FLOW_DOWNLOAD_ROUTE_TTL_MS
    }
  });
}

/** @param {chrome.downloads.DownloadItem} item */
function isFlowPageDownload(item) {
  if (item.byExtensionId) return false; // our own chrome.downloads.download calls already set a path
  const flowRe = /:\/\/([^/]+\.)?(flow\.google\.com|labs\.google)(\/|$)/i;
  return flowRe.test(item.referrer || "") || flowRe.test(item.url || "") || flowRe.test(item.finalUrl || "");
}

/**
 * Asks the side panel to write the file into the folder picked with Choose Folder.
 * @returns {Promise<boolean>} true if it was saved there
 */
async function saveDownloadViaSidePanel(item) {
  try {
    const res = await chrome.runtime.sendMessage({
      type: "SAVE_FLOW_DOWNLOAD_TO_FOLDER",
      url: item.finalUrl || item.url,
      filename: item.filename
    });
    return Boolean(res && res.ok);
  } catch (_) {
    return false; // side panel closed
  }
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (!isFlowPageDownload(item)) {
    return false;
  }

  (async () => {
    const stored = await chrome.storage.session.get(FLOW_DOWNLOAD_ROUTE_KEY);
    const route = stored[FLOW_DOWNLOAD_ROUTE_KEY];
    if (!route || Date.now() > route.until) {
      suggest();
      return;
    }

    if (route.useDirectFolder && (await saveDownloadViaSidePanel(item))) {
      // Written into the picked folder; drop the duplicate browser download.
      suggest();
      try {
        await chrome.downloads.cancel(item.id);
        await chrome.downloads.erase({ id: item.id });
      } catch (_) {
        // Ignore if it already finished or was removed
      }
      return;
    }

    const baseName = (item.filename || "flow_image.jpg").split(/[\\/]/).pop();
    if (route.subfolder) {
      suggest({ filename: `${route.subfolder}/${baseName}`, conflictAction: "uniquify" });
    } else {
      suggest();
    }
  })().catch(() => suggest());

  return true; // suggest() is called asynchronously
});

/**
 * Checks whether a tab URL belongs to Google Flow (`flow.google.com` or `labs.google`).
 * @param {string} [url]
 * @returns {boolean}
 */
function isFlowTabUrl(url) {
  if (!url || typeof url !== "string") return false;
  return /:\/\/([^/]+\.)?(flow\.google\.com|labs\.google)\//i.test(url);
}

/**
 * Finds the active or most recently active Google Flow tab (`flow.google.com` or `labs.google`)
 * and ensures the content scripts are injected and responsive.
 * @param {number} [preferredTabId]
 * @returns {Promise<number>} The target tab ID
 */
async function ensureFlowTabReady(preferredTabId) {
  let targetTab = null;

  if (typeof preferredTabId === "number") {
    try {
      const tab = await chrome.tabs.get(preferredTabId);
      if (tab && isFlowTabUrl(tab.url)) {
        targetTab = tab;
      }
    } catch (_) {
      // Fall through to query
    }
  }

  if (!targetTab) {
    // Check active tab in current window first
    const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
    targetTab = activeTabs.find((t) => isFlowTabUrl(t.url)) || null;
  }

  if (!targetTab) {
    // Fall back to any open flow.google.com or labs.google tab across all windows
    const flowTabs = await chrome.tabs.query({
      url: [
        "*://flow.google.com/*",
        "*://*.flow.google.com/*",
        "*://labs.google/*",
        "*://*.labs.google/*"
      ]
    });
    targetTab = flowTabs[0] || null;
  }

  if (!targetTab || typeof targetTab.id !== "number") {
    throw new Error(
      "No open Google Flow tab (flow.google.com or labs.google) found. Please keep Google Flow open in a browser tab."
    );
  }

  // Ping content script to check if already injected
  try {
    const pingResponse = await chrome.tabs.sendMessage(targetTab.id, { type: "PING_CONTENT" });
    if (pingResponse && pingResponse.ok) {
      return targetTab.id;
    }
  } catch (_) {
    // Content script not yet loaded in this tab; inject programmatically
  }

  await chrome.scripting.executeScript({
    target: { tabId: targetTab.id },
    files: ["content/dom-selectors.js", "content/dom-actions.js", "content/content.js"]
  });

  return targetTab.id;
}

/**
 * Tabs the debugger is currently attached to. The debugger stays attached between prompts:
 * attaching shows Chrome's "started debugging this browser" infobar, which resizes the page
 * viewport. Re-attaching for every click made the layout shift *after* the content script had
 * measured the button, so the click landed at stale coordinates. Keeping it attached means the
 * layout shifts once, and the content script re-measures after `DEBUGGER_PREPARE`.
 * @type {Set<number>}
 */
const debuggerAttachedTabs = new Set();

chrome.debugger.onDetach.addListener((source) => {
  if (typeof source.tabId === "number") {
    debuggerAttachedTabs.delete(source.tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  debuggerAttachedTabs.delete(tabId);
});

/**
 * Attaches the debugger to `tabId` if not already attached.
 * @param {number} tabId
 * @returns {Promise<{ok: boolean, newlyAttached: boolean}>}
 */
async function ensureDebuggerAttached(tabId) {
  if (debuggerAttachedTabs.has(tabId)) {
    return { ok: true, newlyAttached: false };
  }
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    debuggerAttachedTabs.add(tabId);
    return { ok: true, newlyAttached: true };
  } catch (error) {
    // The service worker may have restarted and lost its in-memory set while still attached.
    if (/already attached/i.test(error?.message || "")) {
      debuggerAttachedTabs.add(tabId);
      return { ok: true, newlyAttached: false };
    }
    throw error;
  }
}

/**
 * Detaches the debugger from `tabId` (removes Chrome's debugging infobar).
 * @param {number} tabId
 */
async function releaseDebugger(tabId) {
  debuggerAttachedTabs.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch (_) {
    // Ignore if already detached
  }
}

/**
 * Dispatches a native browser-level trusted mouse click (`isTrusted: true`) at `(x, y)`
 * in the target tab using `chrome.debugger` (`Input.dispatchMouseEvent`).
 * @param {number} tabId
 * @param {number} x
 * @param {number} y
 * @returns {Promise<{ok: boolean}>}
 */
async function dispatchTrustedClick(tabId, x, y) {
  await ensureDebuggerAttached(tabId);
  const target = { tabId };
  await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
    clickCount: 0
  });
  await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1
  });
  await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    buttons: 0,
    clickCount: 1
  });
  return { ok: true };
}

/**
 * Dispatches a trusted Enter key press to whatever element is focused in the tab.
 * @param {number} tabId
 * @returns {Promise<{ok: boolean}>}
 */
async function dispatchTrustedEnter(tabId) {
  await ensureDebuggerAttached(tabId);
  const target = { tabId };
  const base = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    ...base
  });
  await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
    type: "char",
    text: "\r",
    ...base
  });
  await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return false;
  }

  if (message.type === "PING_BACKGROUND") {
    sendResponse({ ok: true, timestamp: Date.now() });
    return false;
  }

  if (message.type === "DOWNLOAD_IMAGE") {
    handleImageDownload(message.payload || {})
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true; // Async response
  }

  if (message.type === "ENSURE_FLOW_TAB") {
    ensureFlowTabReady(message.tabId)
      .then((tabId) => sendResponse({ ok: true, tabId }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message.type === "DISPATCH_TO_FLOW_TAB") {
    (async () => {
      if (message.payload?.downloadRoute) {
        await setFlowDownloadRoute(message.payload.downloadRoute);
      }
      const tabId = await ensureFlowTabReady(message.tabId);
      const response = await chrome.tabs.sendMessage(tabId, message.payload);
      return { tabId, response };
    })()
      .then(({ tabId, response }) => sendResponse({ ok: true, tabId, response }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (
    message.type === "DEBUGGER_PREPARE" ||
    message.type === "DEBUGGER_RELEASE" ||
    message.type === "TRUSTED_ENTER"
  ) {
    const tabId = sender?.tab?.id ?? message.tabId;
    if (typeof tabId !== "number") {
      sendResponse({ ok: false, error: `Invalid tabId for ${message.type}.` });
      return false;
    }
    const action =
      message.type === "DEBUGGER_PREPARE"
        ? ensureDebuggerAttached(tabId)
        : message.type === "DEBUGGER_RELEASE"
          ? releaseDebugger(tabId).then(() => ({ ok: true }))
          : dispatchTrustedEnter(tabId);
    action
      .then((res) => sendResponse(res))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message.type === "TRUSTED_CLICK") {
    const tabId = sender?.tab?.id ?? message.tabId;
    const x = Number(message.x);
    const y = Number(message.y);
    if (typeof tabId !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
      sendResponse({ ok: false, error: "Invalid tabId or coordinates for TRUSTED_CLICK." });
      return false;
    }
    dispatchTrustedClick(tabId, x, y)
      .then((res) => sendResponse(res))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  return false;
});

/* ==========================================================================
   Alembic bridge
   Lets Alembic Generative Studio (a separate web app) drive Google Flow through
   this extension. The page talks to `bridge/alembic-bridge.js`, which opens a
   port named "flow-sidecar-bridge" per request. Off until the user ticks
   "Allow Alembic to control Flow" in the side panel.
   Protocol documentation: ALEMBIC_INTEGRATION.md in the repository root.
   ========================================================================== */

const BRIDGE_PROTOCOL = 1;
const BRIDGE_SETTINGS_KEY = "flow_sidecar_bridge_v1";
const SIDEPANEL_CONFIG_KEY = "flow_sidecar_config_v1";
const BRIDGE_FLOW_MODELS = ["Nano Banana 2.1", "Nano Banana Pro", "Nano Banana 2 Lite"];
const BRIDGE_ASPECT_RATIOS = ["16:9", "4:3", "1:1", "3:4", "9:16"];
const BRIDGE_MAX_REFERENCES = 8;

/** One Flow generation at a time across all Alembic tabs */
let bridgeBusy = false;

class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function getBridgeSettings() {
  const stored = await chrome.storage.local.get(BRIDGE_SETTINGS_KEY);
  const s = stored[BRIDGE_SETTINGS_KEY] || {};
  return { enabled: Boolean(s.enabled) };
}

/** Tells the side panel (if open) what Alembic is doing. */
function notifyBridgeActivity(text, level = "info") {
  chrome.runtime.sendMessage({ type: "BRIDGE_ACTIVITY", text, level }).catch(() => {});
}

/** Finds a Flow tab, preferring one that has a project open. */
async function findFlowTabInfo() {
  const tabs = await chrome.tabs.query({
    url: ["*://flow.google.com/*", "*://*.flow.google.com/*", "*://labs.google/*", "*://*.labs.google/*"]
  });
  const withProject = tabs.find((t) => /\/project\//.test(t.url || ""));
  const tab = withProject || tabs[0] || null;
  return tab
    ? { open: true, tabId: tab.id, url: tab.url || "", hasProject: Boolean(withProject), title: tab.title || "" }
    : { open: false, tabId: null, url: "", hasProject: false, title: "" };
}

async function sendToFlowContent(tabInfo, message) {
  const tabId = await ensureFlowTabReady(tabInfo.tabId);
  const response = await chrome.tabs.sendMessage(tabId, message);
  if (!response || !response.ok) {
    throw new BridgeError("FLOW_ERROR", response?.error || "Flow did not respond.");
  }
  return response;
}

function normalizeBridgeAspect(value) {
  const v = String(value || "").replace(/\s+/g, "");
  return BRIDGE_ASPECT_RATIOS.includes(v) ? v : null;
}

function normalizeBridgeModel(value) {
  const v = String(value || "").trim().toLowerCase();
  return BRIDGE_FLOW_MODELS.find((m) => m.toLowerCase() === v) || null;
}

/**
 * Validates and sanitises reference images from the page.
 * @returns {Array<{dataUrl?: string, assetId?: string, name: string}>}
 */
function normalizeBridgeReferences(refs) {
  if (!Array.isArray(refs)) return [];
  if (refs.length > BRIDGE_MAX_REFERENCES) {
    throw new BridgeError("BAD_REQUEST", `At most ${BRIDGE_MAX_REFERENCES} reference images are supported.`);
  }
  return refs.map((r, i) => {
    const name =
      typeof r?.name === "string" && r.name.trim() ? r.name.trim().slice(0, 80) : `Alembic reference ${i + 1}`;
    const hasDataUrl = typeof r?.dataUrl === "string" && /^data:image\/(png|jpe?g|webp|gif);base64,/i.test(r.dataUrl);
    if (typeof r?.assetId === "string" && /^[A-Za-z0-9_-]+$/.test(r.assetId)) {
      // A Flow image: picked from the project; the data URL (if given) is only an upload fallback
      return { assetId: r.assetId, name, ...(hasDataUrl ? { dataUrl: r.dataUrl } : {}) };
    }
    if (hasDataUrl) {
      return { dataUrl: r.dataUrl, name };
    }
    throw new BridgeError("BAD_REQUEST", `Reference ${i + 1} needs a base64 image data URL or a Flow assetId.`);
  });
}

/**
 * Handles one bridge action.
 * @param {string} action
 * @param {object} params
 * @param {(stage: string, detail?: any) => void} progress
 */
async function handleBridgeAction(action, params, progress) {
  const settings = await getBridgeSettings();

  if (action === "hello" || action === "status") {
    const flow = await findFlowTabInfo();
    return {
      protocol: BRIDGE_PROTOCOL,
      version: chrome.runtime.getManifest().version,
      enabled: settings.enabled,
      busy: bridgeBusy,
      flow: { open: flow.open, hasProject: flow.hasProject, url: flow.url, title: flow.title },
      capabilities: {
        models: BRIDGE_FLOW_MODELS,
        defaultModel: BRIDGE_FLOW_MODELS[0],
        aspectRatios: BRIDGE_ASPECT_RATIOS,
        maxImagesPerRequest: 4,
        maxReferences: BRIDGE_MAX_REFERENCES,
        img2img: true,
        inpaint: false,
        negativePrompt: false,
        seed: false,
        outputResolution: "1k"
      }
    };
  }

  if (!settings.enabled) {
    throw new BridgeError(
      "DISABLED",
      'Flow Sidecar is not allowing Alembic to control Flow. Open the Flow Sidecar side panel and tick "Allow Alembic to control Flow".'
    );
  }

  const flow = await findFlowTabInfo();
  if (!flow.open) {
    throw new BridgeError("NO_FLOW_TAB", "No Google Flow tab is open. Open https://flow.google.com and a project.");
  }
  if (!flow.hasProject) {
    throw new BridgeError("NO_FLOW_PROJECT", "Google Flow is open but no project is. Open a project in the Flow tab.");
  }

  if (action === "listImages") {
    const limit = Math.max(1, Math.min(200, Math.round(Number(params.limit) || 80)));
    const res = await sendToFlowContent(flow, { type: "LIST_FLOW_IMAGES", payload: { limit } });
    return {
      images: (res.images || []).map((i) => ({ assetId: i.assetId, name: i.name, thumbDataUrl: i.thumbDataUrl }))
    };
  }

  if (action === "getImage") {
    if (typeof params.assetId !== "string" || !/^[A-Za-z0-9_-]+$/.test(params.assetId)) {
      throw new BridgeError("BAD_REQUEST", "getImage needs an assetId.");
    }
    const size = Number.isFinite(Number(params.size)) ? Math.max(0, Math.round(Number(params.size))) : 0;
    const res = await sendToFlowContent(flow, {
      type: "FETCH_FLOW_IMAGE",
      payload: { assetId: params.assetId, size }
    });
    return { assetId: params.assetId, dataUrl: res.dataUrl };
  }

  if (action === "generate") {
    const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
    if (!prompt) throw new BridgeError("BAD_REQUEST", "generate needs a prompt.");
    if (prompt.length > 8000) throw new BridgeError("BAD_REQUEST", "The prompt is too long (max 8000 characters).");
    const aspectRatio = params.aspectRatio == null ? null : normalizeBridgeAspect(params.aspectRatio);
    if (params.aspectRatio != null && !aspectRatio) {
      throw new BridgeError("BAD_REQUEST", `aspectRatio must be one of ${BRIDGE_ASPECT_RATIOS.join(", ")}.`);
    }
    const model = params.model == null ? null : normalizeBridgeModel(params.model);
    if (params.model != null && !model) {
      throw new BridgeError("BAD_REQUEST", `model must be one of ${BRIDGE_FLOW_MODELS.join(", ")}.`);
    }
    const count = Math.max(1, Math.min(4, Math.round(Number(params.count) || 1)));
    const references = normalizeBridgeReferences(params.references);
    const download = Boolean(params.download);

    if (bridgeBusy) {
      throw new BridgeError("BUSY", "Flow is already generating for Alembic. Wait for it to finish.");
    }
    bridgeBusy = true;
    try {
      const stored = await chrome.storage.local.get(SIDEPANEL_CONFIG_KEY);
      const cfg = stored[SIDEPANEL_CONFIG_KEY] || {};
      const useRatio = aspectRatio || cfg.aspectRatio || "1:1";
      const useModel = model || cfg.targetFlowModel || BRIDGE_FLOW_MODELS[0];
      if (download) {
        await setFlowDownloadRoute({ subfolder: cfg.downloadSubfolder || "", useDirectFolder: false });
      }

      notifyBridgeActivity(
        `Alembic → Flow: ${count}× ${useRatio} · ${useModel}` +
          `${references.length ? ` · ${references.length} reference(s)` : ""}: "${prompt.slice(0, 80)}${prompt.length > 80 ? "…" : ""}"`
      );
      progress("submitting", { count, references: references.length });

      const tabId = await ensureFlowTabReady(flow.tabId);
      const response = await chrome.tabs.sendMessage(tabId, {
        type: "EXECUTE_FLOW_PROMPT",
        payload: {
          prompt,
          aspectRatio: useRatio,
          targetModel: useModel,
          imagesPerPrompt: count,
          references,
          skipFlowDownload: !download,
          upscaleDownload: download && Boolean(cfg.upscaleDownload)
        }
      });
      if (!response || !response.ok) {
        const msg = response?.error || "Flow did not return any image.";
        throw new BridgeError(/already running/i.test(msg) ? "BUSY" : "FLOW_ERROR", msg);
      }

      const urls = Array.isArray(response.imageDataUrls) ? response.imageDataUrls : [];
      const ids = Array.isArray(response.assetIds) ? response.assetIds : [];
      notifyBridgeActivity(`Alembic ← Flow: ${urls.length} image(s) returned.`);
      return {
        images: urls.map((dataUrl, i) => ({ dataUrl, assetId: ids[i] || null })),
        model: useModel,
        aspectRatio: useRatio,
        downloaded: Boolean(response.downloadedViaFlow)
      };
    } finally {
      bridgeBusy = false;
    }
  }

  throw new BridgeError("UNKNOWN_ACTION", `Unknown action "${action}".`);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "flow-sidecar-bridge") return;
  // Only our own bridge content script (running in an Alembic tab) may connect
  if (!port.sender || port.sender.id !== chrome.runtime.id || !port.sender.tab) {
    port.disconnect();
    return;
  }

  let closed = false;
  port.onDisconnect.addListener(() => {
    closed = true;
  });
  const send = (msg) => {
    if (closed) return;
    try {
      port.postMessage(msg);
    } catch (_) {
      closed = true;
    }
  };

  port.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "request" || typeof msg.id !== "string") return; // keepalive pings
    const { id, action } = msg;
    const params = msg.params && typeof msg.params === "object" ? msg.params : {};
    handleBridgeAction(action, params, (stage, detail) => send({ type: "event", id, event: "progress", stage, detail }))
      .then((result) => send({ type: "response", id, ok: true, result }))
      .catch((err) => {
        const code = err instanceof BridgeError ? err.code : "INTERNAL";
        if (action === "generate") notifyBridgeActivity(`Alembic request failed: ${err.message || String(err)}`, "error");
        send({ type: "response", id, ok: false, code, error: err.message || String(err) });
      });
  });
});
