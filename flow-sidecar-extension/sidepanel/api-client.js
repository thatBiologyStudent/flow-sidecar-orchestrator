/**
 * Flow Sidecar Orchestrator - OpenAI-Compatible Multimodal & Vision API Client
 * Enforces strict zero-default configuration validation, structures multimodal
 * content arrays, performs JSON-schema batch prompt expansion, and runs closed-loop
 * vision critiques on generated Flow images.
 */

export class ConfigValidationError extends Error {
  /**
   * @param {string} message
   * @param {string[]} missingFields
   */
  constructor(message, missingFields = []) {
    super(message);
    this.name = "ConfigValidationError";
    this.missingFields = missingFields;
  }
}

export const DEFAULT_SYSTEM_PROMPT = [
  "You are the Flow Sidecar Orchestrator, an expert visual director and prompt engineer for Google Labs Flow image generation.",
  "Your role is to help the user craft vivid, high-precision image generation prompts specifying subject, composition, camera angle, lighting, color palette, lens characteristics, and artistic medium.",
  "When reference images are attached, analyze their visual style, lighting, framing, and key motifs and incorporate those details accurately.",
  "When the user requests a specific aspect ratio (1:1, 16:9, 9:16, 4:3, 3:4) or Google Flow model (Nano Banana 2.1, Nano Banana Pro, Nano Banana 2 Lite), honor and output those overrides."
].join("\n");

/**
 * Validation Gate:
 * Validates that Base URL and Model Name are non-empty.
 * Uses the user's Custom System Prompt if provided, or falls back to `DEFAULT_SYSTEM_PROMPT`.
 *
 * @param {object} config
 * @param {string} config.baseUrl
 * @param {string} config.apiKey
 * @param {string} config.modelName
 * @param {string} [config.systemPrompt]
 * @returns {{baseUrl: string, apiKey: string, modelName: string, systemPrompt: string}}
 */
export function validateRequiredConfig(config) {
  const baseUrl = typeof config?.baseUrl === "string" ? config.baseUrl.trim() : "";
  const apiKey = typeof config?.apiKey === "string" ? config.apiKey.trim() : "";
  const modelName = typeof config?.modelName === "string" ? config.modelName.trim() : "";
  const customSystemPrompt = typeof config?.systemPrompt === "string" ? config.systemPrompt.trim() : "";

  const missingFields = [];
  if (!baseUrl) missingFields.push("Base URL");
  if (!modelName) missingFields.push("Model Name");

  if (missingFields.length > 0) {
    throw new ConfigValidationError(
      `Configuration incomplete. Please fill in required field(s): ${missingFields.join(", ")}.`,
      missingFields
    );
  }

  const effectiveSystemPrompt = customSystemPrompt
    ? `${DEFAULT_SYSTEM_PROMPT}\n\nUSER CUSTOM SYSTEM INSTRUCTIONS:\n${customSystemPrompt}`
    : DEFAULT_SYSTEM_PROMPT;

  return { baseUrl, apiKey, modelName, systemPrompt: effectiveSystemPrompt };
}

/**
 * Resolves a user-provided Base URL to a full `/chat/completions` endpoint URL
 * without inventing a default hostname.
 * @param {string} rawBaseUrl
 * @returns {string}
 */
export function resolveChatCompletionsEndpoint(rawBaseUrl) {
  const trimmed = rawBaseUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new ConfigValidationError(
      "Base URL must start with http:// or https:// (e.g., https://your-endpoint/v1).",
      ["Base URL"]
    );
  }
  if (/\/chat\/completions$/i.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed}/chat/completions`;
}

/**
 * Resolves a user-provided Base URL to a `/models` endpoint URL for aggregator model discovery.
 * Handles Base URLs ending in `/v1`, `/v1/chat/completions`, `/api/v1`, or bare origins.
 * @param {string} rawBaseUrl
 * @returns {string}
 */
export function resolveModelsEndpoint(rawBaseUrl) {
  const trimmed = (rawBaseUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new ConfigValidationError("Please enter a Base URL before fetching models.", ["Base URL"]);
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new ConfigValidationError(
      "Base URL must start with http:// or https:// (e.g., https://your-aggregator/v1).",
      ["Base URL"]
    );
  }
  if (/\/models$/i.test(trimmed)) {
    return trimmed;
  }
  const withoutChat = trimmed.replace(/\/chat\/completions$/i, "");
  return `${withoutChat}/models`;
}

/**
 * Queries the aggregator's `/models` endpoint and returns a sorted list of model IDs.
 * Supports OpenAI (`{ data: [{ id }] }`), OpenRouter, LiteLLM, Ollama/vLLM, and plain array formats.
 *
 * @param {object} params
 * @param {string} params.baseUrl
 * @param {string} [params.apiKey]
 * @returns {Promise<string[]>}
 */
export async function fetchAvailableModels({ baseUrl, apiKey }) {
  const endpoint = resolveModelsEndpoint(baseUrl);
  const headers = {
    Accept: "application/json"
  };
  if (typeof apiKey === "string" && apiKey.trim()) {
    headers["Authorization"] = `Bearer ${apiKey.trim()}`;
  }

  let response;
  try {
    response = await fetch(endpoint, {
      method: "GET",
      headers
    });
  } catch (networkErr) {
    throw new Error(`Failed to reach ${endpoint}: ${networkErr.message || String(networkErr)}`);
  }

  const rawBody = await response.text();
  if (!response.ok) {
    let errorDetail = rawBody.slice(0, 250);
    try {
      const errJson = JSON.parse(rawBody);
      errorDetail = errJson?.error?.message || errJson?.message || errorDetail;
    } catch (_) {
      // keep raw snippet
    }
    throw new Error(`Models fetch failed (${response.status}): ${errorDetail}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch (_) {
    throw new Error("Aggregator `/models` endpoint returned non-JSON data.");
  }

  const rawList = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.data)
      ? parsed.data
      : Array.isArray(parsed?.models)
        ? parsed.models
        : [];

  const modelIds = rawList
    .map((item) => {
      if (typeof item === "string") return item.trim();
      if (item && typeof item === "object") {
        return String(item.id || item.name || item.model || "").trim();
      }
      return "";
    })
    .filter(Boolean);

  const uniqueSorted = Array.from(new Set(modelIds)).sort((a, b) => a.localeCompare(b));
  if (uniqueSorted.length === 0) {
    throw new Error("Connected to `/models`, but no model IDs were found in the response.");
  }

  return uniqueSorted;
}

/**
 * Builds an OpenAI-compatible multimodal content array combining text and base64 images.
 * - Text instructions wrapped in `{"type": "text", "text": "..."}`
 * - Reference images wrapped in `{"type": "image_url", "image_url": {"url": "data:image/...", "detail": "auto"}}`
 *
 * @param {string} text
 * @param {string[]} [imageDataUrls=[]]
 * @returns {Array<object>}
 */
export function buildMultimodalContentArray(text, imageDataUrls = []) {
  const content = [];

  if (typeof text === "string" && text.trim().length > 0) {
    content.push({
      type: "text",
      text: text.trim()
    });
  }

  if (Array.isArray(imageDataUrls)) {
    for (const url of imageDataUrls) {
      if (typeof url === "string" && url.startsWith("data:image/")) {
        content.push({
          type: "image_url",
          image_url: {
            url,
            detail: "auto"
          }
        });
      }
    }
  }

  if (content.length === 0) {
    content.push({
      type: "text",
      text: "Analyze the attached visual context and follow the system instructions."
    });
  }

  return content;
}

export const ALLOWED_ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4"];

export const ALLOWED_IMAGES_PER_PROMPT = [1, 2, 3, 4];

export const GOOGLE_FLOW_IMAGE_MODELS = [
  "Nano Banana 2.1",
  "Nano Banana Pro",
  "Nano Banana 2 Lite"
];

/**
 * Normalizes an AI-suggested images-per-prompt count (clamped to 1..4).
 * @param {number|string} [rawCount]
 * @returns {number|null}
 */
export function normalizeImagesPerPromptOverride(rawCount) {
  if (rawCount === null || rawCount === undefined || rawCount === "") return null;
  const parsed = Number(rawCount);
  if (!Number.isFinite(parsed)) return null;
  const rounded = Math.round(parsed);
  if (rounded >= 1 && rounded <= 4) return rounded;
  return null;
}

/**
 * Normalizes an AI-suggested aspect ratio against supported Flow aspect ratios.
 * @param {string} [rawRatio]
 * @returns {string|null}
 */
export function normalizeAspectRatioOverride(rawRatio) {
  if (typeof rawRatio !== "string" || !rawRatio.trim()) return null;
  const cleaned = rawRatio.trim();
  const match = ALLOWED_ASPECT_RATIOS.find((r) => r.toLowerCase() === cleaned.toLowerCase());
  return match || null;
}

/**
 * Normalizes an AI-suggested Google Flow image model against the dropdown options.
 * @param {string} [rawModel]
 * @returns {string|null}
 */
export function normalizeFlowModelOverride(rawModel) {
  if (typeof rawModel !== "string" || !rawModel.trim()) return null;
  const cleaned = rawModel.trim().toLowerCase();
  const exact = GOOGLE_FLOW_IMAGE_MODELS.find((m) => m.toLowerCase() === cleaned);
  if (exact) return exact;
  const partial = GOOGLE_FLOW_IMAGE_MODELS.find(
    (m) => cleaned.includes(m.toLowerCase()) || m.toLowerCase().includes(cleaned)
  );
  return partial || null;
}

/**
 * Defensively parses JSON containing `{ "prompts": [...] }` plus optional AI setting overrides
 * (`aspectRatio`, `targetFlowModel` at root or per-prompt item), stripping markdown code fences
 * (` ```json ... ``` `) or surrounding prose if returned.
 *
 * @param {string} rawText
 * @returns {{
 *   prompts: Array<{prompt: string, aspectRatio?: string|null, targetFlowModel?: string|null}>,
 *   overrides: {aspectRatio: string|null, targetFlowModel: string|null},
 *   critique?: string
 * }}
 */
export function parsePromptsJsonResponse(rawText) {
  if (typeof rawText !== "string" || !rawText.trim()) {
    throw new Error("LLM returned an empty response body.");
  }

  // Strip ```json ... ``` or ``` ... ``` markdown fences
  let cleaned = rawText.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  let parsed = null;
  try {
    parsed = JSON.parse(cleaned);
  } catch (_) {
    // Fallback: extract first JSON object substring `{ ... }`
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      const candidate = cleaned.slice(firstBrace, lastBrace + 1);
      parsed = JSON.parse(candidate);
    } else {
      throw new Error(`Failed to parse JSON from model output: ${rawText.slice(0, 220)}`);
    }
  }

  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.prompts)) {
    throw new Error('Model JSON response did not match required schema: {"prompts": ["string", ...]}.');
  }

  const rootAspectOverride = normalizeAspectRatioOverride(
    parsed.aspectRatio || parsed.aspect_ratio || parsed?.overrides?.aspectRatio
  );
  const rootModelOverride = normalizeFlowModelOverride(
    parsed.targetFlowModel || parsed.target_model || parsed.model || parsed?.overrides?.targetFlowModel
  );
  const rootImagesPerPromptOverride = normalizeImagesPerPromptOverride(
    parsed.imagesPerPrompt ??
      parsed.images_per_prompt ??
      parsed.outputsPerPrompt ??
      parsed?.overrides?.imagesPerPrompt
  );

  const prompts = parsed.prompts
    .map((item) => {
      if (typeof item === "string") {
        const text = item.trim();
        if (!text) return null;
        return {
          prompt: text,
          aspectRatio: rootAspectOverride,
          targetFlowModel: rootModelOverride,
          imagesPerPrompt: rootImagesPerPromptOverride
        };
      }
      if (item && typeof item === "object" && typeof item.prompt === "string") {
        const text = item.prompt.trim();
        if (!text) return null;
        return {
          prompt: text,
          aspectRatio:
            normalizeAspectRatioOverride(item.aspectRatio || item.aspect_ratio) || rootAspectOverride,
          targetFlowModel:
            normalizeFlowModelOverride(item.targetFlowModel || item.target_model || item.model) ||
            rootModelOverride,
          imagesPerPrompt:
            normalizeImagesPerPromptOverride(
              item.imagesPerPrompt ?? item.images_per_prompt ?? item.outputsPerPrompt
            ) ?? rootImagesPerPromptOverride
        };
      }
      return null;
    })
    .filter(Boolean);

  if (prompts.length === 0) {
    throw new Error("Model returned an empty `prompts` array.");
  }

  const result = {
    prompts,
    overrides: {
      aspectRatio: rootAspectOverride,
      targetFlowModel: rootModelOverride,
      imagesPerPrompt: rootImagesPerPromptOverride
    }
  };
  if (typeof parsed.critique === "string" && parsed.critique.trim()) {
    result.critique = parsed.critique.trim();
  }
  return result;
}

/**
 * Dispatches a request to the configured `/chat/completions` endpoint.
 *
 * @param {object} config
 * @param {Array<object>} messages
 * @param {object} [options]
 * @param {boolean} [options.enforceJsonObject=false]
 * @param {number} [options.temperature=0.7]
 * @returns {Promise<string>} Assistant response content string
 */
export async function callChatCompletions(config, messages, options = {}) {
  const validated = validateRequiredConfig(config);
  const endpoint = resolveChatCompletionsEndpoint(validated.baseUrl);

  const headers = {
    "Content-Type": "application/json"
  };
  if (validated.apiKey) {
    headers["Authorization"] = `Bearer ${validated.apiKey}`;
  }

  const requestBody = {
    model: validated.modelName,
    messages,
    temperature: typeof options.temperature === "number" ? options.temperature : 0.7
  };

  if (options.enforceJsonObject) {
    requestBody.response_format = { type: "json_object" };
  }

  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody)
    });
  } catch (networkErr) {
    throw new Error(`Network request to ${endpoint} failed: ${networkErr.message || String(networkErr)}`);
  }

  const rawBody = await response.text();
  if (!response.ok) {
    let errorDetail = rawBody.slice(0, 300);
    try {
      const errJson = JSON.parse(rawBody);
      errorDetail = errJson?.error?.message || errJson?.message || errorDetail;
    } catch (_) {
      // Keep raw text snippet
    }
    throw new Error(`API Error (${response.status}): ${errorDetail}`);
  }

  let data;
  try {
    data = JSON.parse(rawBody);
  } catch (_) {
    throw new Error("API returned non-JSON response payload.");
  }

  const messageContent = data?.choices?.[0]?.message?.content;
  if (typeof messageContent === "string") {
    return messageContent;
  }
  if (Array.isArray(messageContent)) {
    return messageContent
      .map((part) => (typeof part === "string" ? part : part?.text || ""))
      .join("\n")
      .trim();
  }

  throw new Error("API response missing `choices[0].message.content`.");
}

/**
 * Standard Multimodal Chat Turn:
 * Sends user message + optional reference images and conversation history.
 *
 * @param {object} config
 * @param {object} params
 * @param {string} params.userText
 * @param {string[]} [params.imageDataUrls=[]]
 * @param {Array<{role: string, text: string, images?: string[]}>} [params.history=[]]
 * @returns {Promise<string>}
 */
export async function sendMultimodalChat(config, { userText, imageDataUrls = [], history = [] }) {
  const validated = validateRequiredConfig(config);

  const messages = [
    {
      role: "system",
      content: [{ type: "text", text: validated.systemPrompt }]
    }
  ];

  // Include recent conversational context (last 8 turns)
  for (const turn of history.slice(-8)) {
    if (turn.role === "user" || turn.role === "assistant") {
      messages.push({
        role: turn.role,
        content:
          turn.role === "user"
            ? buildMultimodalContentArray(turn.text, turn.images || [])
            : [{ type: "text", text: turn.text }]
      });
    }
  }

  messages.push({
    role: "user",
    content: buildMultimodalContentArray(userText, imageDataUrls)
  });

  return callChatCompletions(validated, messages, { enforceJsonObject: false });
}

/**
 * Batch Prompt Expansion:
 * Requests strict JSON output matching `{"prompts": ["string", "string", "..."]}`
 * using `response_format: {"type": "json_object"}` and defensive fence stripping.
 *
 * @param {object} config
 * @param {object} params
 * @param {string} params.userText
 * @param {string[]} [params.imageDataUrls=[]]
 * @param {Array<{role: string, text: string, images?: string[]}>} [params.history=[]]
 * @returns {Promise<{prompts: string[], raw: string}>}
 */
/**
 * Detects how many prompts the user requested in natural language (e.g., "one image", "3 variations").
 * Defaults to 1 if no plural count is requested.
 * @param {string} userText
 * @param {string|number} [requestedCount="auto"]
 * @returns {number}
 */
export function resolveRequestedPromptCount(userText, requestedCount = "auto") {
  if (typeof requestedCount === "number" && requestedCount >= 1) {
    return Math.min(20, Math.round(requestedCount));
  }
  if (typeof requestedCount === "string" && requestedCount !== "auto") {
    const parsedNum = parseInt(requestedCount, 10);
    if (Number.isFinite(parsedNum) && parsedNum >= 1) {
      return Math.min(20, parsedNum);
    }
  }

  const text = (userText || "").toLowerCase();
  if (!text) return 1;

  // Check explicit single-image phrases first
  if (/\b(one|1|a single|single)\s+(image|prompt|picture|shot|photo|illustration|render)\b/i.test(text)) {
    return 1;
  }

  // Check explicit numeric or word counts (e.g., "3 prompts", "four variations", "5 images")
  const wordToNum = {
    one: 1,
    two: 2,
    couple: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10
  };

  const match =
    /\b(\d+|one|two|couple|three|four|five|six|seven|eight|nine|ten)\s+(?:different\s+|distinct\s+|variations?\s+of\s+)?(images?|prompts?|variations?|shots?|pictures?|illustrations?|renders?|options?|versions?)\b/i.exec(
      text
    );
  if (match) {
    const rawToken = match[1].toLowerCase();
    const n = wordToNum[rawToken] || parseInt(rawToken, 10);
    if (Number.isFinite(n) && n >= 1) {
      return Math.min(20, n);
    }
  }

  // Default to 1 prompt unless the user explicitly asks for multiple
  return 1;
}

export async function generateBatchPrompts(
  config,
  { userText, imageDataUrls = [], history = [], requestedCount = "auto" }
) {
  const validated = validateRequiredConfig(config);
  const allowOverrides = config?.allowAiOverrides !== false;
  const targetCount = resolveRequestedPromptCount(userText, requestedCount);

  const countDirective =
    targetCount === 1
      ? "Generate EXACTLY 1 detailed prompt in the `prompts` array (do NOT generate multiple variations when only 1 image is requested)."
      : `Generate EXACTLY ${targetCount} distinct, detailed prompts in the \`prompts\` array.`;

  const jsonSchemaInstruction = [
    validated.systemPrompt,
    "",
    `CURRENT DEFAULT FLOW SETTINGS: Aspect Ratio = "${config?.aspectRatio || "1:1"}", Target Flow Model = "${config?.targetFlowModel || "Nano Banana 2.1"}", Images per Prompt = ${config?.imagesPerPrompt || 1}.`,
    `ALLOWED ASPECT RATIOS: ${ALLOWED_ASPECT_RATIOS.join(", ")}`,
    `ALLOWED GOOGLE FLOW IMAGE MODELS: ${GOOGLE_FLOW_IMAGE_MODELS.join(", ")}`,
    `ALLOWED IMAGES PER PROMPT: 1, 2, 3, or 4`,
    "",
    "IMPORTANT OUTPUT FORMAT & COUNT REQUIREMENT:",
    countDirective,
    "You MUST respond strictly with a valid JSON object matching this schema:",
    "{",
    '  "aspectRatio": "optional override from ALLOWED ASPECT RATIOS if the user requests a different aspect ratio (e.g. 3:4, 16:9) or null",',
    '  "targetFlowModel": "optional override from ALLOWED GOOGLE FLOW IMAGE MODELS if the user requests a specific image model or null",',
    '  "imagesPerPrompt": "optional integer 1-4 if the user wants multiple outputs per prompt (e.g. 2, 4) or null",',
    '  "prompts": ["detailed generation prompt"]',
    "}",
    "If the user asks for per-prompt variations in aspect ratio, model, or image count, items in `prompts` may also be objects: `{\"prompt\": \"...\", \"aspectRatio\": \"3:4\", \"targetFlowModel\": \"Nano Banana 2.1\", \"imagesPerPrompt\": 2}`.",
    "Do not include markdown code fences."
  ].join("\n");

  const messages = [
    {
      role: "system",
      content: [{ type: "text", text: jsonSchemaInstruction }]
    }
  ];

  for (const turn of history.slice(-6)) {
    if (turn.role === "user" || turn.role === "assistant") {
      messages.push({
        role: turn.role,
        content:
          turn.role === "user"
            ? buildMultimodalContentArray(turn.text, turn.images || [])
            : [{ type: "text", text: turn.text }]
      });
    }
  }

  const promptDirective = userText?.trim()
    ? `${userText.trim()}\n\n${countDirective} Return strictly as JSON.`
    : `Analyze the attached reference image(s). ${countDirective} Return strictly as JSON: {"prompts": ["string"]}`;

  messages.push({
    role: "user",
    content: buildMultimodalContentArray(promptDirective, imageDataUrls)
  });

  const rawContent = await callChatCompletions(validated, messages, {
    enforceJsonObject: true,
    temperature: 0.7
  });

  const parsed = parsePromptsJsonResponse(rawContent);
  // Enforce the exact requested count so the LLM cannot return 5 prompts when 1 was requested
  parsed.prompts = parsed.prompts.slice(0, targetCount);

  if (!allowOverrides) {
    parsed.overrides = { aspectRatio: null, targetFlowModel: null };
    parsed.prompts = parsed.prompts.map((p) => ({
      prompt: p.prompt,
      aspectRatio: null,
      targetFlowModel: null
    }));
  }

  return {
    prompts: parsed.prompts,
    overrides: parsed.overrides,
    raw: rawContent
  };
}

/**
 * Closed-Loop Vision Feedback (Critique):
 * Sends a generated image from Flow along with its original prompt back to the Vision LLM
 * for style/composition analysis and refined prompt variations.
 *
 * @param {object} config
 * @param {object} params
 * @param {string} params.originalPrompt
 * @param {string} params.generatedImageDataUrl
 * @returns {Promise<{critique: string, prompts: string[]}>}
 */
export async function critiqueGeneratedImageWithVision(
  config,
  { originalPrompt, generatedImageDataUrl }
) {
  const validated = validateRequiredConfig(config);

  const systemInstruction = [
    validated.systemPrompt,
    "",
    "You are performing Closed-Loop Vision Feedback on an image generated in Google Labs Flow.",
    "Analyze the attached image against the original prompt for visual fidelity, composition, lighting, and style.",
    "Return a valid JSON object with the following structure:",
    "{",
    '  "critique": "Concise visual analysis of strengths, artifacts, and style alignment...",',
    '  "prompts": ["Refined prompt variation 1", "Refined prompt variation 2"]',
    "}"
  ].join("\n");

  const userDirective = [
    `Original Prompt: "${originalPrompt}"`,
    "Critique this generated output image and provide refined follow-up prompts in JSON format."
  ].join("\n\n");

  const messages = [
    {
      role: "system",
      content: [{ type: "text", text: systemInstruction }]
    },
    {
      role: "user",
      content: buildMultimodalContentArray(userDirective, [generatedImageDataUrl])
    }
  ];

  const rawContent = await callChatCompletions(validated, messages, {
    enforceJsonObject: true,
    temperature: 0.65
  });

  try {
    const parsed = parsePromptsJsonResponse(rawContent);
    return {
      critique:
        parsed.critique ||
        `Vision critique complete. Generated ${parsed.prompts.length} refined prompt variation(s).`,
      prompts: parsed.prompts,
      overrides: parsed.overrides
    };
  } catch (_) {
    // If model returned prose critique without JSON array, still surface the critique cleanly
    return {
      critique: rawContent.trim(),
      prompts: [],
      overrides: { aspectRatio: null, targetFlowModel: null }
    };
  }
}
