/**
 * Flow Sidecar Orchestrator - Synthetic DOM Actions (`content/dom-actions.js`)
 * Implements Virtual DOM native prototype input injection, synthetic DataTransfer
 * Img2Img uploads, programmatic aspect ratio & model selection, and MutationObserver
 * completion detection + base64 image extraction.
 */

(function initFlowDomActions(globalScope) {
  const {
    FLOW_SELECTORS,
    isElementVisible,
    queryAllDeep,
    queryFirstVisible,
    findButtonByMatIcon,
    findComposerContainer,
    findSubmitButton,
    findComposerSettingsButton,
    queryCandidateOutputs
  } = globalScope.FlowDomSelectors;

  let lastAppliedFlowParams = {
    aspectRatio: null,
    targetModel: null,
    imagesPerPrompt: null
  };

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Dispatches a realistic pointer + mouse + click sequence on a target button so frameworks
   * listening to PointerEvents or MouseEvents respond reliably.
   * @param {HTMLElement} el
   */
  function simulateRealClick(el) {
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;
    const eventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX,
      clientY,
      button: 0,
      buttons: 1
    };

    el.dispatchEvent(new PointerEvent("pointerdown", eventInit));
    el.dispatchEvent(new MouseEvent("mousedown", eventInit));
    el.dispatchEvent(new PointerEvent("pointerup", { ...eventInit, buttons: 0 }));
    el.dispatchEvent(new MouseEvent("mouseup", { ...eventInit, buttons: 0 }));
    el.click();
  }

  /**
   * 1. Virtual DOM Input Injection:
   * Bypasses React/Vue/Lit synthetic event suppression by invoking the native prototype
   * `.value` property setter on `HTMLTextAreaElement.prototype` or `HTMLInputElement.prototype`
   * followed by dispatching bubbling `input` and `change` events.
   *
   * @param {string} promptText
   * @returns {HTMLElement}
   */
  function injectPromptText(promptText) {
    const inputEl = queryFirstVisible(FLOW_SELECTORS.promptInput);
    if (!inputEl) {
      throw new Error(
        "Could not locate the Flow prompt input element. Make sure the Google Labs Flow workspace is open."
      );
    }

    inputEl.focus();

    if (inputEl instanceof HTMLTextAreaElement) {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value"
      )?.set;
      if (nativeSetter) {
        nativeSetter.call(inputEl, promptText);
      } else {
        inputEl.value = promptText;
      }
    } else if (inputEl instanceof HTMLInputElement) {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )?.set;
      if (nativeSetter) {
        nativeSetter.call(inputEl, promptText);
      } else {
        inputEl.value = promptText;
      }
    } else if (inputEl.isContentEditable) {
      // Support contenteditable / Slate / ProseMirror rich text prompt boxes
      try {
        document.execCommand("selectAll", false, null);
        document.execCommand("insertText", false, promptText);
      } catch (_) {
        inputEl.textContent = promptText;
      }
      if ((inputEl.textContent || "").trim() !== promptText.trim()) {
        inputEl.textContent = promptText;
      }
      // Dispatch beforeinput for Slate.js / Lexical editors
      try {
        inputEl.dispatchEvent(
          new InputEvent("beforeinput", {
            bubbles: true,
            cancelable: true,
            inputType: "insertText",
            data: promptText
          })
        );
      } catch (_) {
        // ignore if unsupported
      }
    }

    inputEl.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: promptText
      })
    );
    inputEl.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
    inputEl.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: " " }));

    return inputEl;
  }

  /**
   * Converts a base64 Data URL into a browser `File` instance for synthetic `DataTransfer`.
   * @param {string} dataUrl
   * @param {string} [filename="reference.png"]
   * @returns {File}
   */
  function dataUrlToFile(dataUrl, filename = "reference.png") {
    const parts = dataUrl.split(",");
    if (parts.length < 2) {
      throw new Error("Invalid base64 Data URL for Img2Img upload.");
    }
    const mimeMatch = /^data:([^;]+);base64$/i.exec(parts[0]);
    const mimeType = mimeMatch ? mimeMatch[1] : "image/png";
    const binaryStr = atob(parts[1]);
    const len = binaryStr.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    return new File([bytes], filename, { type: mimeType, lastModified: Date.now() });
  }

  /* ------------------------------------------------------------------------
   * 2. Reference images ("ingredients") for Flow's image-to-image
   *
   * Verified on Flow (Nov 2026):
   * - Attached references show as `<flow-image-ingredient-chip>` (button[aria-label="Ingredient"])
   *   in the prompt box; `aria-busy="true"` while uploading. Clicking a chip removes it.
   * - Uploading: dragging files over the prompt box (`flow-prompt-box`) switches it into a drop
   *   zone ("Add reference", `flow-prompt-box-drop-zone-slot`); dropping there uploads the file
   *   AND attaches it in one go. Synthetic drag events with a DataTransfer are accepted.
   *   ("Upload media" in the + picker opens the OS file dialog, which we can't fill.)
   * - Existing project media (e.g. images Flow generated) are picked from the + picker
   *   (`button[aria-label="Add ingredients to the prompt box"]` → `flow-add-menu-popover-content`):
   *   click the `button[role="option"]` whose thumbnail URL contains `/asb/<assetId>`, then
   *   `button.detail-add-to-prompt-btn`. Grid images use the same `/asb/<assetId>` URLs.
   * ---------------------------------------------------------------------- */

  /** @returns {HTMLElement[]} */
  function getIngredientChips() {
    return /** @type {HTMLElement[]} */ (
      queryAllDeep('flow-image-ingredient-chip button, button.chip-container[aria-label="Ingredient"]')
    );
  }

  function areIngredientsUploading() {
    return getIngredientChips().some((b) => b.getAttribute("aria-busy") === "true");
  }

  /**
   * Extracts Flow's media asset ID from an image URL like `https://flow.google.com/asb/<id>=s512-rw`.
   * @param {string} src
   * @returns {string|null}
   */
  function getFlowAssetIdFromSrc(src) {
    const match = /\/asb\/([^=?#/]+)/.exec(src || "");
    return match ? match[1] : null;
  }

  /**
   * Waits until the chip count reaches `target` and no chip is still uploading.
   * @returns {Promise<boolean>}
   */
  async function waitForIngredientCount(target, timeoutMs = 45000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (getIngredientChips().length >= target && !areIngredientsUploading()) return true;
      await sleep(250);
    }
    return false;
  }

  /** Removes all reference chips currently attached to the prompt box. */
  async function clearIngredientChips() {
    for (let attempt = 0; attempt < 3 && getIngredientChips().length > 0; attempt++) {
      for (const chip of getIngredientChips()) {
        simulateRealClick(chip);
        await sleep(200);
      }
      await sleep(250);
    }
    if (getIngredientChips().length > 0) {
      throw new Error("Could not remove the reference images left in Flow's prompt box.");
    }
  }

  /**
   * Uploads and attaches an image by dropping it onto the prompt box's "Add reference" zone.
   * @param {string} dataUrl
   * @param {string} filename
   * @returns {Promise<boolean>}
   */
  async function attachReferenceByDrop(dataUrl, filename) {
    const before = getIngredientChips().length;
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(dataUrlToFile(dataUrl, filename));

    const fire = (target, type) => {
      const r = target.getBoundingClientRect();
      target.dispatchEvent(
        new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          dataTransfer,
          clientX: r.left + r.width / 2,
          clientY: r.top + r.height / 2
        })
      );
    };

    const promptBox =
      document.querySelector("flow-prompt-box") ||
      findComposerContainer(queryFirstVisible(FLOW_SELECTORS.promptInput)) ||
      document.body;
    fire(promptBox, "dragenter");
    fire(promptBox, "dragover");

    let slot = null;
    for (let i = 0; i < 15 && !slot; i++) {
      await sleep(100);
      slot =
        /** @type {HTMLElement|null} */ (document.querySelector("flow-prompt-box-drop-zone-slot")) ||
        /** @type {HTMLElement|null} */ (document.querySelector("flow-prompt-box-drop-zone"));
      if (slot && !isElementVisible(slot)) slot = null;
    }
    const target = slot || promptBox;
    fire(target, "dragenter");
    fire(target, "dragover");
    await sleep(80);
    fire(target, "drop");

    const ok = await waitForIngredientCount(before + 1);
    if (!ok) {
      // Make sure Flow leaves its drag overlay
      fire(target, "dragleave");
      fire(promptBox, "dragleave");
      document.dispatchEvent(new DragEvent("dragend", { bubbles: true }));
    }
    return ok;
  }

  /**
   * Attaches an existing project asset (e.g. a previously generated image) via the + picker.
   * @param {string} assetId
   * @returns {Promise<boolean>}
   */
  async function attachProjectAsset(assetId) {
    const before = getIngredientChips().length;
    const opener = document.querySelector('button[aria-label="Add ingredients to the prompt box"]');
    if (!(opener instanceof HTMLElement)) return false;
    simulateRealClick(opener);

    let picker = null;
    for (let i = 0; i < 20 && !picker; i++) {
      await sleep(150);
      picker = document.querySelector("flow-add-menu-popover-content");
    }
    if (!picker) return false;

    const closePicker = async () => {
      if (!document.querySelector("flow-add-menu-popover-content")) return;
      (document.activeElement || document.body).dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Escape", code: "Escape" })
      );
      await sleep(200);
      const backdrop = document.querySelector(".cdk-overlay-backdrop");
      if (backdrop instanceof HTMLElement && isElementVisible(backdrop)) backdrop.click();
      await sleep(150);
    };

    // Find the option by asset ID, scrolling the (possibly lazy-loaded) list if needed
    let option = null;
    for (let page = 0; page < 12 && !option; page++) {
      option = Array.from(picker.querySelectorAll('button[role="option"]')).find((o) => {
        const img = o.querySelector("img");
        return img && getFlowAssetIdFromSrc(img.currentSrc || img.src) === assetId;
      });
      if (option) break;
      const options = picker.querySelectorAll('button[role="option"]');
      const last = options[options.length - 1];
      if (!last) break;
      last.scrollIntoView({ block: "end" });
      await sleep(350);
    }
    if (!option) {
      await closePicker();
      return false;
    }

    simulateRealClick(/** @type {HTMLElement} */ (option));
    await sleep(350);
    const addBtn = picker.querySelector("button.detail-add-to-prompt-btn");
    if (addBtn instanceof HTMLElement && document.contains(addBtn)) {
      simulateRealClick(addBtn);
    }
    const ok = await waitForIngredientCount(before + 1, 15000);
    await closePicker();
    return ok;
  }

  /** Opens Flow's + asset picker and returns its root element (or null). */
  async function openAssetPicker() {
    const existing = document.querySelector("flow-add-menu-popover-content");
    if (existing) return /** @type {HTMLElement} */ (existing);
    const opener = document.querySelector('button[aria-label="Add ingredients to the prompt box"]');
    if (!(opener instanceof HTMLElement)) return null;
    simulateRealClick(opener);
    for (let i = 0; i < 20; i++) {
      await sleep(150);
      const picker = document.querySelector("flow-add-menu-popover-content");
      if (picker) return /** @type {HTMLElement} */ (picker);
    }
    return null;
  }

  async function closeAssetPicker() {
    if (!document.querySelector("flow-add-menu-popover-content")) return;
    (document.activeElement || document.body).dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "Escape", code: "Escape" })
    );
    await sleep(200);
    const backdrop = document.querySelector(".cdk-overlay-backdrop");
    if (backdrop instanceof HTMLElement && isElementVisible(backdrop)) backdrop.click();
    await sleep(150);
  }

  /**
   * Fetches a Flow media image (same-origin, uses the page's session) at the given size as a Data URL.
   * @param {string} baseUrl Image URL without the `=s…` size suffix, e.g. `https://flow.google.com/asb/<id>`
   * @param {number} size Longest side in pixels
   */
  async function fetchFlowImageAsDataUrl(baseUrl, size) {
    const resp = await fetch(`${baseUrl}=s${size}`, { credentials: "include" });
    if (!resp.ok) throw new Error(`Flow image request failed (${resp.status}).`);
    const blob = await resp.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(/** @type {string} */ (reader.result));
      reader.onerror = () => reject(reader.error || new Error("Could not read Flow image."));
      reader.readAsDataURL(blob);
    });
  }

  /**
   * Lists the images in the current Flow project (generated images and uploads) via the + picker,
   * with small thumbnails, so the side panel can offer them as references.
   * @param {{limit?: number}} [options]
   * @returns {Promise<Array<{assetId: string, name: string, baseUrl: string, thumbDataUrl: string|null}>>}
   */
  async function listProjectImages({ limit = 80 } = {}) {
    const picker = await openAssetPicker();
    if (!picker) {
      throw new Error("Could not open Flow's media picker. Open a Flow project and close any open dialogs.");
    }
    try {
      // Make sure the "All" category is shown
      const allTab = Array.from(picker.querySelectorAll("button")).find((b) =>
        /^\s*(dashboard\s*)?All\s*$/i.test(b.textContent || "")
      );
      if (allTab instanceof HTMLElement) {
        simulateRealClick(allTab);
        await sleep(400);
      }

      /** @type {Map<string, {assetId: string, name: string, baseUrl: string}>} */
      const found = new Map();
      let unchangedPages = 0;
      for (let page = 0; page < 25 && unchangedPages < 2 && found.size < limit; page++) {
        const before = found.size;
        for (const option of picker.querySelectorAll('button[role="option"]')) {
          const img = option.querySelector("img");
          const src = img ? img.currentSrc || img.src : "";
          const assetId = getFlowAssetIdFromSrc(src);
          if (!assetId || found.has(assetId)) continue;
          // Skip videos / voices (they have a media-type icon on the thumbnail)
          const icons = Array.from(option.querySelectorAll("mat-icon")).map((i) => (i.textContent || "").trim());
          if (icons.some((t) => /video|videocam|movie|play_arrow|play_circle|mic|voice|graphic_eq/i.test(t))) continue;
          const name =
            (option.querySelector(".asset-title")?.textContent || option.textContent || "Flow image")
              .replace(/\s+/g, " ")
              .trim();
          found.set(assetId, { assetId, name, baseUrl: src.replace(/=[^/]*$/, "") });
        }
        unchangedPages = found.size === before ? unchangedPages + 1 : 0;
        const options = picker.querySelectorAll('button[role="option"]');
        const last = options[options.length - 1];
        if (!last) break;
        last.scrollIntoView({ block: "end" });
        await sleep(400);
      }

      // Thumbnails (6 at a time)
      const items = Array.from(found.values()).slice(0, limit);
      const results = [];
      for (let i = 0; i < items.length; i += 6) {
        const batch = items.slice(i, i + 6);
        const thumbs = await Promise.all(
          batch.map((it) => fetchFlowImageAsDataUrl(it.baseUrl, 256).catch(() => null))
        );
        batch.forEach((it, idx) => results.push({ ...it, thumbDataUrl: thumbs[idx] }));
      }
      return results;
    } finally {
      await closeAssetPicker();
    }
  }

  /**
   * Clears old references and attaches the given ones to Flow's prompt box, verifying each.
   * Each reference is `{dataUrl?, name?, assetId?}`: `assetId` (a Flow project image) is picked
   * from the + picker; otherwise (or if that fails) `dataUrl` is uploaded by drag-and-drop.
   *
   * @param {Array<{dataUrl?: string, name?: string, assetId?: string}>} references
   * @returns {Promise<number>} number of references attached
   */
  async function attachReferenceImages(references = []) {
    await clearIngredientChips();
    const refs = (Array.isArray(references) ? references : []).filter((r) => r && (r.assetId || r.dataUrl));
    let attached = 0;

    for (const [index, ref] of refs.entries()) {
      const label = ref.name || `reference ${index + 1}`;
      let ok = false;
      if (ref.assetId) {
        ok = await attachProjectAsset(ref.assetId);
        if (!ok) console.warn(`[FlowSidecar] References: "${label}" not found in the project picker; uploading it instead.`);
      }
      if (!ok && ref.dataUrl) {
        const ext = /^data:image\/(png|jpe?g|webp|gif)/i.exec(ref.dataUrl)?.[1]?.replace("jpeg", "jpg") || "png";
        ok = await attachReferenceByDrop(ref.dataUrl, `sidecar-ref-${Date.now()}-${index + 1}.${ext}`);
      }
      if (!ok) {
        throw new Error(`Could not attach reference image "${label}" in Flow.`);
      }
      attached++;
      console.debug("[FlowSidecar] References: attached", label, `(${attached}/${refs.length})`);
    }

    if (getIngredientChips().length !== attached) {
      throw new Error(
        `Flow shows ${getIngredientChips().length} reference image(s) but ${attached} were expected.`
      );
    }
    return attached;
  }

  /**
   * Finds the "Agent settings" container panel when Flow's composer switches into settings mode.
   * @returns {HTMLElement|null}
   */
  function findAgentSettingsPanel() {
    const view = document.querySelector("flow-settings-view");
    if (view && isElementVisible(view)) return /** @type {HTMLElement} */ (view);

    const headings = queryAllDeep("h1, h2, h3, div, span, p");
    for (const el of headings) {
      if (!isElementVisible(el)) continue;
      const txt = (el.textContent || "").trim();
      if (txt === "Agent settings" || txt === "Image generation default") {
        let curr = el.parentElement;
        for (let depth = 0; depth < 7 && curr && curr !== document.body; depth++) {
          const text = (curr.textContent || "").trim();
          if (text.includes("Image generation default") && text.includes("Save")) {
            return curr;
          }
          curr = curr.parentElement;
        }
      }
    }
    return null;
  }

  /**
   * Finds the FIRST matching control inside `root` (e.g. Image generation default comes
   * before Video generation default, so picking the first match targets Image settings).
   * @param {string} targetText
   * @param {ParentNode} root
   * @returns {HTMLElement|null}
   */
  const ICON_SELECTOR = "mat-icon, .google-symbols, .material-icons, .material-symbols-outlined, i";
  const OPTION_SELECTOR =
    'button, [role="button"], [role="radio"], [role="option"], [role="menuitem"], [role="menuitemradio"], [role="tab"], [role="combobox"], [role="checkbox"], [role="switch"], select';

  /**
   * Returns the element that actually handles clicks: Angular Material wrappers such as
   * `<mat-button-toggle>` ignore clicks on the host; only their inner `<button>` reacts.
   * @param {HTMLElement} el
   * @returns {HTMLElement}
   */
  function toClickableControl(el) {
    if (el.matches('button, [role="radio"], [role="button"], [role^="menuitem"], [role="option"], select')) {
      return el;
    }
    return /** @type {HTMLElement} */ (el.querySelector('button, [role="radio"], [role="button"]') || el);
  }

  /**
   * Visible label of a control with Material icon ligature text removed
   * (e.g. `<mat-icon>crop_16_9</mat-icon> 16:9` → "16:9", `<mat-icon>check</mat-icon> Save` → "save").
   * @param {Element} el
   * @returns {string}
   */
  function getControlLabel(el) {
    let text = "";
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const icon = node.parentElement && node.parentElement.closest(ICON_SELECTOR);
      if (icon && icon !== el && el.contains(icon)) {
        continue; // skip icon ligature text inside the control
      }
      text += ` ${node.nodeValue}`;
    }
    return text.replace(/\s+/g, " ").trim().toLowerCase();
  }

  /**
   * Finds the FIRST matching control inside `root` (e.g. Image generation default comes
   * before Video generation default, so picking the first match targets Image settings).
   * Short targets ("16:9", "x2", "Save") must match the label exactly or as a whole word, so
   * "x1" never matches "x10" and "1:1" never matches "21:1"; longer targets (model names) may
   * match partially.
   * @param {string} targetText
   * @param {ParentNode} root
   * @returns {HTMLElement|null}
   */
  function findFirstOptionInRoot(targetText, root) {
    if (!targetText || !targetText.trim() || !root) return null;
    const normalized = targetText.trim().toLowerCase();
    const requireExact = normalized.length <= 4;
    const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const wholeWord = new RegExp(`(^|[\\s(\\[·•|,/])${escaped}($|[\\s)\\]·•|,/])`, "i");

    const candidates = queryAllDeep(OPTION_SELECTOR, root);

    // Prefer an exact label match anywhere in root, then fall back to whole-word / partial.
    let fallback = null;
    for (const el of candidates) {
      if (!isElementVisible(el)) continue;
      const label = getControlLabel(el);
      const aria = (el.getAttribute("aria-label") || "").trim().toLowerCase();
      const value = (el.getAttribute("data-value") || el.getAttribute("value") || "")
        .trim()
        .toLowerCase();

      if (label === normalized || aria === normalized || value === normalized) {
        return toClickableControl(/** @type {HTMLElement} */ (el));
      }
      if (fallback) continue;
      const isLooseMatch = requireExact
        ? wholeWord.test(label) || wholeWord.test(aria)
        : label.includes(normalized) || aria.includes(normalized);
      if (isLooseMatch) {
        fallback = /** @type {HTMLElement} */ (el);
      }
    }
    return fallback ? toClickableControl(fallback) : null;
  }

  /**
   * Lists visible control labels inside `root` (for diagnostics when a setting is not found).
   * @param {ParentNode} root
   * @returns {string[]}
   */
  function listControlLabels(root) {
    return queryAllDeep(OPTION_SELECTOR, root)
      .filter((el) => isElementVisible(el))
      .map((el) => getControlLabel(el) || `[aria] ${el.getAttribute("aria-label") || ""}`)
      .slice(0, 40);
  }

  /**
   * Finds a matching control inside currently open popovers/menus/dialogs (strictly scoped,
   * never clicking top-bar or sidebar navigation).
   * @param {string} targetText
   * @returns {HTMLElement|null}
   */
  function findOptionInOpenPopovers(targetText) {
    if (!targetText || !targetText.trim()) return null;
    const openMenus = queryAllDeep(
      '[role="menu"], [role="listbox"], [role="dialog"], [data-state="open"], [data-radix-popper-content-wrapper]'
    );

    for (const menu of openMenus) {
      if (!isElementVisible(menu)) continue;
      const match = findFirstOptionInRoot(targetText, menu);
      if (match) return match;
    }
    return null;
  }

  /**
   * Returns the `.settings-section` whose label is "Image generation default".
   * @param {HTMLElement} panel
   * @returns {HTMLElement|null}
   */
  function findImageGenerationSection(panel) {
    const labels = queryAllDeep(".settings-section-label, span, p, div", panel);
    for (const label of labels) {
      if (label.childElementCount === 0 && (label.textContent || "").trim() === "Image generation default") {
        return /** @type {HTMLElement} */ (label.closest(".settings-section") || label.parentElement);
      }
    }
    return null;
  }

  /** Lowercases and strips emoji / punctuation so "🍌 Nano Banana 2.1" → "nano banana 2.1". */
  function normalizeModelName(text) {
    return (text || "")
      .toLowerCase()
      .replace(/arrow_drop_down|expand_more|check/g, " ")
      .replace(/[^a-z0-9.\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** @param {Element} el */
  function isToggleSelected(el) {
    return (
      el.getAttribute("aria-checked") === "true" ||
      el.getAttribute("aria-pressed") === "true" ||
      Boolean(el.closest(".mat-button-toggle-checked"))
    );
  }

  /**
   * Selects a toggle (aspect ratio tile / x1–x4) by its label inside `root` and verifies it.
   * @param {ParentNode} root
   * @param {string} labelText
   * @returns {Promise<boolean>}
   */
  async function selectToggleOption(root, labelText) {
    const option = findFirstOptionInRoot(labelText, root);
    if (!option) return false;
    if (isToggleSelected(option)) return true;
    simulateRealClick(option);
    for (let i = 0; i < 8; i++) {
      await sleep(80);
      if (isToggleSelected(option)) return true;
    }
    console.warn(`[FlowSidecar] Settings: clicked "${labelText}" but it did not become selected.`);
    return false;
  }

  /**
   * Picks the image model from the "Image generation default" model menu. Matches the model
   * name exactly (ignoring the emoji), so "Nano Banana" never selects "Nano Banana Pro".
   * @param {ParentNode} root
   * @param {string} modelName
   * @returns {Promise<boolean>}
   */
  async function selectImageModel(root, modelName) {
    const target = normalizeModelName(modelName);
    const trigger =
      /** @type {HTMLElement|undefined} */ (
        queryAllDeep('button[aria-label*="model" i], button.image-model-picker-button', root).find((b) =>
          isElementVisible(b)
        ) ||
        queryAllDeep('button[aria-haspopup="menu"], button[aria-haspopup="listbox"], mat-select', root).find((b) =>
          isElementVisible(b)
        )
      );
    if (!trigger) return false;
    if (normalizeModelName(getControlLabel(trigger)) === target) return true;

    simulateRealClick(trigger);
    let items = [];
    for (let i = 0; i < 10 && items.length === 0; i++) {
      await sleep(100);
      items = queryAllDeep('[role="menu"] [role^="menuitem"], [role="listbox"] [role="option"]').filter((el) =>
        isElementVisible(el)
      );
    }

    const match = items.find((el) => normalizeModelName(getControlLabel(el)) === target);
    if (!match) {
      console.warn(`[FlowSidecar] Settings: model "${modelName}" is not offered by Flow.`, {
        available: items.map((el) => getControlLabel(el))
      });
      // Close the menu without changing the model
      const escTarget = document.activeElement || document.body;
      escTarget.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape", code: "Escape" }));
      await sleep(150);
      const backdrop = document.querySelector(".cdk-overlay-backdrop");
      if (backdrop instanceof HTMLElement && isElementVisible(backdrop)) {
        backdrop.click();
        await sleep(150);
      }
      return false;
    }

    simulateRealClick(match);
    for (let i = 0; i < 8; i++) {
      await sleep(80);
      if (normalizeModelName(getControlLabel(trigger)) === target) return true;
    }
    return normalizeModelName(getControlLabel(trigger)) === target;
  }

  /**
   * Exits the "← Agent settings" view by clicking "Save" (preferred) or the "←" back button,
   * returning Flow back to the prompt composer view.
   * @param {HTMLElement|null} settingsPanel
   */
  async function exitAgentSettingsPanel(settingsPanel) {
    const scope = settingsPanel || document;
    const saveBtn =
      /** @type {HTMLElement|null} */ (document.querySelector("button.settings-save-button")) ||
      findFirstOptionInRoot("Save", scope) ||
      findFirstOptionInRoot("Save", document);
    if (!saveBtn) {
      console.warn("[FlowSidecar] Settings: Save button not found.", {
        availableControls: listControlLabels(scope)
      });
    } else if (saveBtn.hasAttribute("disabled") || saveBtn.getAttribute("aria-disabled") === "true") {
      console.debug("[FlowSidecar] Settings: Save is disabled (nothing changed).");
    } else {
      simulateRealClick(saveBtn);
      await sleep(320);
    }

    // If still in Agent settings (e.g. Save didn't close because settings were already matching), click "←" (arrow_back)
    if (findAgentSettingsPanel()) {
      const matBackBtn =
        findButtonByMatIcon(["arrow_back", "west", "keyboard_backspace", "close"], scope) ||
        findButtonByMatIcon(["arrow_back", "west", "keyboard_backspace", "close"], document);

      if (matBackBtn) {
        simulateRealClick(matBackBtn);
        await sleep(320);
      } else {
        const backCandidates = queryAllDeep('button, [role="button"]', scope).filter((b) => {
          if (!isElementVisible(b)) return false;
          const label = `${b.getAttribute("aria-label") || ""} ${b.textContent || ""}`.toLowerCase();
          return /\b(back|arrow_back|close)\b|←/.test(label);
        });
        if (backCandidates.length > 0) {
          simulateRealClick(backCandidates[0]);
          await sleep(320);
        }
      }
    }

    // Wait up to 1.5s for the prompt composer and `<mat-icon>arrow_forward</mat-icon>` to re-mount
    for (let i = 0; i < 12; i++) {
      const promptReady = queryFirstVisible(FLOW_SELECTORS.promptInput);
      const arrowReady = findButtonByMatIcon(["arrow_forward", "send", "arrow_upward"]);
      if (promptReady && arrowReady) {
        break;
      }
      await sleep(120);
    }
  }

  /**
   * 3. Aspect Ratio, Model & Images-per-Prompt Selection:
   * Opens the Flow composer's own Sliders/Settings button (inside the prompt box next to `→`),
   * applies Aspect Ratio, Images per Prompt (`x1`–`x4`), and Target Model under "Image generation default",
   * and clicks `Save` (or `←` arrow_back) to return to the prompt composer before submitting.
   *
   * @param {object} options
   * @param {string} [options.aspectRatio]
   * @param {string} [options.targetModel]
   * @param {number} [options.imagesPerPrompt=1]
   * @param {HTMLElement} [options.promptEl]
   */
  async function applyFlowParameters({ aspectRatio, targetModel, imagesPerPrompt = 1, promptEl }) {
    const clampedCount = Math.min(4, Math.max(1, Math.round(Number(imagesPerPrompt) || 1)));
    const normRatio = (aspectRatio || "").trim();
    const normModel = (targetModel || "").trim();

    // Skip opening Agent settings if the exact same parameters were already applied in this tab session
    if (
      lastAppliedFlowParams.project === location.pathname &&
      lastAppliedFlowParams.aspectRatio === normRatio &&
      lastAppliedFlowParams.targetModel === normModel &&
      lastAppliedFlowParams.imagesPerPrompt === clampedCount
    ) {
      return;
    }

    const composerSettingsBtn = findComposerSettingsButton(promptEl);
    if (!composerSettingsBtn) {
      console.warn("[FlowSidecar] Settings: could not find the composer settings (tune) button.");
      return;
    }

    // Open the composer's own settings view ONCE
    simulateRealClick(composerSettingsBtn);

    // Wait up to ~1.5s for the Agent settings panel to mount
    let settingsPanel = null;
    for (let i = 0; i < 10 && !settingsPanel; i++) {
      await sleep(150);
      settingsPanel = findAgentSettingsPanel();
    }
    if (!settingsPanel) {
      console.warn("[FlowSidecar] Settings: Agent settings panel did not open; searching open popovers only.");
    }
    // Restrict everything to the "Image generation default" section so the Video defaults
    // (which also have 16:9 / x1–x4 / a model picker) are never touched.
    const imageSection = settingsPanel ? findImageGenerationSection(settingsPanel) : null;
    const searchScope = imageSection || settingsPanel || document;
    const missing = [];

    try {
      // 1. Aspect Ratio
      if (normRatio && !(await selectToggleOption(searchScope, normRatio))) {
        missing.push(`aspect ratio "${normRatio}"`);
      }

      // 2. Images per Prompt (x1, x2, x3, x4)
      if (!(await selectToggleOption(searchScope, `x${clampedCount}`))) {
        missing.push(`images per prompt "x${clampedCount}"`);
      }

      // 3. Target Image Model (dropdown menu: "🍌 Nano Banana 2.1 ▾")
      if (normModel && !(await selectImageModel(searchScope, normModel))) {
        missing.push(`model "${normModel}"`);
      }

      // Only remember these settings as applied if every control was actually found, otherwise
      // a single miss would make every later step in this tab skip the settings entirely.
      if (missing.length === 0) {
        lastAppliedFlowParams = {
          project: location.pathname,
          aspectRatio: normRatio,
          targetModel: normModel,
          imagesPerPrompt: clampedCount
        };
        console.debug("[FlowSidecar] Settings applied:", lastAppliedFlowParams);
      } else {
        lastAppliedFlowParams = { aspectRatio: null, targetModel: null, imagesPerPrompt: null };
        console.warn("[FlowSidecar] Settings: could not find", missing.join(", "), {
          panelFound: Boolean(settingsPanel),
          availableControls: listControlLabels(searchScope)
        });
      }
    } finally {
      // Always click Save / arrow_back to exit Agent settings and restore the prompt composer
      await exitAgentSettingsPanel(settingsPanel);
    }
  }

  /**
   * Computes a unique signature for an output image or canvas element so we can detect newly added outputs.
   * @param {HTMLImageElement|HTMLCanvasElement} el
   * @returns {string}
   */
  function getOutputSignature(el) {
    if (el instanceof HTMLImageElement) {
      return `img:${el.currentSrc || el.src || ""}`;
    }
    if (el instanceof HTMLCanvasElement) {
      try {
        return `canvas:${el.width}x${el.height}:${el.toDataURL("image/png").slice(0, 96)}`;
      } catch (_) {
        return `canvas:${el.width}x${el.height}`;
      }
    }
    return "";
  }

  /**
   * Upgrades Google-hosted image URLs (`googleusercontent.com` / `ggpht.com`) to request
   * the full original resolution (`=s0`) instead of a grid thumbnail size (`=w512`, `=s400`, etc.).
   * @param {string} src
   * @returns {string}
   */
  function getFullResImageUrl(src) {
    if (!src || typeof src !== "string") return src;
    if (/googleusercontent\.com|ggpht\.com/i.test(src)) {
      if (/=[whs]\d+[^/?#]*$/i.test(src)) {
        return src.replace(/=[whs]\d+[^/?#]*$/i, "=s0");
      }
    }
    return src;
  }

  /**
   * Re-encodes any image Data URL (e.g. `image/webp`) into high-quality JPEG (`image/jpeg`, quality 0.95)
   * so downloaded files are never saved as WebP.
   * @param {string} rawDataUrl
   * @param {number} [quality=0.95]
   * @returns {Promise<string>}
   */
  function convertDataUrlToJpeg(rawDataUrl, quality = 0.95) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        if (!w || !h) {
          resolve(rawDataUrl);
          return;
        }
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          resolve(rawDataUrl);
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        try {
          resolve(canvas.toDataURL("image/jpeg", quality));
        } catch (_) {
          resolve(rawDataUrl);
        }
      };
      img.onerror = () => reject(new Error("Failed to decode image for JPEG conversion."));
      img.src = rawDataUrl;
    });
  }

  /**
   * Clicks a newly generated grid image card to open Flow's full-resolution detail view,
   * triggers Flow's own native Download button (which downloads the exact native `.jpg`),
   * captures a preview Data URL for the Side Panel thumbnail & Vision Critique,
   * and closes out of the detail view back to the project composer before the next prompt.
   *
   * @param {HTMLImageElement|HTMLCanvasElement} gridEl
   * @param {{upscaleDownload?: boolean}} [options]
   * @returns {Promise<{dataUrl: string, downloadedViaFlow: boolean}>}
   */
  async function captureFullResolutionFromCard(gridEl, { upscaleDownload = false } = {}) {
    if (!(gridEl instanceof HTMLImageElement)) {
      return {
        dataUrl: await convertElementToDataUrl(gridEl),
        downloadedViaFlow: false
      };
    }

    const gridArea = (gridEl.naturalWidth || 0) * (gridEl.naturalHeight || 0);
    const gridSrc = gridEl.currentSrc || gridEl.src || "";

    let bestDataUrl = null;
    let downloadedViaFlow = false;

    try {
      // 1. Open the image detail / lightbox view
      simulateRealClick(gridEl);
      await sleep(800);

      // 2. Capture preview Data URL from the opened full-size <img> (for Side Panel thumbnail & Vision Critique)
      const allImgs = queryAllDeep("img", document).filter((img) => {
        if (!(img instanceof HTMLImageElement) || !isElementVisible(img) || !img.complete) {
          return false;
        }
        const area = (img.naturalWidth || 0) * (img.naturalHeight || 0);
        const src = img.currentSrc || img.src || "";
        return area > gridArea && src !== gridSrc && (img.naturalWidth || 0) >= 512;
      });

      if (allImgs.length > 0) {
        allImgs.sort(
          (a, b) =>
            (b.naturalWidth || 0) * (b.naturalHeight || 0) -
            (a.naturalWidth || 0) * (a.naturalHeight || 0)
        );
        bestDataUrl = await convertElementToDataUrl(allImgs[0]);
      }

      // 3. Find and click Flow's own Download button inside the detail view
      let flowDownloadBtn = findButtonByMatIcon([
        "download",
        "file_download",
        "save_alt",
        "download_for_offline"
      ]);

      if (!flowDownloadBtn) {
        const downloadCandidates = queryAllDeep('button, a, [role="button"]', document).filter((b) => {
          if (!isElementVisible(b)) return false;
          const label = `${b.getAttribute("aria-label") || ""} ${b.getAttribute("title") || ""} ${
            b.textContent || ""
          }`.toLowerCase();
          return /\bdownload\b/.test(label);
        });
        if (downloadCandidates.length > 0) {
          flowDownloadBtn = /** @type {HTMLElement} */ (downloadCandidates[0]);
        }
      }

      if (flowDownloadBtn) {
        simulateRealClick(flowDownloadBtn);
        await sleep(350);

        // Flow's Download menu offers "1K · Original size", "2K · Upscaled" and "4K · Upscaled"
        // (4K needs a higher plan). Default to the original 1x size; upscale only when asked.
        const preferredOrder = upscaleDownload
          ? ["2K", "1K", "Original size", "Original", "Download"]
          : ["1K", "Original size", "Original", "Download"];
        let menuOption = null;
        for (const label of preferredOrder) {
          const candidate = findOptionInOpenPopovers(label);
          if (
            candidate &&
            !candidate.hasAttribute("disabled") &&
            candidate.getAttribute("aria-disabled") !== "true"
          ) {
            menuOption = candidate;
            break;
          }
        }
        if (menuOption) {
          console.debug("[FlowSidecar] Download option:", getControlLabel(menuOption));
          simulateRealClick(menuOption);
          await sleep(300);
        }

        downloadedViaFlow = true;
      }
    } catch (_) {
      // Fall back to grid element if lightbox interaction failed
    } finally {
      // 4. Always close out of the image detail view back to the project composer
      const closeBtn =
        findButtonByMatIcon(["close", "arrow_back", "west", "keyboard_backspace"]) ||
        queryAllDeep('button[aria-label*="close" i], button[aria-label*="back" i]', document).find((b) =>
          isElementVisible(b)
        );
      if (closeBtn) {
        simulateRealClick(closeBtn);
        await sleep(300);
      }

      // Ensure view is closed via Escape if prompt input is not yet visible
      if (!queryFirstVisible(FLOW_SELECTORS.promptInput)) {
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, key: "Escape", code: "Escape" })
        );
        await sleep(250);
      }

      // Wait up to 1.5s for the prompt composer to be visible again before returning
      for (let i = 0; i < 12 && !queryFirstVisible(FLOW_SELECTORS.promptInput); i++) {
        await sleep(125);
      }
    }

    if (!bestDataUrl) {
      bestDataUrl = await convertElementToDataUrl(gridEl);
    }

    return {
      dataUrl: bestDataUrl,
      downloadedViaFlow
    };
  }
   /**
   * Converts an `HTMLImageElement` or `HTMLCanvasElement` into a high-quality `data:image/jpeg;base64,...` Data URL,
   * preferring full-resolution (`=s0`) sources over grid thumbnails and converting away from WebP.
   * @param {HTMLImageElement|HTMLCanvasElement} el
   * @returns {Promise<string>}
   */
  async function convertElementToDataUrl(el) {
    if (el instanceof HTMLCanvasElement) {
      return el.toDataURL("image/jpeg", 0.95);
    }

    if (el instanceof HTMLImageElement) {
      const src = el.currentSrc || el.src;
      if (!src) {
        throw new Error("Generated image element has no src attribute.");
      }
      if (src.startsWith("data:image/")) {
        return src.startsWith("data:image/webp") ? await convertDataUrlToJpeg(src, 0.95) : src;
      }

      const candidateUrls = [];
      const fullResUrl = getFullResImageUrl(src);
      if (fullResUrl !== src) {
        candidateUrls.push(fullResUrl);
      }
      candidateUrls.push(src);

      // Try fetching the full-resolution image blob directly (works for blob:, data:, and CORS/host-permitted URLs)
      for (const targetUrl of candidateUrls) {
        try {
          const resp = await fetch(targetUrl);
          if (resp.ok) {
            const blob = await resp.blob();
            const rawDataUrl = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onloadend = () =>
                typeof reader.result === "string"
                  ? resolve(reader.result)
                  : reject(new Error("Empty FileReader result"));
              reader.onerror = () => reject(reader.error || new Error("FileReader error"));
              reader.readAsDataURL(blob);
            });
            return await convertDataUrlToJpeg(rawDataUrl, 0.95);
          }
        } catch (_) {
          // Try next candidate or fall back to canvas extraction
        }
      }

      // Canvas draw fallback using full natural dimensions
      const canvas = document.createElement("canvas");
      canvas.width = el.naturalWidth || el.width || 1024;
      canvas.height = el.naturalHeight || el.height || 1024;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        throw new Error("Could not create 2D canvas context to capture generated image.");
      }
      ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", 0.95);
    }

    throw new Error("Unsupported output element type.");
  }

  /**
   * Checks whether any of Flow's busy indicators or spinners are currently visible.
   * @returns {boolean}
   */
  function isFlowBusy() {
    const busyEl = queryFirstVisible(FLOW_SELECTORS.busyIndicators);
    return Boolean(busyEl);
  }

  /**
   * 4. Completion Detection:
   * Waits for Flow's busy indicators/spinners to clear and new `<img>` or `<canvas>` elements
   * (up to `expectedCount`) to attach and finish loading in the DOM, converting them to Data URLs.
   *
   * @param {Set<string>} baselineSignatures - Signatures of output elements present before submission
   * @param {number} [expectedCount=1] - Expected number of images (1-4)
   * @param {number} [timeoutMs=180000]
   * @returns {Promise<string[]>} Array of base64 Data URLs
   */
  async function waitForFlowCompletion(
    baselineSignatures,
    expectedCount = 1,
    timeoutMs = 180000,
    { upscaleDownload = false, skipFlowDownload = false } = {}
  ) {
    const targetCount = Math.min(4, Math.max(1, Math.round(Number(expectedCount) || 1)));
    const startTime = Date.now();
    let observedBusy = false;
    let firstImageDetectedAt = null;

    return new Promise((resolve, reject) => {
      let settled = false;
      let pollTimer = null;

      const cleanup = (observer) => {
        settled = true;
        if (pollTimer) clearInterval(pollTimer);
        if (observer) observer.disconnect();
      };

      const checkDomState = async (observer) => {
        if (settled) return;

        const currentlyBusy = isFlowBusy();
        if (currentlyBusy) {
          observedBusy = true;
        }

        // Wait at least 900ms after submit before accepting new outputs
        if (Date.now() - startTime < 900) {
          return;
        }

        const readyElements = [];
        const candidates = queryCandidateOutputs(128);
        for (const candidate of candidates) {
          if (
            candidate instanceof HTMLImageElement &&
            (!candidate.complete || (candidate.naturalWidth || 0) < 128)
          ) {
            continue;
          }

          const sig = getOutputSignature(candidate);
          if (sig && !baselineSignatures.has(sig)) {
            readyElements.push(candidate);
          }
        }

        if (readyElements.length > 0 && !firstImageDetectedAt) {
          firstImageDetectedAt = Date.now();
        }

        const allExpectedReady =
          readyElements.length >= targetCount &&
          firstImageDetectedAt &&
          Date.now() - firstImageDetectedAt >= 800;
        const settledAfterFirst =
          firstImageDetectedAt &&
          !currentlyBusy &&
          Date.now() - firstImageDetectedAt >= 2200;

        if (readyElements.length > 0 && (!currentlyBusy || observedBusy) && (allExpectedReady || settledAfterFirst)) {
          cleanup(observer);
          try {
            const dataUrls = [];
            const assetIds = [];
            let allDownloadedViaFlow = true;
            for (const el of readyElements.slice(0, targetCount)) {
              // Remember Flow's asset ID so the image can later be picked as a reference
              assetIds.push(
                el instanceof HTMLImageElement ? getFlowAssetIdFromSrc(el.currentSrc || el.src) : null
              );
              const src = el instanceof HTMLImageElement ? el.currentSrc || el.src : "";
              let res;
              if (skipFlowDownload && /\/asb\//.test(src)) {
                // Original image straight from Flow (`=s0`), no detail view and no file download
                try {
                  res = {
                    dataUrl: await fetchFlowImageAsDataUrl(src.replace(/=[^/]*$/, ""), 0),
                    downloadedViaFlow: false
                  };
                } catch (_) {
                  res = { dataUrl: await convertElementToDataUrl(el), downloadedViaFlow: false };
                }
              } else {
                res = await captureFullResolutionFromCard(el, { upscaleDownload });
              }
              dataUrls.push(res.dataUrl);
              if (!res.downloadedViaFlow) {
                allDownloadedViaFlow = false;
              }
            }
            resolve({ imageDataUrls: dataUrls, assetIds, downloadedViaFlow: allDownloadedViaFlow });
          } catch (err) {
            reject(err);
          }
          return;
        }

        if (Date.now() - startTime > timeoutMs) {
          cleanup(observer);
          reject(
            new Error(
              `Timed out after ${Math.round(
                timeoutMs / 1000
              )}s waiting for Flow image generation to complete.`
            )
          );
        }
      };

      const observer = new MutationObserver(() => {
        checkDomState(observer);
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src", "aria-busy", "class", "disabled"]
      });

      pollTimer = setInterval(() => {
        checkDomState(observer);
      }, 600);
    });
  }

  /**
   * Snapshots current output image/canvas signatures before triggering generation.
   * @returns {Set<string>}
   */
  function captureBaselineOutputSignatures() {
    const signatures = new Set();
    for (const el of queryCandidateOutputs(128)) {
      const sig = getOutputSignature(el);
      if (sig) signatures.add(sig);
    }
    return signatures;
  }

  /**
   * Checks whether the Flow submit (`arrow_forward`) button is still disabled or visually greyed out.
   * In Flow's dark UI, the button starts dark/greyed-out for ~1 second after prompt injection
   * before turning bright/clickable.
   *
   * @param {HTMLElement|null} btn
   * @returns {boolean}
   */
  function isSubmitButtonGreyedOut(btn) {
    if (!btn) return true;
    if (
      btn.hasAttribute("disabled") ||
      btn.getAttribute("aria-disabled") === "true" ||
      /\bdisabled\b/i.test(btn.className || "")
    ) {
      return true;
    }

    const style = window.getComputedStyle(btn);
    if (style.pointerEvents === "none" || style.cursor === "not-allowed" || style.cursor === "default") {
      if (parseFloat(style.opacity || "1") < 0.75) {
        return true;
      }
    }
    if (parseFloat(style.opacity || "1") < 0.55) {
      return true;
    }

    // Check background brightness of the circular button (or its immediate styled element)
    const bgMatch = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/i.exec(
      style.backgroundColor || ""
    );
    if (bgMatch) {
      const r = Number(bgMatch[1]);
      const g = Number(bgMatch[2]);
      const b = Number(bgMatch[3]);
      const a = bgMatch[4] !== undefined ? Number(bgMatch[4]) : 1;
      // When greyed out in dark mode, the circle has a dark grey fill (luminance < 95) or very low alpha
      const avg = (r + g + b) / 3;
      if (a > 0.1 && avg < 95) {
        return true;
      }
    }

    return false;
  }

  /**
   * Sends a message to the background service worker and resolves with its response
   * (never rejects; failures resolve as `{ok: false, error}`).
   * @param {object} message
   * @returns {Promise<{ok: boolean, [key: string]: any}>}
   */
  function sendToBackground(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (res) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(res || { ok: false });
          }
        });
      } catch (err) {
        resolve({ ok: false, error: String(err) });
      }
    });
  }

  /** @returns {HTMLElement|null} The currently mounted prompt input (Flow may re-mount it). */
  function getLivePromptEl(fallbackEl) {
    return queryFirstVisible(FLOW_SELECTORS.promptInput) || fallbackEl || null;
  }

  /** @param {HTMLElement|null} el */
  function readPromptText(el) {
    if (!el) return "";
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return el.value || "";
    return el.textContent || "";
  }

  /** @param {HTMLElement|null} btn */
  function getButtonIconName(btn) {
    if (!btn) return "";
    const icon = btn.querySelector("mat-icon, .google-symbols, .material-icons, i");
    return ((icon && icon.textContent) || "").trim().toLowerCase();
  }

  /**
   * Waits until `el`'s bounding box stops moving (layout settled after the debugger infobar
   * appears, composer re-mounts, animations, etc.).
   * @param {HTMLElement} el
   * @param {number} [maxMs=1500]
   */
  async function waitForStableRect(el, maxMs = 1500) {
    const start = Date.now();
    let prev = el.getBoundingClientRect();
    while (Date.now() - start < maxMs) {
      await sleep(80);
      const r = el.getBoundingClientRect();
      if (
        Math.abs(r.left - prev.left) < 0.5 &&
        Math.abs(r.top - prev.top) < 0.5 &&
        Math.abs(r.width - prev.width) < 0.5 &&
        Math.abs(r.height - prev.height) < 0.5
      ) {
        return;
      }
      prev = r;
    }
  }

  /**
   * Computes the click point at the centre of `btn` and checks the point actually hits `btn`
   * (not an overlay, tooltip, or a neighbouring control after a layout shift).
   * @param {HTMLElement} btn
   */
  function getClickPoint(btn) {
    const rect = btn.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    const root = btn.getRootNode();
    const hitRoot = root && typeof root.elementFromPoint === "function" ? root : document;
    const hit = hitRoot.elementFromPoint(x, y);
    const hits = Boolean(hit && (hit === btn || btn.contains(hit)));
    return { x, y, hits, hit };
  }

  /**
   * Waits until the submit button is enabled/bright. Nudges Flow's change detection once if it
   * stays greyed out.
   * @param {HTMLElement} promptEl
   * @returns {Promise<HTMLElement|null>}
   */
  async function waitForEnabledSubmitButton(promptEl) {
    // Flow keeps the send button greyed out for ~1 second after text is injected.
    await sleep(1200);
    let submitBtn = findSubmitButton(promptEl);
    for (let i = 0; i < 30 && (!submitBtn || isSubmitButtonGreyedOut(submitBtn)); i++) {
      if (i === 15) {
        // Still disabled after ~2.3s: re-fire input so Angular re-evaluates the form state
        const live = getLivePromptEl(promptEl);
        if (live) {
          live.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
        }
      }
      await sleep(150);
      submitBtn = findSubmitButton(promptEl);
    }
    return submitBtn;
  }

  /**
   * Snapshot of composer state used to tell whether a submit was accepted.
   * @param {HTMLElement} promptEl
   */
  function captureSubmitState(promptEl) {
    const btn = findSubmitButton(promptEl);
    return {
      text: readPromptText(getLivePromptEl(promptEl)).trim(),
      busy: isFlowBusy(),
      icon: getButtonIconName(btn),
      greyed: isSubmitButtonGreyedOut(btn)
    };
  }

  /**
   * Returns a reason string if Flow has visibly accepted the submit, otherwise null.
   * @param {HTMLElement} promptEl
   * @param {ReturnType<typeof captureSubmitState>} before
   */
  function detectSubmissionStarted(promptEl, before) {
    const text = readPromptText(getLivePromptEl(promptEl)).trim();
    if (before.text && !text) return "prompt-cleared";
    if (!before.busy && isFlowBusy()) return "busy-indicator";
    const btn = findSubmitButton(promptEl);
    const icon = getButtonIconName(btn);
    if (before.icon && icon !== before.icon) return `icon-changed:${icon || "none"}`;
    if (!before.greyed && isSubmitButtonGreyedOut(btn)) return "button-disabled";
    return null;
  }

  /**
   * Polls for up to `timeoutMs` for Flow to accept the submit.
   * @returns {Promise<string|null>}
   */
  async function waitForSubmissionStart(promptEl, before, timeoutMs = 3500) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const reason = detectSubmissionStarted(promptEl, before);
      if (reason) return reason;
      await sleep(150);
    }
    return detectSubmissionStarted(promptEl, before);
  }

  /**
   * Clicks the Flow submit (`→`) button and verifies that generation actually started.
   *
   * Each attempt re-measures the button after the debugger is attached (attaching shows Chrome's
   * debugging infobar, which shifts the page), checks the click point really hits the button,
   * then watches for Flow to accept the prompt. A further attempt is only made if the button still
   * shows the same icon, is still enabled, and the prompt text is still there, so a slow but
   * successful submit is never clicked again (which would hit Stop and cancel it).
   *
   * @param {HTMLElement} promptEl
   */
  async function triggerSubmit(promptEl) {
    try {
      await submitAndVerify(promptEl);
    } finally {
      // Detach again so Chrome's debugging infobar does not stay up and change Flow's layout
      // for the next step (the Agent settings panel is applied before the next submit).
      await sendToBackground({ type: "DEBUGGER_RELEASE" });
    }
  }

  /** @param {HTMLElement} promptEl */
  async function submitAndVerify(promptEl) {
    let submitBtn = await waitForEnabledSubmitButton(promptEl);
    if (!submitBtn) {
      throw new Error(
        "Could not locate the Flow submit (<mat-icon>arrow_forward</mat-icon>) button inside the prompt composer."
      );
    }

    // Attach the debugger BEFORE measuring, so the infobar layout shift has already happened.
    const prep = await sendToBackground({ type: "DEBUGGER_PREPARE" });
    const debuggerReady = Boolean(prep && prep.ok);
    if (prep && prep.newlyAttached) {
      await sleep(400);
    }

    const before = captureSubmitState(promptEl);
    const attempts = debuggerReady
      ? ["trusted-click", "trusted-click", "trusted-enter", "synthetic-click"]
      : ["synthetic-click"];
    const tried = [];

    for (const method of attempts) {
      submitBtn = findSubmitButton(promptEl);
      if (!submitBtn) break;

      // Safety: if anything about the button changed since the snapshot, Flow may already be
      // generating. Never click again in that case.
      const already = detectSubmissionStarted(promptEl, before);
      if (already) {
        console.debug("[FlowSidecar] Submit accepted:", already, "after", tried);
        return;
      }

      submitBtn.scrollIntoView({ block: "nearest", inline: "nearest" });
      await waitForStableRect(submitBtn);

      let point = getClickPoint(submitBtn);
      if (!point.hits) {
        // Something is covering the button or the layout just moved: wait and re-measure once.
        await sleep(300);
        submitBtn = findSubmitButton(promptEl) || submitBtn;
        point = getClickPoint(submitBtn);
      }

      console.debug("[FlowSidecar] Submit attempt:", {
        method,
        icon: getButtonIconName(submitBtn),
        x: point.x,
        y: point.y,
        hitsButton: point.hits,
        hit: point.hit && point.hit.tagName
      });

      if (method === "trusted-click") {
        const res = await sendToBackground({ type: "TRUSTED_CLICK", x: point.x, y: point.y });
        if (!res.ok) {
          console.warn("[FlowSidecar] Trusted click failed:", res.error);
        }
      } else if (method === "trusted-enter") {
        const live = getLivePromptEl(promptEl);
        if (live) {
          live.focus();
          await sleep(50);
        }
        await sendToBackground({ type: "TRUSTED_ENTER" });
      } else {
        simulateRealClick(submitBtn);
      }
      tried.push(method);

      const reason = await waitForSubmissionStart(promptEl, before);
      if (reason) {
        console.debug("[FlowSidecar] Submit accepted:", reason, "after", tried);
        return;
      }
    }

    throw new Error(
      `Flow did not start generating after clicking the submit button (tried: ${
        tried.join(", ") || "none"
      }). The button may be covered or still disabled.`
    );
  }

  globalScope.FlowDomActions = {
    injectPromptText,
    attachReferenceImages,
    listProjectImages,
    fetchFlowImageAsDataUrl,
    applyFlowParameters,
    captureBaselineOutputSignatures,
    triggerSubmit,
    waitForFlowCompletion
  };
})(window);
