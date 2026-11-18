/**
 * Flow Sidecar Orchestrator - Content Script Entry (`content/content.js`)
 * Listens for automation commands from the Side Panel / Background Service Worker
 * and orchestrates Google Labs Flow DOM interactions.
 */

(function initFlowContentScript(globalScope) {
  if (globalScope.__FLOW_SIDECAR_CONTENT_INITIALIZED__) {
    return;
  }
  globalScope.__FLOW_SIDECAR_CONTENT_INITIALIZED__ = true;

  const {
    injectPromptText,
    attachReferenceImages,
    listProjectImages,
    fetchFlowImageAsDataUrl,
    applyFlowParameters,
    captureBaselineOutputSignatures,
    triggerSubmit,
    waitForFlowCompletion
  } = globalScope.FlowDomActions;

  let isStepInProgress = false;

  /**
   * Executes a single end-to-end generation step inside Google Labs Flow:
   * 1. Configures Aspect Ratio, Images per Prompt & Target Model
   * 2. Attaches reference images (image-to-image) and verifies them
   * 3. Injects prompt text
   * 4. Snapshots existing outputs and clicks Start generation
   * 5. Waits for completion and returns the new images (Data URLs + Flow asset IDs)
   *
   * @param {object} payload
   * @param {string} payload.prompt
   * @param {string} [payload.aspectRatio]
   * @param {string} [payload.targetModel]
   * @param {Array<{dataUrl?: string, name?: string, assetId?: string}>} [payload.references]
   * @param {string|null} [payload.img2imgDataUrl] Global reference from settings (added to every prompt)
   * @param {string} [payload.img2imgName]
   * @returns {Promise<{ok: boolean, imageDataUrl?: string, error?: string}>}
   */
  async function handleExecuteFlowPrompt(payload) {
    if (isStepInProgress) {
      return {
        ok: false,
        error: "A Flow generation step is already running in this tab."
      };
    }

    const promptText = typeof payload?.prompt === "string" ? payload.prompt.trim() : "";
    if (!promptText) {
      return {
        ok: false,
        error: "Cannot execute an empty prompt in Flow."
      };
    }

    isStepInProgress = true;
    try {
      const expectedCount = Math.min(4, Math.max(1, Math.round(Number(payload.imagesPerPrompt) || 1)));

      // 1. Apply aspect ratio, target Flow model, and images-per-prompt count inside Agent settings (then click Save to return)
      await applyFlowParameters({
        aspectRatio: payload.aspectRatio,
        targetModel: payload.targetModel,
        imagesPerPrompt: expectedCount
      });

      // 2. Reference images: always clear leftovers, then attach this item's references
      const references = Array.isArray(payload.references) ? [...payload.references] : [];
      if (payload.img2imgDataUrl) {
        references.push({ dataUrl: payload.img2imgDataUrl, name: payload.img2imgName || "Img2Img reference" });
      }
      await attachReferenceImages(references);

      // 3. Inject prompt text
      const promptEl = injectPromptText(promptText);

      // Brief pause to allow reactive UI state to enable the submit button
      await new Promise((r) => setTimeout(r, 250));

      // 4. Snapshot outputs now, AFTER references were uploaded (uploads also appear in the media grid
      //    and must not be mistaken for generated images)
      const baselineSignatures = captureBaselineOutputSignatures();

      // 5. Click Submit / Generate (`→`) inside the composer
      await triggerSubmit(promptEl);

      // 6. Wait for Flow's busy state to clear, download native image via Flow, and close detail view
      const { imageDataUrls, assetIds, downloadedViaFlow } = await waitForFlowCompletion(
        baselineSignatures,
        expectedCount,
        180000,
        {
          upscaleDownload: Boolean(payload.upscaleDownload),
          // Alembic bridge: return originals without clicking Flow's Download button
          skipFlowDownload: Boolean(payload.skipFlowDownload)
        }
      );

      return {
        ok: true,
        imageDataUrl: imageDataUrls[0],
        imageDataUrls,
        assetIds: assetIds || [],
        downloadedViaFlow
      };
    } catch (err) {
      return {
        ok: false,
        error: err.message || String(err)
      };
    } finally {
      isStepInProgress = false;
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== "string") {
      return false;
    }

    if (message.type === "PING_CONTENT") {
      sendResponse({ ok: true, url: window.location.href });
      return false;
    }

    if (message.type === "LIST_FLOW_IMAGES") {
      if (isStepInProgress) {
        sendResponse({ ok: false, error: "Flow is busy with a queue item. Try again after it finishes." });
        return false;
      }
      listProjectImages({ limit: Number(message.payload?.limit) || 80 })
        .then((images) => sendResponse({ ok: true, images }))
        .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
      return true;
    }

    if (message.type === "FETCH_FLOW_IMAGE") {
      const assetId = String(message.payload?.assetId || "");
      const baseUrl = /^[A-Za-z0-9_-]+$/.test(assetId)
        ? `${window.location.origin}/asb/${assetId}`
        : String(message.payload?.baseUrl || "");
      if (!/^https:\/\/[^/]+\/asb\/[^=/?#]+$/.test(baseUrl)) {
        sendResponse({ ok: false, error: "Invalid Flow image address." });
        return false;
      }
      const size = Number(message.payload?.size);
      // size 0 = original resolution
      fetchFlowImageAsDataUrl(baseUrl, Number.isFinite(size) && size >= 0 ? Math.round(size) : 1024)
        .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
        .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
      return true;
    }

    if (message.type === "EXECUTE_FLOW_PROMPT") {
      handleExecuteFlowPrompt(message.payload || {})
        .then((result) => sendResponse(result))
        .catch((err) =>
          sendResponse({
            ok: false,
            error: err.message || String(err)
          })
        );
      return true; // Async response
    }

    return false;
  });
})(window);
