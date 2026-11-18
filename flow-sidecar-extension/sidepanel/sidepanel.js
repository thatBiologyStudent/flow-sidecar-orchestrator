/**
 * Flow Sidecar Orchestrator - Side Panel Controller
 * Coordinates zero-default settings persistence in `chrome.storage.local`,
 * multimodal chat & batch prompt generation, execution queue state machine,
 * Flow content-script automation, and closed-loop vision critique.
 */

import {
  downscaleImage,
  saveDirectoryHandleToIdb,
  loadDirectoryHandleFromIdb,
  clearDirectoryHandleFromIdb,
  writeImageToDirectoryHandle
} from "./image-utils.js";
import {
  ConfigValidationError,
  DEFAULT_SYSTEM_PROMPT,
  ALLOWED_ASPECT_RATIOS,
  GOOGLE_FLOW_IMAGE_MODELS,
  normalizeAspectRatioOverride,
  normalizeFlowModelOverride,
  normalizeImagesPerPromptOverride,
  validateRequiredConfig,
  fetchAvailableModels,
  sendMultimodalChat,
  generateBatchPrompts,
  critiqueGeneratedImageWithVision
} from "./api-client.js";

const STORAGE_KEY = "flow_sidecar_config_v1";

/**
 * Strict Zero-Fallback initial state for Base URL, API Key, Model Name, and System Prompt.
 */
const state = {
  config: {
    baseUrl: "",
    apiKey: "",
    modelName: "",
    systemPrompt: "",
    aspectRatio: "1:1",
    targetFlowModel: "Nano Banana 2.1",
    imagesPerPrompt: 1,
    allowAiOverrides: true,
    img2imgDataUrl: "",
    img2imgName: "",
    downloadSubfolder: "",
    saveAsDialog: false,
    upscaleDownload: false,
    useRefsInFlow: true,
    pacingDelay: 2
  },
  directoryHandle: null, // FileSystemDirectoryHandle chosen via Windows Explorer
  fetchedModels: [], // Cached list of model IDs fetched from aggregator `/models`
  chatHistory: [],
  chatAttachments: [], // Array of { id, name, dataUrl, width, height }
  queue: [], // Array of { id, prompt, aspectRatio, targetFlowModel, isOverridden, status, resultDataUrl, error }
  runnerState: "Idle", // 'Idle' | 'Running' | 'Paused' | 'Cooldown'
  isLoopActive: false
};

// DOM References
const dom = {
  toggleSettingsBtn: document.getElementById("toggleSettingsBtn"),
  settingsChevron: document.getElementById("settingsChevron"),
  settingsDrawer: document.getElementById("settingsDrawer"),
  settingsForm: document.getElementById("settingsForm"),
  saveStatusBadge: document.getElementById("saveStatusBadge"),

  validationBanner: document.getElementById("validationBanner"),
  validationBannerText: document.getElementById("validationBannerText"),
  dismissBannerBtn: document.getElementById("dismissBannerBtn"),

  baseUrlInput: document.getElementById("baseUrlInput"),
  apiKeyInput: document.getElementById("apiKeyInput"),
  modelNameInput: document.getElementById("modelNameInput"),
  fetchModelsBtn: document.getElementById("fetchModelsBtn"),
  fetchedModelsDatalist: document.getElementById("fetchedModelsDatalist"),
  fetchedModelsSelect: document.getElementById("fetchedModelsSelect"),
  fetchModelsStatus: document.getElementById("fetchModelsStatus"),
  systemPromptInput: document.getElementById("systemPromptInput"),
  fillDefaultPromptBtn: document.getElementById("fillDefaultPromptBtn"),
  aspectRatioSelect: document.getElementById("aspectRatioSelect"),
  targetFlowModelSelect: document.getElementById("targetFlowModelSelect"),
  imagesPerPromptSelect: document.getElementById("imagesPerPromptSelect"),
  allowAiOverridesCheckbox: document.getElementById("allowAiOverridesCheckbox"),
  img2imgFileInput: document.getElementById("img2imgFileInput"),
  clearImg2ImgBtn: document.getElementById("clearImg2ImgBtn"),
  img2imgPreviewContainer: document.getElementById("img2imgPreviewContainer"),
  img2imgPreviewThumb: document.getElementById("img2imgPreviewThumb"),
  img2imgMetaText: document.getElementById("img2imgMetaText"),
  pickFolderBtn: document.getElementById("pickFolderBtn"),
  clearFolderBtn: document.getElementById("clearFolderBtn"),
  pickedFolderBadge: document.getElementById("pickedFolderBadge"),
  pickedFolderNameText: document.getElementById("pickedFolderNameText"),
  downloadSubfolderInput: document.getElementById("downloadSubfolderInput"),
  saveAsDialogCheckbox: document.getElementById("saveAsDialogCheckbox"),
  upscaleDownloadCheckbox: document.getElementById("upscaleDownloadCheckbox"),
  useRefsInFlowCheckbox: document.getElementById("useRefsInFlowCheckbox"),
  alembicBridgeCheckbox: document.getElementById("alembicBridgeCheckbox"),
  pickFromFlowBtn: document.getElementById("pickFromFlowBtn"),
  flowGalleryModal: document.getElementById("flowGalleryModal"),
  flowGalleryGrid: document.getElementById("flowGalleryGrid"),
  flowGalleryStatus: document.getElementById("flowGalleryStatus"),
  closeFlowGalleryBtn: document.getElementById("closeFlowGalleryBtn"),
  refreshFlowGalleryBtn: document.getElementById("refreshFlowGalleryBtn"),
  addFlowGalleryBtn: document.getElementById("addFlowGalleryBtn"),
  braveFsHint: document.getElementById("braveFsHint"),
  pacingDelayInput: document.getElementById("pacingDelayInput"),

  clearChatBtn: document.getElementById("clearChatBtn"),
  chatMessages: document.getElementById("chatMessages"),
  chatAttachmentStrip: document.getElementById("chatAttachmentStrip"),
  chatDropZone: document.getElementById("chatDropZone"),
  chatAttachmentInput: document.getElementById("chatAttachmentInput"),
  chatInputTextarea: document.getElementById("chatInputTextarea"),
  attachImageBtn: document.getElementById("attachImageBtn"),
  sendChatBtn: document.getElementById("sendChatBtn"),
  promptCountSelect: document.getElementById("promptCountSelect"),
  generatePromptsBtn: document.getElementById("generatePromptsBtn"),

  queueCountBadge: document.getElementById("queueCountBadge"),
  runnerStateBadge: document.getElementById("runnerStateBadge"),
  startQueueBtn: document.getElementById("startQueueBtn"),
  pauseQueueBtn: document.getElementById("pauseQueueBtn"),
  clearQueueBtn: document.getElementById("clearQueueBtn"),
  queueTableBody: document.getElementById("queueTableBody"),

  imageModal: document.getElementById("imageModal"),
  modalTitle: document.getElementById("modalTitle"),
  modalImage: document.getElementById("modalImage"),
  modalPromptText: document.getElementById("modalPromptText"),
  closeModalBtn: document.getElementById("closeModalBtn")
};

/* ==========================================================================
   1. Configuration Persistence (Zero Defaults) & Validation Gate
   ========================================================================== */

/**
 * Reads current form inputs into `state.config` without substituting any fallbacks
 * for `baseUrl`, `apiKey`, `modelName`, or `systemPrompt`.
 */
function syncFormToState() {
  state.config.baseUrl = dom.baseUrlInput.value;
  state.config.apiKey = dom.apiKeyInput.value;
  state.config.modelName = dom.modelNameInput.value;
  state.config.systemPrompt = dom.systemPromptInput.value;
  state.config.aspectRatio = dom.aspectRatioSelect.value || "1:1";
  state.config.targetFlowModel = dom.targetFlowModelSelect.value || "Nano Banana 2.1";
  state.config.imagesPerPrompt =
    normalizeImagesPerPromptOverride(dom.imagesPerPromptSelect?.value) || 1;
  state.config.allowAiOverrides = Boolean(dom.allowAiOverridesCheckbox.checked);
  state.config.downloadSubfolder = dom.downloadSubfolderInput.value;
  state.config.saveAsDialog = Boolean(dom.saveAsDialogCheckbox?.checked);
  state.config.upscaleDownload = Boolean(dom.upscaleDownloadCheckbox?.checked);

  const parsedDelay = parseFloat(dom.pacingDelayInput.value);
  state.config.pacingDelay = Number.isFinite(parsedDelay) && parsedDelay >= 1 ? parsedDelay : 1;
}

/**
 * Renders `state.config` values into the settings form inputs.
 */
function renderConfigToForm() {
  dom.baseUrlInput.value = state.config.baseUrl ?? "";
  dom.apiKeyInput.value = state.config.apiKey ?? "";
  dom.modelNameInput.value = state.config.modelName ?? "";
  dom.systemPromptInput.value = state.config.systemPrompt ?? "";
  dom.aspectRatioSelect.value = state.config.aspectRatio || "1:1";
  dom.targetFlowModelSelect.value =
    GOOGLE_FLOW_IMAGE_MODELS.includes(state.config.targetFlowModel)
      ? state.config.targetFlowModel
      : "Nano Banana 2.1";
  if (dom.imagesPerPromptSelect) {
    dom.imagesPerPromptSelect.value = String(
      normalizeImagesPerPromptOverride(state.config.imagesPerPrompt) || 1
    );
  }
  dom.allowAiOverridesCheckbox.checked = state.config.allowAiOverrides !== false;
  dom.downloadSubfolderInput.value = state.config.downloadSubfolder ?? "";
  if (dom.saveAsDialogCheckbox) {
    dom.saveAsDialogCheckbox.checked = Boolean(state.config.saveAsDialog);
  }
  if (dom.upscaleDownloadCheckbox) {
    dom.upscaleDownloadCheckbox.checked = Boolean(state.config.upscaleDownload);
  }
  if (dom.useRefsInFlowCheckbox) {
    dom.useRefsInFlowCheckbox.checked = state.config.useRefsInFlow !== false;
  }
  dom.pacingDelayInput.value = String(state.config.pacingDelay ?? 2);

  renderFetchedModelsOptions();
  renderImg2ImgPreview();
  renderPickedFolderState();
}

function renderPickedFolderState() {
  if (state.directoryHandle && state.directoryHandle.name) {
    dom.pickedFolderNameText.textContent = `Explorer Folder: ${state.directoryHandle.name} (Direct Save)`;
    dom.pickedFolderBadge.classList.remove("hidden");
    dom.clearFolderBtn.classList.remove("hidden");
  } else if (state.config.downloadSubfolder && state.config.downloadSubfolder.trim()) {
    dom.pickedFolderNameText.textContent = `Downloads Subfolder: ${state.config.downloadSubfolder.trim()}`;
    dom.pickedFolderBadge.classList.remove("hidden");
    dom.clearFolderBtn.classList.remove("hidden");
  } else {
    dom.pickedFolderNameText.textContent = "";
    dom.pickedFolderBadge.classList.add("hidden");
    dom.clearFolderBtn.classList.add("hidden");
  }

  // Show Brave hint if showDirectoryPicker is disabled in this browser build
  if (dom.braveFsHint) {
    dom.braveFsHint.classList.toggle("hidden", typeof window.showDirectoryPicker === "function");
  }
}

/**
 * Opens the native Windows Explorer folder picker (`window.showDirectoryPicker`) so downloads can be
 * written straight into any folder.
 *
 * Brave disables this API by default. There is no other way for an extension to pick a save folder:
 * `<input webkitdirectory>` is an *upload* dialog (it asks to upload the folder's files and only
 * yields the folder name), so it is deliberately not used. Instead we explain the options.
 */
async function handlePickDownloadFolder() {
  if (typeof window.showDirectoryPicker !== "function") {
    if (dom.braveFsHint) dom.braveFsHint.classList.remove("hidden");
    appendChatMessage(
      "system",
      "This browser blocks extensions from picking a save folder (Brave turns it off by default).\n" +
        "Options:\n" +
        "• Type a folder name in the Download Folder box: images are saved to Downloads/<that name>.\n" +
        "• Or enable brave://flags/#file-system-access-api, restart Brave, and click Choose Folder again to pick any folder.\n" +
        "• Or tick \"Open Explorer Save As dialog\" to choose the location for each download."
    );
    dom.downloadSubfolderInput.focus();
    return;
  }

  try {
    const dirHandle = await window.showDirectoryPicker({
      id: "flow-sidecar-downloads",
      mode: "readwrite",
      startIn: "downloads"
    });
    if (dirHandle) {
      state.directoryHandle = dirHandle;
      dom.downloadSubfolderInput.value = dirHandle.name;
      state.config.downloadSubfolder = dirHandle.name;
      await saveDirectoryHandleToIdb(dirHandle);
      renderPickedFolderState();
      dom.saveStatusBadge.textContent = "Unsaved";
      dom.saveStatusBadge.classList.remove("saved");
    }
  } catch (err) {
    if (err && err.name === "AbortError") {
      return; // User cancelled the Explorer dialog
    }
    appendChatMessage("system", `Could not open the folder picker: ${err.message || String(err)}`);
  }
}

/**
 * Saves one of Flow's own downloads (intercepted by the service worker) into the folder picked
 * with Choose Folder. The service worker cancels the browser download only if this succeeds.
 * @param {{url: string, filename?: string}} payload
 * @returns {Promise<{ok: boolean, savedPath?: string, error?: string}>}
 */
async function saveFlowDownloadToPickedFolder({ url, filename }) {
  if (!state.directoryHandle) {
    return { ok: false, error: "No folder picked." };
  }
  const now = new Date();
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  const ts =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}_${pad(now.getMilliseconds(), 3)}`;
  const extMatch = /\.(jpe?g|png|webp|gif)$/i.exec(filename || "");
  const ext = extMatch ? extMatch[1].toLowerCase() : "jpg";
  try {
    const savedPath = await writeImageToDirectoryHandle(state.directoryHandle, url, `flow_${ts}.${ext}`);
    return { ok: true, savedPath };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

async function handleClearDownloadFolder() {
  state.directoryHandle = null;
  state.config.downloadSubfolder = "";
  dom.downloadSubfolderInput.value = "";
  await clearDirectoryHandleFromIdb();
  renderPickedFolderState();
  dom.saveStatusBadge.textContent = "Unsaved";
  dom.saveStatusBadge.classList.remove("saved");
}

/**
 * Populates both the `<datalist>` autocomplete on `#modelNameInput` and the quick-pick
 * `<select id="fetchedModelsSelect">` dropdown when aggregator models have been fetched.
 */
function renderFetchedModelsOptions() {
  dom.fetchedModelsDatalist.innerHTML = "";
  dom.fetchedModelsSelect.innerHTML = "";

  if (!Array.isArray(state.fetchedModels) || state.fetchedModels.length === 0) {
    dom.fetchedModelsSelect.classList.add("hidden");
    return;
  }

  const placeholderOpt = document.createElement("option");
  placeholderOpt.value = "";
  placeholderOpt.textContent = `-- Pick from ${state.fetchedModels.length} fetched aggregator models --`;
  dom.fetchedModelsSelect.appendChild(placeholderOpt);

  for (const modelId of state.fetchedModels) {
    const dlOption = document.createElement("option");
    dlOption.value = modelId;
    dom.fetchedModelsDatalist.appendChild(dlOption);

    const selOption = document.createElement("option");
    selOption.value = modelId;
    selOption.textContent = modelId;
    if (state.config.modelName === modelId) {
      selOption.selected = true;
    }
    dom.fetchedModelsSelect.appendChild(selOption);
  }

  dom.fetchedModelsSelect.classList.remove("hidden");
}

/**
 * Fetches available models from the aggregator's `/models` endpoint using Base URL & API Key.
 */
async function handleFetchModels() {
  syncFormToState();
  dom.fetchModelsBtn.disabled = true;
  dom.fetchModelsBtn.textContent = "⏳ Fetching...";
  dom.fetchModelsStatus.className = "field-hint";
  dom.fetchModelsStatus.textContent = "Querying /models endpoint...";

  try {
    const models = await fetchAvailableModels({
      baseUrl: state.config.baseUrl,
      apiKey: state.config.apiKey
    });

    state.fetchedModels = models;
    renderFetchedModelsOptions();

    dom.fetchModelsStatus.className = "field-hint hint-ok";
    dom.fetchModelsStatus.textContent = `Loaded ${models.length} model(s). Select from dropdown or type manually above.`;
    hideValidationBanner();
  } catch (err) {
    dom.fetchModelsStatus.className = "field-hint hint-err";
    dom.fetchModelsStatus.textContent = err.message || String(err);
    if (err instanceof ConfigValidationError) {
      showValidationBanner(err.message, err.missingFields);
    }
  } finally {
    dom.fetchModelsBtn.disabled = false;
    dom.fetchModelsBtn.textContent = "🔄 Fetch Models";
  }
}

function renderImg2ImgPreview() {
  if (state.config.img2imgDataUrl) {
    dom.img2imgPreviewThumb.src = state.config.img2imgDataUrl;
    dom.img2imgMetaText.textContent = state.config.img2imgName || "Reference image active";
    dom.img2imgPreviewContainer.classList.remove("hidden");
    dom.clearImg2ImgBtn.disabled = false;
  } else {
    dom.img2imgPreviewThumb.src = "";
    dom.img2imgMetaText.textContent = "";
    dom.img2imgPreviewContainer.classList.add("hidden");
    dom.clearImg2ImgBtn.disabled = true;
    dom.img2imgFileInput.value = "";
  }
}

/**
 * Loads persisted settings from `chrome.storage.local`.
 * Strictly initializes Base URL, API Key, Model Name, and System Prompt to `""` if not stored.
 */
async function loadConfigFromStorage() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY], (result) => {
      const saved = result?.[STORAGE_KEY];
      if (saved && typeof saved === "object") {
        state.config.baseUrl = typeof saved.baseUrl === "string" ? saved.baseUrl : "";
        state.config.apiKey = typeof saved.apiKey === "string" ? saved.apiKey : "";
        state.config.modelName = typeof saved.modelName === "string" ? saved.modelName : "";
        state.config.systemPrompt = typeof saved.systemPrompt === "string" ? saved.systemPrompt : "";
        state.config.aspectRatio = typeof saved.aspectRatio === "string" ? saved.aspectRatio : "1:1";
        state.config.targetFlowModel =
          typeof saved.targetFlowModel === "string" && GOOGLE_FLOW_IMAGE_MODELS.includes(saved.targetFlowModel)
            ? saved.targetFlowModel
            : "Nano Banana 2.1";
        state.config.imagesPerPrompt = normalizeImagesPerPromptOverride(saved.imagesPerPrompt) || 1;
        state.config.allowAiOverrides = saved.allowAiOverrides !== false;
        state.config.img2imgDataUrl = typeof saved.img2imgDataUrl === "string" ? saved.img2imgDataUrl : "";
        state.config.img2imgName = typeof saved.img2imgName === "string" ? saved.img2imgName : "";
        state.config.downloadSubfolder = typeof saved.downloadSubfolder === "string" ? saved.downloadSubfolder : "";
        state.config.saveAsDialog = Boolean(saved.saveAsDialog);
        state.config.upscaleDownload = Boolean(saved.upscaleDownload);
        state.config.useRefsInFlow = saved.useRefsInFlow !== false;
        state.config.pacingDelay =
          typeof saved.pacingDelay === "number" && saved.pacingDelay >= 1 ? saved.pacingDelay : 2;
        state.fetchedModels = Array.isArray(saved.fetchedModels) ? saved.fetchedModels : [];

        dom.saveStatusBadge.textContent = "Loaded";
        dom.saveStatusBadge.classList.add("saved");
      } else {
        // Zero defaults guaranteed
        state.config.baseUrl = "";
        state.config.apiKey = "";
        state.config.modelName = "";
        state.config.systemPrompt = "";
        state.fetchedModels = [];
      }
      renderConfigToForm();
      resolve();
    });
  });
}

/**
 * Saves current configuration exclusively to `chrome.storage.local`.
 */
async function saveConfigToStorage() {
  syncFormToState();
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(
      {
        [STORAGE_KEY]: {
          ...state.config,
          fetchedModels: state.fetchedModels
        }
      },
      () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        dom.saveStatusBadge.textContent = "Saved";
        dom.saveStatusBadge.classList.add("saved");
        resolve();
      }
    );
  });
}

/**
 * Shows the inline validation error banner and highlights any blank required inputs.
 * @param {string} message
 * @param {string[]} [missingFields=[]]
 */
function showValidationBanner(message, missingFields = []) {
  dom.validationBannerText.textContent = message;
  dom.validationBanner.classList.remove("hidden");

  dom.baseUrlInput.classList.toggle("input-invalid", missingFields.includes("Base URL"));
  dom.modelNameInput.classList.toggle("input-invalid", missingFields.includes("Model Name"));
  dom.systemPromptInput.classList.toggle("input-invalid", missingFields.includes("System Prompt"));

  // Expand settings drawer automatically if collapsed so user can fix missing fields
  if (dom.settingsDrawer.classList.contains("hidden")) {
    toggleSettingsDrawer(true);
  }
}

function hideValidationBanner() {
  dom.validationBanner.classList.add("hidden");
  dom.baseUrlInput.classList.remove("input-invalid");
  dom.modelNameInput.classList.remove("input-invalid");
  dom.systemPromptInput.classList.remove("input-invalid");
}

/**
 * Validates that Base URL, Model Name, and System Prompt are filled before any API request.
 * @returns {boolean}
 */
function checkStrictValidationGate() {
  syncFormToState();
  try {
    validateRequiredConfig(state.config);
    hideValidationBanner();
    return true;
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      showValidationBanner(err.message, err.missingFields);
    } else {
      showValidationBanner(err.message || "Invalid configuration.");
    }
    return false;
  }
}

function toggleSettingsDrawer(forceOpen) {
  const isCurrentlyHidden = dom.settingsDrawer.classList.contains("hidden");
  const shouldOpen = typeof forceOpen === "boolean" ? forceOpen : isCurrentlyHidden;

  dom.settingsDrawer.classList.toggle("hidden", !shouldOpen);
  dom.toggleSettingsBtn.setAttribute("aria-expanded", String(shouldOpen));
  dom.settingsChevron.textContent = shouldOpen ? "▾" : "▸";
}

/* ==========================================================================
   2. Vision Chat & Reference Image Attachments
   ========================================================================== */

/**
 * Appends a chat bubble (`user`, `assistant`, or `system`) to the chat log.
 * @param {"user"|"assistant"|"system"} role
 * @param {string} text
 * @param {string[]} [imageDataUrls=[]]
 */
function appendChatMessage(role, text, imageDataUrls = []) {
  const bubble = document.createElement("div");
  bubble.className = `chat-bubble ${role}`;
  bubble.textContent = text;

  if (Array.isArray(imageDataUrls) && imageDataUrls.length > 0) {
    const thumbRow = document.createElement("div");
    thumbRow.className = "chat-bubble-thumbs";
    for (const url of imageDataUrls) {
      const img = document.createElement("img");
      img.src = url;
      img.alt = "Attached reference";
      thumbRow.appendChild(img);
    }
    bubble.appendChild(thumbRow);
  }

  dom.chatMessages.appendChild(bubble);
  dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
}

function renderChatAttachmentStrip() {
  dom.chatAttachmentStrip.innerHTML = "";
  if (state.chatAttachments.length === 0) {
    dom.chatAttachmentStrip.classList.add("hidden");
    return;
  }

  dom.chatAttachmentStrip.classList.remove("hidden");
  for (const item of state.chatAttachments) {
    const chip = document.createElement("div");
    chip.className = "attachment-chip";

    const thumb = document.createElement("img");
    thumb.src = item.dataUrl;
    thumb.alt = item.name;

    const label = document.createElement("span");
    label.textContent = item.assetId
      ? `🌊 ${item.name.slice(0, 16)}`
      : `${item.name.slice(0, 14)} (${item.width}×${item.height})`;
    if (item.assetId) {
      chip.title = "Generated in Flow: picked from the project instead of re-uploading";
    }

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "chip-remove-btn";
    removeBtn.textContent = "✕";
    removeBtn.title = "Remove attachment";
    removeBtn.addEventListener("click", () => {
      state.chatAttachments = state.chatAttachments.filter((a) => a.id !== item.id);
      renderChatAttachmentStrip();
    });

    chip.append(thumb, label, removeBtn);
    dom.chatAttachmentStrip.appendChild(chip);
  }
}

/**
 * Processes user-selected or dropped image files, downscaling them client-side to max 1024px.
 * @param {FileList|File[]} files
 */
async function handleAttachFiles(files) {
  if (!files || files.length === 0) return;

  for (const file of Array.from(files)) {
    try {
      const downscaled = await downscaleImage(file, { maxDimension: 1024 });
      state.chatAttachments.push({
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        name: downscaled.name,
        dataUrl: downscaled.dataUrl,
        width: downscaled.width,
        height: downscaled.height
      });
    } catch (err) {
      appendChatMessage("system", `Attachment skipped: ${err.message || String(err)}`);
    }
  }
  renderChatAttachmentStrip();
}

/**
 * Adds the generated image(s) of a finished queue item to the chat attachments, so the next
 * prompts use them as image-to-image references. Flow's asset IDs are kept so the content
 * script can pick the exact image from the project instead of uploading a copy.
 * @param {object} item queue item
 */
async function handleUseResultAsReference(item) {
  const urls = item.resultDataUrls && item.resultDataUrls.length ? item.resultDataUrls : [item.resultDataUrl];
  let added = 0;
  for (const [index, url] of urls.entries()) {
    if (!url) continue;
    const assetId = (item.resultAssetIds && item.resultAssetIds[index]) || null;
    if (assetId && state.chatAttachments.some((a) => a.assetId === assetId)) continue;
    try {
      // Small copy for the text model and as upload fallback; Flow uses the original via assetId
      const small = await downscaleImage(url, { maxDimension: 1024 });
      state.chatAttachments.push({
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        name: `Flow result ${urls.length > 1 ? `${index + 1}/${urls.length}` : ""}`.trim(),
        dataUrl: small.dataUrl,
        width: small.width,
        height: small.height,
        assetId
      });
      added++;
    } catch (err) {
      appendChatMessage("system", `Could not use the result as a reference: ${err.message || String(err)}`);
    }
  }
  renderChatAttachmentStrip();
  if (added > 0) {
    appendChatMessage(
      "system",
      `Added ${added} generated image(s) as reference. Describe the change you want and click ✨ Generate Prompts.`
    );
    dom.chatInputTextarea.focus();
  }
}

/* ---- Flow project gallery: pick existing Flow images as references ---- */

const flowGallery = {
  images: [], // { assetId, name, baseUrl, thumbDataUrl }
  selected: new Set()
};

/**
 * Sends a message to the content script in the Flow tab (via the service worker).
 * @param {object} payload e.g. { type: "LIST_FLOW_IMAGES" }
 */
function sendToFlowTab(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "DISPATCH_TO_FLOW_TAB", payload }, (bgResp) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!bgResp || !bgResp.ok) return reject(new Error(bgResp?.error || "Could not reach the Flow tab."));
      const resp = bgResp.response;
      if (!resp || !resp.ok) return reject(new Error(resp?.error || "The Flow tab did not answer."));
      resolve(resp);
    });
  });
}

function updateFlowGalleryAddButton() {
  const n = flowGallery.selected.size;
  dom.addFlowGalleryBtn.disabled = n === 0;
  dom.addFlowGalleryBtn.textContent = n > 0 ? `Add ${n} as reference${n > 1 ? "s" : ""}` : "Add selected";
}

function renderFlowGallery() {
  dom.flowGalleryGrid.innerHTML = "";
  const attachedIds = new Set(state.chatAttachments.map((a) => a.assetId).filter(Boolean));
  for (const image of flowGallery.images) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `gallery-item${flowGallery.selected.has(image.assetId) ? " selected" : ""}`;
    btn.title = attachedIds.has(image.assetId) ? `${image.name} (already attached)` : image.name;
    btn.setAttribute("aria-pressed", String(flowGallery.selected.has(image.assetId)));

    if (image.thumbDataUrl) {
      const img = document.createElement("img");
      img.src = image.thumbDataUrl;
      img.alt = image.name;
      btn.appendChild(img);
    }
    const name = document.createElement("span");
    name.className = "gallery-name";
    name.textContent = attachedIds.has(image.assetId) ? `✓ ${image.name}` : image.name;
    btn.appendChild(name);

    btn.addEventListener("click", () => {
      if (flowGallery.selected.has(image.assetId)) flowGallery.selected.delete(image.assetId);
      else flowGallery.selected.add(image.assetId);
      btn.classList.toggle("selected");
      btn.setAttribute("aria-pressed", String(flowGallery.selected.has(image.assetId)));
      updateFlowGalleryAddButton();
    });
    dom.flowGalleryGrid.appendChild(btn);
  }
  updateFlowGalleryAddButton();
}

async function loadFlowGallery() {
  if (state.runnerState === "Running" || state.runnerState === "Cooldown") {
    dom.flowGalleryStatus.textContent = "The queue is running. Pause it or wait until it finishes, then refresh.";
    return;
  }
  dom.flowGalleryStatus.textContent = "Loading images from the Flow tab…";
  dom.refreshFlowGalleryBtn.disabled = true;
  try {
    const { images } = await sendToFlowTab({ type: "LIST_FLOW_IMAGES", payload: { limit: 80 } });
    flowGallery.images = Array.isArray(images) ? images : [];
    flowGallery.selected = new Set(
      [...flowGallery.selected].filter((id) => flowGallery.images.some((i) => i.assetId === id))
    );
    dom.flowGalleryStatus.textContent = flowGallery.images.length
      ? `${flowGallery.images.length} image(s), newest first. Click to select, then add them as references.`
      : "No images found in this Flow project.";
    renderFlowGallery();
  } catch (err) {
    dom.flowGalleryStatus.textContent = `Could not load images: ${err.message || String(err)}`;
  } finally {
    dom.refreshFlowGalleryBtn.disabled = false;
  }
}

function openFlowGallery() {
  dom.flowGalleryModal.classList.remove("hidden");
  if (flowGallery.images.length === 0) {
    loadFlowGallery();
  } else {
    renderFlowGallery();
  }
}

function closeFlowGallery() {
  dom.flowGalleryModal.classList.add("hidden");
}

async function addSelectedFlowImages() {
  const chosen = flowGallery.images.filter((i) => flowGallery.selected.has(i.assetId));
  if (chosen.length === 0) return;
  dom.addFlowGalleryBtn.disabled = true;
  dom.flowGalleryStatus.textContent = `Adding ${chosen.length} image(s)…`;
  let added = 0;
  for (const image of chosen) {
    if (state.chatAttachments.some((a) => a.assetId === image.assetId)) continue;
    try {
      // 1024 px copy for the text model (and as upload fallback); Flow itself uses the original via assetId
      const { dataUrl } = await sendToFlowTab({
        type: "FETCH_FLOW_IMAGE",
        payload: { baseUrl: image.baseUrl, size: 1024 }
      });
      const small = await downscaleImage(dataUrl, { maxDimension: 1024 });
      state.chatAttachments.push({
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        name: image.name,
        dataUrl: small.dataUrl,
        width: small.width,
        height: small.height,
        assetId: image.assetId
      });
      added++;
    } catch (err) {
      appendChatMessage("system", `Could not add "${image.name}": ${err.message || String(err)}`);
    }
  }
  flowGallery.selected.clear();
  renderChatAttachmentStrip();
  closeFlowGallery();
  if (added > 0) {
    appendChatMessage(
      "system",
      `Added ${added} Flow image(s) as reference. Describe what you want and click ✨ Generate Prompts.`
    );
    dom.chatInputTextarea.focus();
  }
}

function setComposerBusy(isBusy) {
  dom.sendChatBtn.disabled = isBusy;
  dom.generatePromptsBtn.disabled = isBusy;
  dom.attachImageBtn.disabled = isBusy;
  if (dom.pickFromFlowBtn) dom.pickFromFlowBtn.disabled = isBusy;
  dom.chatInputTextarea.disabled = isBusy;
}

/**
 * Detects explicit aspect ratio or Google Flow model mentions in user text as a fallback
 * when `allowAiOverrides` is enabled.
 * @param {string} text
 * @returns {{aspectRatio: string|null, targetFlowModel: string|null}}
 */
function detectNaturalLanguageOverrides(text) {
  if (!text || typeof text !== "string") {
    return { aspectRatio: null, targetFlowModel: null };
  }
  let detectedRatio = null;
  for (const ratio of ALLOWED_ASPECT_RATIOS) {
    const escaped = ratio.replace(":", "\\s*:\\s*");
    const regex = new RegExp(`(?:^|\\b)${escaped}(?:\\b|$)`, "i");
    if (regex.test(text)) {
      detectedRatio = ratio;
      break;
    }
  }

  let detectedModel = null;
  // Check longer model names first (e.g., "Nano Banana 2.1" before "Nano Banana")
  const sortedModels = [...GOOGLE_FLOW_IMAGE_MODELS].sort((a, b) => b.length - a.length);
  for (const model of sortedModels) {
    if (text.toLowerCase().includes(model.toLowerCase())) {
      detectedModel = model;
      break;
    }
  }

  return { aspectRatio: detectedRatio, targetFlowModel: detectedModel };
}

/**
 * Applies AI or user-requested overrides to the active settings UI and returns a human-readable note.
 * @param {{aspectRatio?: string|null, targetFlowModel?: string|null}} overrides
 * @returns {string[]} List of applied override descriptions
 */
function applyActiveSettingOverrides(overrides) {
  if (!state.config.allowAiOverrides || !overrides) return [];
  const applied = [];

  const nextRatio = normalizeAspectRatioOverride(overrides.aspectRatio);
  if (nextRatio && nextRatio !== state.config.aspectRatio) {
    state.config.aspectRatio = nextRatio;
    dom.aspectRatioSelect.value = nextRatio;
    applied.push(`Aspect Ratio → ${nextRatio}`);
  }

  const nextModel = normalizeFlowModelOverride(overrides.targetFlowModel);
  if (nextModel && nextModel !== state.config.targetFlowModel) {
    state.config.targetFlowModel = nextModel;
    dom.targetFlowModelSelect.value = nextModel;
    applied.push(`Target Flow Model → ${nextModel}`);
  }

  const nextCount = normalizeImagesPerPromptOverride(overrides.imagesPerPrompt);
  if (nextCount && nextCount !== state.config.imagesPerPrompt) {
    state.config.imagesPerPrompt = nextCount;
    if (dom.imagesPerPromptSelect) {
      dom.imagesPerPromptSelect.value = String(nextCount);
    }
    applied.push(`Images/Prompt → ${nextCount}`);
  }

  return applied;
}

/**
 * Handles standard multimodal chat query.
 */
async function handleSendChat() {
  if (!checkStrictValidationGate()) {
    return;
  }

  const userText = dom.chatInputTextarea.value.trim();
  const attachedImages = state.chatAttachments.map((a) => a.dataUrl);

  if (!userText && attachedImages.length === 0) {
    appendChatMessage("system", "Enter a message or attach a reference image before sending.");
    return;
  }

  appendChatMessage("user", userText || "[Attached Reference Image(s)]", attachedImages);
  dom.chatInputTextarea.value = "";
  state.chatAttachments = [];
  renderChatAttachmentStrip();

  if (state.config.allowAiOverrides && userText) {
    const nlOverrides = detectNaturalLanguageOverrides(userText);
    const appliedNotes = applyActiveSettingOverrides(nlOverrides);
    if (appliedNotes.length > 0) {
      appendChatMessage("system", `⚡ AI Override applied: ${appliedNotes.join(", ")}`);
    }
  }

  setComposerBusy(true);
  try {
    const reply = await sendMultimodalChat(state.config, {
      userText,
      imageDataUrls: attachedImages,
      history: state.chatHistory
    });

    state.chatHistory.push({ role: "user", text: userText, images: attachedImages });
    state.chatHistory.push({ role: "assistant", text: reply });
    appendChatMessage("assistant", reply);
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      showValidationBanner(err.message, err.missingFields);
    }
    appendChatMessage("system", `Chat error: ${err.message || String(err)}`);
  } finally {
    setComposerBusy(false);
  }
}

/**
 * Handles Batch Prompt Expansion (`response_format: {"type": "json_object"}`)
 * and adds the expanded prompts directly to the Execution Queue.
 */
async function handleGeneratePrompts() {
  if (!checkStrictValidationGate()) {
    return;
  }

  const userText = dom.chatInputTextarea.value.trim();
  const attachedImages = state.chatAttachments.map((a) => a.dataUrl);
  // Images attached to this message become Flow image-to-image references for every new prompt
  const flowReferences =
    state.config.useRefsInFlow !== false
      ? state.chatAttachments.map((a) => ({ dataUrl: a.dataUrl, name: a.name, assetId: a.assetId || null }))
      : [];

  if (!userText && attachedImages.length === 0) {
    appendChatMessage(
      "system",
      "Provide a concept description or attach a reference image to generate batch prompts."
    );
    return;
  }

  appendChatMessage(
    "user",
    `[Generate Batch Prompts] ${userText || "(From reference images)"}`,
    attachedImages
  );
  dom.chatInputTextarea.value = "";
  state.chatAttachments = [];
  renderChatAttachmentStrip();

  const baselineRatio = state.config.aspectRatio;
  const baselineModel = state.config.targetFlowModel;
  const baselineImagesPerPrompt = state.config.imagesPerPrompt || 1;
  const nlFallback = state.config.allowAiOverrides
    ? detectNaturalLanguageOverrides(userText)
    : { aspectRatio: null, targetFlowModel: null };

  setComposerBusy(true);
  try {
    const requestedCount = dom.promptCountSelect ? dom.promptCountSelect.value : "auto";
    const { prompts, overrides } = await generateBatchPrompts(state.config, {
      userText,
      imageDataUrls: attachedImages,
      history: state.chatHistory,
      requestedCount
    });

    const effectiveOverrides = {
      aspectRatio: overrides?.aspectRatio || nlFallback.aspectRatio,
      targetFlowModel: overrides?.targetFlowModel || nlFallback.targetFlowModel,
      imagesPerPrompt: overrides?.imagesPerPrompt || null
    };

    const appliedNotes = applyActiveSettingOverrides(effectiveOverrides);
    if (appliedNotes.length > 0) {
      appendChatMessage("system", `⚡ AI Override applied: ${appliedNotes.join(", ")}`);
    }

    enqueuePrompts(prompts, {
      defaultAspectRatio: baselineRatio,
      defaultFlowModel: baselineModel,
      defaultImagesPerPrompt: baselineImagesPerPrompt,
      fallbackOverrides: effectiveOverrides,
      references: flowReferences
    });
    if (flowReferences.length > 0) {
      appendChatMessage(
        "system",
        `🖼 Each new prompt will use ${flowReferences.length} reference image(s) in Flow (image-to-image).`
      );
    }

    const summary = `Expanded ${prompts.length} prompt(s) and added to Execution Queue:\n${prompts
      .map((p, idx) => {
        const text = typeof p === "string" ? p : p.prompt;
        const ratio = (typeof p === "object" && p.aspectRatio) || effectiveOverrides.aspectRatio || state.config.aspectRatio;
        const model = (typeof p === "object" && p.targetFlowModel) || effectiveOverrides.targetFlowModel || state.config.targetFlowModel;
        const imgCount =
          (typeof p === "object" && p.imagesPerPrompt) ||
          effectiveOverrides.imagesPerPrompt ||
          state.config.imagesPerPrompt ||
          1;
        return `${idx + 1}. [${ratio} · ${model} · ×${imgCount}] ${text}`;
      })
      .join("\n")}`;

    state.chatHistory.push({ role: "user", text: userText, images: attachedImages });
    state.chatHistory.push({ role: "assistant", text: summary });
    appendChatMessage("assistant", summary);
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      showValidationBanner(err.message, err.missingFields);
    }
    appendChatMessage("system", `Batch prompt generation failed: ${err.message || String(err)}`);
  } finally {
    setComposerBusy(false);
  }
}

/* ==========================================================================
   3. Execution Queue Management & Closed-Loop Vision Critique
   ========================================================================== */

/**
 * Adds an array of prompt strings or prompt objects to the execution queue,
 * preserving per-prompt AI overrides for Aspect Ratio and Flow Model.
 * @param {Array<string|{prompt: string, aspectRatio?: string|null, targetFlowModel?: string|null}>} prompts
 * @param {object} [context]
 */
function enqueuePrompts(prompts, context = {}) {
  syncFormToState();
  const baseRatio = context.defaultAspectRatio || state.config.aspectRatio || "1:1";
  const baseModel = context.defaultFlowModel || state.config.targetFlowModel || "Nano Banana 2.1";
  const baseImgCount = context.defaultImagesPerPrompt || state.config.imagesPerPrompt || 1;
  const fallbackRatio = context.fallbackOverrides?.aspectRatio || null;
  const fallbackModel = context.fallbackOverrides?.targetFlowModel || null;
  const fallbackImgCount = context.fallbackOverrides?.imagesPerPrompt || null;

  for (const entry of prompts) {
    const promptText = typeof entry === "string" ? entry.trim() : (entry?.prompt || "").trim();
    if (!promptText) continue;

    const itemRatio =
      (typeof entry === "object" && normalizeAspectRatioOverride(entry.aspectRatio)) ||
      normalizeAspectRatioOverride(fallbackRatio) ||
      state.config.aspectRatio ||
      "1:1";

    const itemModel =
      (typeof entry === "object" && normalizeFlowModelOverride(entry.targetFlowModel)) ||
      normalizeFlowModelOverride(fallbackModel) ||
      state.config.targetFlowModel ||
      "Nano Banana 2.1";

    const itemImagesPerPrompt =
      (typeof entry === "object" && normalizeImagesPerPromptOverride(entry.imagesPerPrompt)) ||
      normalizeImagesPerPromptOverride(fallbackImgCount) ||
      state.config.imagesPerPrompt ||
      1;

    const isOverridden =
      itemRatio !== baseRatio || itemModel !== baseModel || itemImagesPerPrompt !== baseImgCount;

    state.queue.push({
      id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      prompt: promptText,
      aspectRatio: itemRatio,
      targetFlowModel: itemModel,
      imagesPerPrompt: itemImagesPerPrompt,
      isOverridden,
      references: Array.isArray(context.references) ? context.references : [],
      status: "pending",
      resultDataUrl: null,
      resultDataUrls: [],
      resultAssetIds: [],
      error: null
    });
  }
  renderQueueTable();
}

function setRunnerState(nextState) {
  state.runnerState = nextState;
  dom.runnerStateBadge.textContent = nextState;
  dom.runnerStateBadge.className = `runner-state state-${nextState.toLowerCase()}`;

  const isRunningOrCooldown = nextState === "Running" || nextState === "Cooldown";
  dom.startQueueBtn.disabled = isRunningOrCooldown;
  dom.pauseQueueBtn.disabled = !isRunningOrCooldown;
}

function renderQueueTable() {
  const total = state.queue.length;
  dom.queueCountBadge.textContent = `${total} ${total === 1 ? "prompt" : "prompts"}`;

  dom.queueTableBody.innerHTML = "";
  if (total === 0) {
    const emptyRow = document.createElement("tr");
    emptyRow.className = "empty-queue-row";
    emptyRow.innerHTML = `<td colspan="4">Queue is empty. Use "Generate Prompts" above to populate batch items.</td>`;
    dom.queueTableBody.appendChild(emptyRow);
    return;
  }

  for (const item of state.queue) {
    const tr = document.createElement("tr");

    // 1. Prompt Preview Cell + Parameter Badges
    const tdPrompt = document.createElement("td");
    const promptDiv = document.createElement("div");
    promptDiv.className = "prompt-cell-text";
    promptDiv.title = item.prompt;
    promptDiv.textContent = item.prompt;
    tdPrompt.appendChild(promptDiv);

    const badgeRow = document.createElement("div");
    badgeRow.className = "queue-param-badges";

    const ratioBadge = document.createElement("span");
    ratioBadge.className = `param-badge${item.isOverridden ? " overridden" : ""}`;
    ratioBadge.textContent = item.aspectRatio || state.config.aspectRatio || "1:1";

    const modelBadge = document.createElement("span");
    modelBadge.className = `param-badge${item.isOverridden ? " overridden" : ""}`;
    modelBadge.textContent = item.targetFlowModel || state.config.targetFlowModel || "Nano Banana 2.1";

    const countBadge = document.createElement("span");
    countBadge.className = `param-badge${item.isOverridden ? " overridden" : ""}`;
    countBadge.textContent = `×${item.imagesPerPrompt || state.config.imagesPerPrompt || 1}`;

    badgeRow.append(ratioBadge, modelBadge, countBadge);
    if (item.references && item.references.length > 0) {
      const refBadge = document.createElement("span");
      refBadge.className = "param-badge overridden";
      refBadge.textContent = `🖼 ${item.references.length} ref`;
      refBadge.title = `Image-to-image with: ${item.references.map((r) => r.name || "image").join(", ")}`;
      badgeRow.appendChild(refBadge);
    }
    tdPrompt.appendChild(badgeRow);

    if (item.error) {
      const errSub = document.createElement("div");
      errSub.className = "prompt-error-subtext";
      errSub.textContent = item.error;
      tdPrompt.appendChild(errSub);
    }

    // 2. Status Pill Cell
    const tdStatus = document.createElement("td");
    const pill = document.createElement("span");
    pill.className = `status-pill status-${item.status}`;
    pill.textContent = item.status;
    tdStatus.appendChild(pill);

    // 3. Result Thumbnail Cell
    const tdThumb = document.createElement("td");
    if (item.resultDataUrl) {
      const img = document.createElement("img");
      img.className = "result-thumb";
      img.src = item.resultDataUrl;
      img.alt = "Generated Flow output";
      img.title = "Click to inspect full image";
      img.addEventListener("click", () => openImageModal(item.resultDataUrl, item.prompt));
      tdThumb.appendChild(img);
    } else {
      const dash = document.createElement("span");
      dash.className = "no-thumb";
      dash.textContent = "—";
      tdThumb.appendChild(dash);
    }

    // 4. Action Cell ("Critique with Vision AI")
    const tdAction = document.createElement("td");
    const critiqueBtn = document.createElement("button");
    critiqueBtn.type = "button";
    critiqueBtn.className = "critique-btn";
    critiqueBtn.textContent = "Critique with Vision AI";
    critiqueBtn.disabled = !item.resultDataUrl;
    critiqueBtn.addEventListener("click", () => handleCritiqueQueueItem(item));
    tdAction.appendChild(critiqueBtn);

    const useRefBtn = document.createElement("button");
    useRefBtn.type = "button";
    useRefBtn.className = "critique-btn";
    useRefBtn.textContent = "↪ Use as reference";
    useRefBtn.title = "Attach this generated image to the chat so new prompts edit it in Flow (image-to-image)";
    useRefBtn.disabled = !item.resultDataUrl;
    useRefBtn.addEventListener("click", () => handleUseResultAsReference(item));
    tdAction.appendChild(useRefBtn);

    tr.append(tdPrompt, tdStatus, tdThumb, tdAction);
    dom.queueTableBody.appendChild(tr);
  }
}

/**
 * Closed-Loop Vision Feedback:
 * Sends a completed Flow output image back to the vision LLM for style analysis
 * and automatically enqueues any refined prompt variations returned.
 */
async function handleCritiqueQueueItem(item) {
  if (!item || !item.resultDataUrl) return;
  if (!checkStrictValidationGate()) return;

  appendChatMessage(
    "user",
    `[Critique with Vision AI] Analyzing output for prompt: "${item.prompt}"`,
    [item.resultDataUrl]
  );

  try {
    const { critique, prompts } = await critiqueGeneratedImageWithVision(state.config, {
      originalPrompt: item.prompt,
      generatedImageDataUrl: item.resultDataUrl
    });

    let messageText = `🔍 Vision Critique:\n${critique}`;
    if (Array.isArray(prompts) && prompts.length > 0) {
      enqueuePrompts(prompts, {
        defaultAspectRatio: item.aspectRatio || state.config.aspectRatio,
        defaultFlowModel: item.targetFlowModel || state.config.targetFlowModel
      });
      messageText += `\n\n✨ Enqueued ${prompts.length} refined prompt variation(s):\n${prompts
        .map((p, idx) => `${idx + 1}. ${typeof p === "string" ? p : p.prompt}`)
        .join("\n")}`;
    }

    appendChatMessage("assistant", messageText);
  } catch (err) {
    appendChatMessage("system", `Vision critique failed: ${err.message || String(err)}`);
  }
}

/**
 * Sends a single queue item to the Google Labs Flow content script and awaits completion.
 * @param {object} item
 * @returns {Promise<{imageDataUrl: string}>}
 */
function executeFlowStepInTab(item) {
  syncFormToState();
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: "DISPATCH_TO_FLOW_TAB",
        payload: {
          type: "EXECUTE_FLOW_PROMPT",
          payload: {
            prompt: item.prompt,
            aspectRatio: item.aspectRatio || state.config.aspectRatio,
            targetModel: item.targetFlowModel || state.config.targetFlowModel,
            imagesPerPrompt: item.imagesPerPrompt || state.config.imagesPerPrompt || 1,
            references: Array.isArray(item.references) ? item.references : [],
            img2imgDataUrl: state.config.img2imgDataUrl || null,
            img2imgName: state.config.img2imgName || "reference.png",
            upscaleDownload: Boolean(state.config.upscaleDownload)
          },
          // Read by the service worker to route Flow's own downloads (not used by the content script)
          downloadRoute: {
            subfolder: state.config.downloadSubfolder || "",
            useDirectFolder: Boolean(state.directoryHandle)
          }
        }
      },
      (bgResp) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!bgResp || !bgResp.ok) {
          reject(new Error(bgResp?.error || "Failed to communicate with Google Labs Flow tab."));
          return;
        }
        const tabResp = bgResp.response;
        const imageDataUrls = Array.isArray(tabResp?.imageDataUrls) && tabResp.imageDataUrls.length > 0
          ? tabResp.imageDataUrls
          : tabResp?.imageDataUrl
            ? [tabResp.imageDataUrl]
            : [];

        if (!tabResp || !tabResp.ok || imageDataUrls.length === 0) {
          reject(new Error(tabResp?.error || "Flow automation did not return a generated image."));
          return;
        }
        resolve({
          imageDataUrl: imageDataUrls[0],
          imageDataUrls,
          assetIds: Array.isArray(tabResp.assetIds) ? tabResp.assetIds : [],
          downloadedViaFlow: Boolean(tabResp.downloadedViaFlow)
        });
      }
    );
  });
}

/**
 * Requests the background service worker to download the generated image into the user's subfolder.
 * @param {string} imageDataUrl
 */
async function triggerBackgroundDownload(imageDataUrl) {
  syncFormToState();
  const now = new Date();
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  const ts =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}_${pad(now.getMilliseconds(), 3)}`;
  const ext = /^data:image\/jpeg/i.test(imageDataUrl) ? "jpg" : "png";
  const filename = `flow_${ts}.${ext}`;

  // Priority 1: Direct save into the folder chosen via Windows Explorer (`showDirectoryPicker`)
  if (state.directoryHandle) {
    try {
      const savedPath = await writeImageToDirectoryHandle(
        state.directoryHandle,
        imageDataUrl,
        filename
      );
      return { ok: true, filename: savedPath, directFs: true };
    } catch (fsErr) {
      appendChatMessage(
        "system",
        `Direct Explorer folder write failed (${fsErr.message || String(fsErr)}). Falling back to Chrome Downloads...`
      );
    }
  }

  // Priority 2: Standard Chrome Downloads subfolder routing
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      {
        type: "DOWNLOAD_IMAGE",
        payload: {
          imageDataUrl,
          subfolder: state.config.downloadSubfolder,
          saveAs: Boolean(state.config.saveAsDialog),
          timestamp: now.getTime()
        }
      },
      (resp) => {
        if (chrome.runtime.lastError || !resp?.ok) {
          appendChatMessage(
            "system",
            `Download warning: ${chrome.runtime.lastError?.message || resp?.error || "Unknown error"}`
          );
        }
        resolve(resp);
      }
    );
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Asynchronous Execution Queue Runner loop.
 */
async function runQueueLoop() {
  if (state.isLoopActive) return;
  state.isLoopActive = true;
  setRunnerState("Running");

  try {
    while (state.runnerState === "Running" || state.runnerState === "Cooldown") {
      const nextItem = state.queue.find((q) => q.status === "pending");
      if (!nextItem) {
        setRunnerState("Idle");
        break;
      }

      setRunnerState("Running");
      nextItem.status = "running";
      nextItem.error = null;
      renderQueueTable();

      try {
        const { imageDataUrl, imageDataUrls, assetIds, downloadedViaFlow } = await executeFlowStepInTab(nextItem);
        nextItem.status = "success";
        nextItem.resultDataUrl = imageDataUrl;
        nextItem.resultDataUrls = imageDataUrls;
        nextItem.resultAssetIds = assetIds;
        renderQueueTable();

        // If Flow's own native Download button wasn't triggered, fall back to extension download
        if (!downloadedViaFlow) {
          for (const imgUrl of imageDataUrls) {
            await triggerBackgroundDownload(imgUrl);
          }
        }
      } catch (stepErr) {
        nextItem.status = "failed";
        nextItem.error = stepErr.message || String(stepErr);
        renderQueueTable();
        appendChatMessage("system", `Queue item failed: ${nextItem.error}`);
      }

      // Check if paused during execution or if more pending items remain
      if (state.runnerState === "Paused") {
        break;
      }

      const hasMorePending = state.queue.some((q) => q.status === "pending");
      if (!hasMorePending) {
        setRunnerState("Idle");
        break;
      }

      // Pacing Delay Cooldown between steps
      syncFormToState();
      const delayMs = Math.max(1000, Math.round((state.config.pacingDelay || 1) * 1000));
      setRunnerState("Cooldown");

      const sliceMs = 250;
      let elapsed = 0;
      while (elapsed < delayMs && state.runnerState === "Cooldown") {
        await sleep(Math.min(sliceMs, delayMs - elapsed));
        elapsed += sliceMs;
      }

      if (state.runnerState === "Paused") {
        break;
      }
    }
  } finally {
    state.isLoopActive = false;
    if (state.runnerState !== "Paused") {
      setRunnerState("Idle");
    }
  }
}

function handleStartQueue() {
  const hasPendingOrFailed = state.queue.some((q) => q.status === "pending" || q.status === "failed");
  if (!hasPendingOrFailed) {
    appendChatMessage("system", "No pending prompts in the queue to run.");
    return;
  }

  // Reset failed items to pending if no pending items exist
  if (!state.queue.some((q) => q.status === "pending")) {
    for (const item of state.queue) {
      if (item.status === "failed") {
        item.status = "pending";
        item.error = null;
      }
    }
    renderQueueTable();
  }

  runQueueLoop();
}

function handlePauseQueue() {
  if (state.runnerState === "Running" || state.runnerState === "Cooldown") {
    setRunnerState("Paused");
    appendChatMessage("system", "Execution queue paused.");
  }
}

function handleClearQueue() {
  state.runnerState = "Idle";
  setRunnerState("Idle");
  state.queue = [];
  renderQueueTable();
}

/* ==========================================================================
   4. Lightbox Modal & Event Listeners
   ========================================================================== */

function openImageModal(dataUrl, promptText) {
  dom.modalImage.src = dataUrl;
  dom.modalPromptText.textContent = promptText || "";
  dom.imageModal.classList.remove("hidden");
}

function closeImageModal() {
  dom.imageModal.classList.add("hidden");
  dom.modalImage.src = "";
}

function bindEvents() {
  dom.toggleSettingsBtn.addEventListener("click", () => toggleSettingsDrawer());
  dom.dismissBannerBtn.addEventListener("click", () => hideValidationBanner());

  // Mark badge unsaved on input changes
  const configInputs = [
    dom.baseUrlInput,
    dom.apiKeyInput,
    dom.modelNameInput,
    dom.systemPromptInput,
    dom.aspectRatioSelect,
    dom.targetFlowModelSelect,
    dom.imagesPerPromptSelect,
    dom.allowAiOverridesCheckbox,
    dom.downloadSubfolderInput,
    dom.pacingDelayInput
  ];
  for (const inputEl of configInputs) {
    inputEl.addEventListener("input", () => {
      dom.saveStatusBadge.textContent = "Unsaved";
      dom.saveStatusBadge.classList.remove("saved");
    });
    inputEl.addEventListener("change", () => {
      dom.saveStatusBadge.textContent = "Unsaved";
      dom.saveStatusBadge.classList.remove("saved");
    });
  }

  // Aggregator Model Fetch button & quick-select dropdown synchronization
  dom.fetchModelsBtn.addEventListener("click", () => handleFetchModels());
  dom.fetchedModelsSelect.addEventListener("change", (e) => {
    const picked = e.target.value;
    if (picked) {
      dom.modelNameInput.value = picked;
      state.config.modelName = picked;
      dom.saveStatusBadge.textContent = "Unsaved";
      dom.saveStatusBadge.classList.remove("saved");
      dom.modelNameInput.classList.remove("input-invalid");
    }
  });
  dom.modelNameInput.addEventListener("input", () => {
    if (dom.fetchedModelsSelect && !dom.fetchedModelsSelect.classList.contains("hidden")) {
      const currentVal = dom.modelNameInput.value.trim();
      dom.fetchedModelsSelect.value = state.fetchedModels.includes(currentVal) ? currentVal : "";
    }
  });

  // Load built-in default system prompt into the custom editor on click
  if (dom.fillDefaultPromptBtn) {
    dom.fillDefaultPromptBtn.addEventListener("click", () => {
      dom.systemPromptInput.value = DEFAULT_SYSTEM_PROMPT;
      state.config.systemPrompt = DEFAULT_SYSTEM_PROMPT;
      dom.saveStatusBadge.textContent = "Unsaved";
      dom.saveStatusBadge.classList.remove("saved");
    });
  }

  // Dedicated Img2Img reference upload
  dom.img2imgFileInput.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const processed = await downscaleImage(file, { maxDimension: 1024 });
      state.config.img2imgDataUrl = processed.dataUrl;
      state.config.img2imgName = `${processed.name} (${processed.width}×${processed.height})`;
      renderImg2ImgPreview();
      dom.saveStatusBadge.textContent = "Unsaved";
      dom.saveStatusBadge.classList.remove("saved");
    } catch (err) {
      appendChatMessage("system", `Img2Img reference error: ${err.message || String(err)}`);
    }
  });

  dom.clearImg2ImgBtn.addEventListener("click", () => {
    state.config.img2imgDataUrl = "";
    state.config.img2imgName = "";
    renderImg2ImgPreview();
    dom.saveStatusBadge.textContent = "Unsaved";
    dom.saveStatusBadge.classList.remove("saved");
  });

  // Explorer Download Folder Picker & Clear buttons
  if (dom.pickFolderBtn) {
    dom.pickFolderBtn.addEventListener("click", () => handlePickDownloadFolder());
  }
  // The service worker intercepts Flow's own downloads and asks us to write them into the picked folder.
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "SAVE_FLOW_DOWNLOAD_TO_FOLDER") return false;
    saveFlowDownloadToPickedFolder(message).then((res) => {
      if (res.ok) {
        appendChatMessage("system", `Saved Flow download to ${res.savedPath}`);
      } else {
        appendChatMessage(
          "system",
          `Could not write into the picked folder (${res.error}). Saved to Downloads/${state.config.downloadSubfolder || ""} instead.`
        );
      }
      sendResponse(res);
    });
    return true;
  });
  if (dom.clearFolderBtn) {
    dom.clearFolderBtn.addEventListener("click", () => handleClearDownloadFolder());
  }
  // Alembic bridge switch: separate storage key, read by the service worker on every request
  if (dom.alembicBridgeCheckbox) {
    const BRIDGE_SETTINGS_KEY = "flow_sidecar_bridge_v1";
    chrome.storage.local.get(BRIDGE_SETTINGS_KEY, (stored) => {
      dom.alembicBridgeCheckbox.checked = Boolean(stored?.[BRIDGE_SETTINGS_KEY]?.enabled);
    });
    dom.alembicBridgeCheckbox.addEventListener("change", () => {
      const enabled = Boolean(dom.alembicBridgeCheckbox.checked);
      chrome.storage.local.set({ [BRIDGE_SETTINGS_KEY]: { enabled } });
      appendChatMessage(
        "system",
        enabled
          ? "Alembic may now generate images through your open Flow project (this uses your Flow credits). Keep a Flow project open, ideally in its own window."
          : "Alembic can no longer control Flow."
      );
    });
  }
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "BRIDGE_ACTIVITY" && typeof message.text === "string") {
      appendChatMessage("system", `🔗 ${message.text}`);
    }
    return false;
  });

  if (dom.pickFromFlowBtn) {
    dom.pickFromFlowBtn.addEventListener("click", () => openFlowGallery());
    dom.closeFlowGalleryBtn.addEventListener("click", () => closeFlowGallery());
    dom.refreshFlowGalleryBtn.addEventListener("click", () => loadFlowGallery());
    dom.addFlowGalleryBtn.addEventListener("click", () => addSelectedFlowImages());
    dom.flowGalleryModal.addEventListener("click", (e) => {
      if (e.target === dom.flowGalleryModal) closeFlowGallery();
    });
  }
  if (dom.useRefsInFlowCheckbox) {
    dom.useRefsInFlowCheckbox.addEventListener("change", () => {
      state.config.useRefsInFlow = Boolean(dom.useRefsInFlowCheckbox.checked);
      // Remember just this toggle right away (it lives in the chat area, not the settings form)
      chrome.storage.local.get(STORAGE_KEY, (stored) => {
        const saved = stored?.[STORAGE_KEY];
        if (saved && typeof saved === "object") {
          chrome.storage.local.set({ [STORAGE_KEY]: { ...saved, useRefsInFlow: state.config.useRefsInFlow } });
        }
      });
    });
  }
  if (dom.upscaleDownloadCheckbox) {
    dom.upscaleDownloadCheckbox.addEventListener("change", () => {
      state.config.upscaleDownload = Boolean(dom.upscaleDownloadCheckbox.checked);
      dom.saveStatusBadge.textContent = "Unsaved";
      dom.saveStatusBadge.classList.remove("saved");
    });
  }
  if (dom.saveAsDialogCheckbox) {
    dom.saveAsDialogCheckbox.addEventListener("change", () => {
      state.config.saveAsDialog = Boolean(dom.saveAsDialogCheckbox.checked);
      dom.saveStatusBadge.textContent = "Unsaved";
      dom.saveStatusBadge.classList.remove("saved");
    });
  }
  dom.downloadSubfolderInput.addEventListener("input", () => {
    state.config.downloadSubfolder = dom.downloadSubfolderInput.value;
    renderPickedFolderState();
  });

  // Save settings form
  dom.settingsForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await saveConfigToStorage();
      checkStrictValidationGate();
    } catch (err) {
      showValidationBanner(`Failed to save settings: ${err.message || String(err)}`);
    }
  });

  // Chat attachment file picker & drag-and-drop
  dom.attachImageBtn.addEventListener("click", () => dom.chatAttachmentInput.click());
  dom.chatAttachmentInput.addEventListener("change", async (e) => {
    await handleAttachFiles(e.target.files);
    dom.chatAttachmentInput.value = "";
  });

  dom.chatDropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dom.chatDropZone.classList.add("drag-over");
  });
  dom.chatDropZone.addEventListener("dragleave", () => {
    dom.chatDropZone.classList.remove("drag-over");
  });
  dom.chatDropZone.addEventListener("drop", async (e) => {
    e.preventDefault();
    dom.chatDropZone.classList.remove("drag-over");
    if (e.dataTransfer?.files?.length) {
      await handleAttachFiles(e.dataTransfer.files);
    }
  });

  dom.clearChatBtn.addEventListener("click", () => {
    state.chatHistory = [];
    dom.chatMessages.innerHTML = "";
    appendChatMessage("system", "Chat history cleared.");
  });

  dom.sendChatBtn.addEventListener("click", () => handleSendChat());
  dom.generatePromptsBtn.addEventListener("click", () => handleGeneratePrompts());

  dom.chatInputTextarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleGeneratePrompts();
    }
  });

  // Queue controls
  dom.startQueueBtn.addEventListener("click", () => handleStartQueue());
  dom.pauseQueueBtn.addEventListener("click", () => handlePauseQueue());
  dom.clearQueueBtn.addEventListener("click", () => handleClearQueue());

  // Lightbox Modal
  dom.closeModalBtn.addEventListener("click", () => closeImageModal());
  dom.imageModal.addEventListener("click", (e) => {
    if (e.target === dom.imageModal) closeImageModal();
  });
}

// Initialize Side Panel
(async function initSidePanel() {
  bindEvents();
  state.directoryHandle = await loadDirectoryHandleFromIdb();
  await loadConfigFromStorage();
  renderQueueTable();
})();
