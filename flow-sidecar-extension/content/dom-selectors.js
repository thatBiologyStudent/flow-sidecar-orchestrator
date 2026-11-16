/**
 * Flow Sidecar Orchestrator - Resilient Multi-Selector Dictionary (`content/dom-selectors.js`)
 * Provides prioritized CSS selector arrays and heuristic DOM query helpers for Google Labs Flow.
 */

(function initFlowDomSelectors(globalScope) {
  const FLOW_SELECTORS = {
    promptInput: [
      'textarea[placeholder*="What do you want to create" i]',
      'textarea[placeholder*="want to create" i]',
      'textarea[placeholder*="prompt" i]',
      'textarea[placeholder*="describe" i]',
      'textarea[placeholder*="create" i]',
      'textarea[placeholder*="generate" i]',
      'textarea[aria-label*="What do you want to create" i]',
      'textarea[aria-label*="prompt" i]',
      'textarea[data-testid*="prompt" i]',
      'div[contenteditable="true"][data-placeholder*="What do you want to create" i]',
      'div[contenteditable="true"][aria-label*="create" i]',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"][aria-label*="prompt" i]',
      'div[contenteditable="true"]',
      "textarea"
    ],

    submitButton: [
      'button[type="submit"]',
      'button[aria-label*="generate" i]',
      'button[aria-label*="create" i]',
      'button[aria-label*="run" i]',
      'button[aria-label*="send" i]',
      'button[aria-label*="submit" i]',
      'button[aria-label*="arrow" i]',
      'button[data-testid*="generate" i]',
      'button[data-testid*="submit" i]',
      'button[data-testid*="send" i]'
    ],

    composerSettingsButtons: [
      'button[aria-label*="setting" i]',
      'button[aria-label*="parameter" i]',
      'button[aria-label*="option" i]',
      'button[aria-label*="tune" i]',
      'button[aria-label*="aspect" i]',
      'button[aria-label*="model" i]',
      'button[title*="setting" i]',
      'button[title*="option" i]'
    ],

    aspectRatioButtons: [
      'button[aria-label*="aspect" i]',
      'button[data-testid*="aspect" i]',
      '[role="radiogroup"][aria-label*="aspect" i] [role="radio"]',
      '[role="button"][aria-label*="ratio" i]',
      'button[title*="aspect" i]'
    ],

    modelOptions: [
      'button[aria-label*="model" i]',
      '[role="combobox"][aria-label*="model" i]',
      '[data-testid*="model" i]',
      '[role="listbox"] [role="option"]',
      '[role="menuitemradio"]',
      '[role="menuitem"]'
    ],

    img2imgFileInputs: [
      'input[type="file"][accept*="image" i]',
      'input[type="file"]'
    ],

    img2imgDropZones: [
      '[data-testid*="dropzone" i]',
      '[data-testid*="upload" i]',
      '[aria-label*="upload" i]',
      '[aria-label*="reference" i]',
      '[aria-label*="drop" i]',
      'form'
    ],

    busyIndicators: [
      '[aria-busy="true"]',
      '[role="progressbar"]',
      '[data-testid*="loading" i]',
      '[data-testid*="spinner" i]',
      '[class*="spinner" i]',
      '[class*="loading" i]',
      '[class*="progress" i]'
    ],

    outputImages: [
      'main img[src^="blob:"]',
      'main img[src^="data:image/"]',
      'main img[src*="googleusercontent.com"]',
      'main img[src*="ggpht.com"]',
      '[data-testid*="result" i] img',
      '[data-testid*="output" i] img',
      '[class*="gallery" i] img',
      '[class*="result" i] img',
      '[class*="canvas" i] canvas',
      "main canvas",
      "main img"
    ]
  };

  /**
   * Checks whether an element is visible and interactable in the layout.
   * @param {Element|null} el
   * @returns {boolean}
   */
  function isElementVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity) === 0) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  /**
   * Queries `selector` across `root` and any nested open Shadow DOMs.
   * @param {string} selector
   * @param {ParentNode} [root=document]
   * @returns {Element[]}
   */
  function queryAllDeep(selector, root = document) {
    const results = [];
    const seen = new Set();

    function walk(node) {
      if (!node || typeof node.querySelectorAll !== "function") return;
      try {
        for (const el of node.querySelectorAll(selector)) {
          if (!seen.has(el)) {
            seen.add(el);
            results.push(el);
          }
        }
      } catch (_) {
        // Ignore invalid selector
      }

      const all = node.querySelectorAll("*");
      for (const el of all) {
        if (el.shadowRoot) {
          walk(el.shadowRoot);
        }
      }
    }

    walk(root);
    return results;
  }

  /**
   * Queries a list of fallback selectors (piercing Shadow DOMs) and returns the first visible matching element.
   * @param {string[]} selectorList
   * @param {ParentNode} [root=document]
   * @returns {HTMLElement|null}
   */
  function queryFirstVisible(selectorList, root = document) {
    for (const selector of selectorList) {
      const nodes = queryAllDeep(selector, root);
      for (const node of nodes) {
        if (isElementVisible(node)) {
          return /** @type {HTMLElement} */ (node);
        }
      }
    }
    return null;
  }

  /**
   * Finds the outer composer card element that wraps BOTH the prompt input AND the bottom action toolbar
   * (where `+`, `Agent`/mode pill, prompt book, sliders/settings icon, and `→` submit button live).
   *
   * @param {HTMLElement} [promptEl]
   * @returns {HTMLElement|null}
   */
  function findComposerContainer(promptEl) {
    const anchor = promptEl || queryFirstVisible(FLOW_SELECTORS.promptInput);
    if (!anchor) return null;

    let curr = anchor.parentElement;

    for (let depth = 0; depth < 10 && curr && curr !== document.body; depth++) {
      const rect = curr.getBoundingClientRect();
      if (rect.width > window.innerWidth * 0.94 && rect.height > window.innerHeight * 0.85) {
        break;
      }

      const buttons = queryAllDeep('button, [role="button"]', curr).filter((b) =>
        isElementVisible(b)
      );

      // The Flow composer card contains at least 3 buttons (e.g., '+', 'Agent', sliders, '→')
      if (buttons.length >= 3 && buttons.length <= 24) {
        return curr;
      }

      curr = curr.parentElement;
    }

    return anchor.parentElement;
  }

  /**
   * Returns true if a button is a top-corner utility button (`✕` clear, `⤢` expand/open session)
   * that must NEVER be clicked as submit or settings.
   * @param {Element} btn
   * @returns {boolean}
   */
  function isExcludedUtilityButton(btn) {
    const label = `${btn.getAttribute("aria-label") || ""} ${btn.getAttribute("title") || ""} ${
      btn.textContent || ""
    }`.toLowerCase();

    return /\b(expand|fullscreen|session|close|clear|collapse|dismiss)\b/.test(label);
  }

  /**
   * Returns all visible buttons in the bottom toolbar row of the composer,
   * using geometric proximity to `promptEl` first (so it works regardless of DOM nesting),
   * sorted from rightmost to leftmost (`[0] = → submit`, `[1] = sliders/settings`, ...).
   *
   * @param {HTMLElement} [promptEl]
   * @returns {HTMLElement[]}
   */
  function getComposerBottomRowButtons(promptEl) {
    const anchor = promptEl || queryFirstVisible(FLOW_SELECTORS.promptInput);
    if (!anchor) return [];

    const promptRect = anchor.getBoundingClientRect();

    // Primary strategy: geometric band at the bottom of the prompt box (bottom toolbar row)
    const allButtons = queryAllDeep('button, [role="button"]', document).filter(
      (b) => isElementVisible(b) && !isExcludedUtilityButton(b)
    );

    const bandButtons = allButtons.filter((b) => {
      const r = b.getBoundingClientRect();
      const verticallyInToolbar =
        r.top >= promptRect.bottom - 56 && r.bottom <= promptRect.bottom + 96;
      const horizontallyInComposer =
        r.left >= promptRect.left - 48 && r.right <= promptRect.right + 72;
      return verticallyInToolbar && horizontallyInComposer;
    });

    if (bandButtons.length >= 2) {
      // Find the lowest row in this band (maxBottom) and keep buttons on that row
      let maxBottom = -Infinity;
      for (const b of bandButtons) {
        const rb = b.getBoundingClientRect().bottom;
        if (rb > maxBottom) maxBottom = rb;
      }
      const bottomRow = bandButtons.filter((b) => maxBottom - b.getBoundingClientRect().bottom <= 24);
      bottomRow.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right);
      return /** @type {HTMLElement[]} */ (bottomRow);
    }

    // Fallback strategy: walk up to composer container
    const composer = findComposerContainer(anchor);
    if (!composer) return [];

    const allComposerButtons = queryAllDeep('button, [role="button"]', composer).filter(
      (b) => isElementVisible(b) && !isExcludedUtilityButton(b)
    );
    if (allComposerButtons.length === 0) return [];

    let maxBottom = -Infinity;
    for (const b of allComposerButtons) {
      const rb = b.getBoundingClientRect().bottom;
      if (rb > maxBottom) maxBottom = rb;
    }

    const bottomButtons = allComposerButtons.filter(
      (b) => maxBottom - b.getBoundingClientRect().bottom <= 28
    );
    bottomButtons.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right);
    return /** @type {HTMLElement[]} */ (bottomButtons);
  }

  /**
   * Finds a visible `<mat-icon>` (or `.google-symbols` element) matching one of the given icon names
   * (e.g. `"arrow_forward"`, `"tune"`, `"arrow_back"`), and returns its clickable button ancestor.
   *
   * @param {string[]} iconNames
   * @param {ParentNode} [root=document]
   * @returns {HTMLElement|null}
   */
  function findButtonByMatIcon(iconNames, root = document) {
    const normalizedSet = new Set(iconNames.map((n) => n.toLowerCase()));
    const icons = queryAllDeep("mat-icon, .google-symbols, .material-icons, i", root);
    const matches = [];

    for (const icon of icons) {
      if (!isElementVisible(icon)) continue;
      const iconText = (icon.textContent || "").trim().toLowerCase();
      if (normalizedSet.has(iconText)) {
        const clickable =
          icon.closest('button, [role="button"], [mat-icon-button], [mat-button], [mat-fab], [mat-mini-fab]') ||
          icon.parentElement ||
          icon;
        if (clickable && isElementVisible(clickable)) {
          matches.push(/** @type {HTMLElement} */ (clickable));
        }
      }
    }

    if (matches.length === 0) return null;
    // If multiple matches exist, prefer the one lowest on the screen (inside the bottom composer)
    matches.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
    return matches[0];
  }

  /**
   * Finds the primary Submit / Generate (`→`) button in the bottom-right corner of the composer.
   * Directly targets Google Flow's `<mat-icon>arrow_forward</mat-icon>` button first, then falls back
   * to the rightmost button on the bottommost row of the composer.
   *
   * @param {HTMLElement} [promptEl]
   * @returns {HTMLButtonElement|HTMLElement|null}
   */
  function findSubmitButton(promptEl) {
    // 1. Direct match on Google Flow's `<mat-icon>arrow_forward</mat-icon>` button
    const matArrowBtn = findButtonByMatIcon(["arrow_forward", "send", "arrow_upward"]);
    if (matArrowBtn && !isExcludedUtilityButton(matArrowBtn)) {
      return matArrowBtn;
    }

    // 2. Fallback to geometric bottom-right button of the composer
    const bottomButtons = getComposerBottomRowButtons(promptEl);
    if (bottomButtons.length > 0) {
      return bottomButtons[0];
    }

    const composer = findComposerContainer(promptEl);
    if (composer) {
      const explicit = queryFirstVisible(FLOW_SELECTORS.submitButton, composer);
      if (explicit && !isExcludedUtilityButton(explicit)) return explicit;
    }

    return null;
  }

  /**
   * Finds the Settings / Sliders (`tune`) button inside the bottom toolbar of the Flow composer
   * (immediately to the left of the `<mat-icon>arrow_forward</mat-icon>` submit button).
   *
   * @param {HTMLElement} [promptEl]
   * @returns {HTMLElement|null}
   */
  function findComposerSettingsButton(promptEl) {
    // 1. Direct match on `<mat-icon>tune</mat-icon>` / sliders icon in the composer
    const tuneBtn = findButtonByMatIcon(["tune", "sliders", "page_info", "instant_mix"]);
    if (tuneBtn && !isExcludedUtilityButton(tuneBtn)) {
      return tuneBtn;
    }

    // 2. Sibling button immediately to the left of the `arrow_forward` submit button on the same row
    const submitBtn = findSubmitButton(promptEl);
    if (submitBtn) {
      const sr = submitBtn.getBoundingClientRect();
      const allButtons = queryAllDeep('button, [role="button"]', document).filter(
        (b) => b !== submitBtn && isElementVisible(b) && !isExcludedUtilityButton(b)
      );
      const leftRowNeighbors = allButtons.filter((b) => {
        const r = b.getBoundingClientRect();
        return Math.abs(r.bottom - sr.bottom) <= 20 && r.right <= sr.left + 8 && r.left >= sr.left - 120;
      });
      if (leftRowNeighbors.length > 0) {
        leftRowNeighbors.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right);
        return /** @type {HTMLElement} */ (leftRowNeighbors[0]);
      }
    }

    const bottomButtons = getComposerBottomRowButtons(promptEl);
    if (bottomButtons.length >= 2) {
      return bottomButtons[1];
    }

    return null;
  }

  /**
   * Collects all currently visible output `<img>` and `<canvas>` elements that meet minimum size thresholds.
   * @param {number} [minSize=128]
   * @returns {Array<HTMLImageElement|HTMLCanvasElement>}
   */
  function queryCandidateOutputs(minSize = 128) {
    const seen = new Set();
    const results = [];

    for (const selector of FLOW_SELECTORS.outputImages) {
      let nodes = [];
      try {
        nodes = Array.from(document.querySelectorAll(selector));
      } catch (_) {
        continue;
      }

      for (const node of nodes) {
        if (seen.has(node) || !isElementVisible(node)) continue;
        seen.add(node);

        if (node instanceof HTMLImageElement) {
          const w = node.naturalWidth || node.width || node.clientWidth;
          const h = node.naturalHeight || node.height || node.clientHeight;
          const src = node.currentSrc || node.src || "";
          // Ignore small UI icons or static decorative assets (e.g. session welcome card icons)
          const isStaticUiIcon =
            /\/(icons?|assets|static|emoji|illustrations?)\//i.test(src) ||
            (w < 256 && h < 256 && !src.startsWith("blob:") && !src.startsWith("data:image/"));
          if (w >= minSize && h >= minSize && src && !isStaticUiIcon) {
            results.push(node);
          }
        } else if (node instanceof HTMLCanvasElement) {
          const w = node.width || node.clientWidth;
          const h = node.height || node.clientHeight;
          if (w >= minSize && h >= minSize) {
            results.push(node);
          }
        }
      }
    }

    return results;
  }

  globalScope.FlowDomSelectors = {
    FLOW_SELECTORS,
    isElementVisible,
    queryAllDeep,
    queryFirstVisible,
    findButtonByMatIcon,
    findComposerContainer,
    findSubmitButton,
    findComposerSettingsButton,
    queryCandidateOutputs
  };
})(window);
