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
    injectImg2ImgReference,
    applyFlowParameters,
    captureBaselineOutputSignatures,
    triggerSubmit,
    waitForFlowCompletion
  } = globalScope.FlowDomActions;

  let isStepInProgress = false;

  /**
   * Executes a single end-to-end generation step inside Google Labs Flow:
   * 1. Configures Aspect Ratio & Target Model
   * 2. Injects optional Img2Img reference image via synthetic DataTransfer
   * 3. Injects prompt text via native prototype setter
   * 4. Snapshots existing outputs and clicks Generate/Submit
   * 5. Waits for completion and returns the new output image as a base64 Data URL
   *
   * @param {object} payload
   * @param {string} payload.prompt
   * @param {string} [payload.aspectRatio]
   * @param {string} [payload.targetModel]
   * @param {string|null} [payload.img2imgDataUrl]
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

      // 1. Snapshot baseline outputs before submitting
      const baselineSignatures = captureBaselineOutputSignatures();

      // 2. Apply aspect ratio, target Flow model, and images-per-prompt count inside Agent settings (then click Save to return)
      await applyFlowParameters({
        aspectRatio: payload.aspectRatio,
        targetModel: payload.targetModel,
        imagesPerPrompt: expectedCount
      });

      // 3. Inject prompt text into the restored composer via Virtual DOM native prototype setter
      const promptEl = injectPromptText(promptText);

      // 4. Upload Img2Img reference image if active
      if (payload.img2imgDataUrl) {
        await injectImg2ImgReference(
          payload.img2imgDataUrl,
          payload.img2imgName || "reference.png"
        );
      }

      // Brief pause to allow reactive UI state to enable the submit button
      await new Promise((r) => setTimeout(r, 250));

      // 5. Click Submit / Generate (`→`) inside the composer
      await triggerSubmit(promptEl);

      // 6. Wait for Flow's busy state to clear, download native image via Flow, and close detail view
      const { imageDataUrls, downloadedViaFlow } = await waitForFlowCompletion(
        baselineSignatures,
        expectedCount,
        180000,
        { upscaleDownload: Boolean(payload.upscaleDownload) }
      );

      return {
        ok: true,
        imageDataUrl: imageDataUrls[0],
        imageDataUrls,
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
