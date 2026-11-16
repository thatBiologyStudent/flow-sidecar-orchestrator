/**
 * Flow Sidecar Orchestrator - Background Service Worker (Manifest V3)
 * Manages the side panel lifecycle, content script injection, and image downloads.
 */

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
});

chrome.runtime.onStartup.addListener(() => {
  initSidePanelBehavior();
});

// Initialize immediately on worker evaluation as well
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
