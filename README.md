# Flow Sidecar Orchestrator

A Chrome / Brave extension that puts an AI prompt assistant and a batch queue in the browser's side panel and drives **[Google Flow](https://flow.google.com)** for you: it writes prompts, applies Flow's image settings, starts each generation, waits for the result and downloads it, one queue item after another.

> **Unofficial.** This project is not affiliated with, endorsed by, or supported by Google. It automates Flow's web UI in your own browser session, so it can break whenever Flow's interface changes, and every generation uses your own Flow credits. Use it in line with Google's terms of service.

---

## What it does

| | |
|---|---|
| **AI prompt assistant** | Chat with any OpenAI-compatible text model in the side panel. Attach reference images and the model describes their style, lighting and composition, then writes detailed image prompts. |
| **Batch prompt expansion** | Ask for "8 variations of …" and the assistant returns a list of prompts that go straight into the queue. Per-prompt aspect ratio, model and image count can be set by the AI if you allow it. |
| **Execution queue** | ▶ Start / ⏸ Pause / 🗑 Clear. Items run one by one with a configurable pause between them; each row shows its status, settings and result thumbnail. |
| **Flow automation** | For every item it opens Flow's **Agent settings**, sets the *Image generation default* (aspect ratio, x1–x4 images, model), saves, types the prompt, clicks **Start generation**, and checks that generation really started before it waits. |
| **Downloads** | Opens each new image and uses Flow's own **Download** button, so you get Flow's native file. 1K original size by default, or 2K upscaled with one checkbox. Files can go into a subfolder of Downloads or any folder you pick. |
| **Vision critique** | Click **Critique with Vision AI** on a finished queue item to send the image back to the model, which critiques it against the prompt and queues improved variations. |
| **Img2Img reference** | Attach one reference image that is uploaded into Flow together with every prompt. |

Supported Flow image settings (as of November 2026):

- **Aspect ratio:** 16:9, 4:3, 1:1, 3:4, 9:16
- **Images per prompt:** x1, x2, x3, x4
- **Models:** Nano Banana 2.1, Nano Banana Pro, Nano Banana 2 Lite

---

## What you need

1. **Chrome or Brave** (desktop, any recent version). Edge and other Chromium browsers should also work. Firefox is not supported, see [Browser support](#browser-support).
2. **A Google account with access to [Google Flow](https://flow.google.com)** and enough credits for what you queue. Stay signed in to Flow in the same browser.
3. **An OpenAI-compatible text model API** for the assistant (see below).

### The text model API

The side panel talks to any service that implements the OpenAI **Chat Completions** API (`POST {Base URL}/chat/completions`). You enter three things in the settings drawer:

| Setting | Example | Notes |
|---|---|---|
| **Base URL** *(required)* | `https://api.openai.com/v1` | The URL up to and including `/v1`. A full `…/chat/completions` URL also works. |
| **API Key** | `sk-…` | Sent as `Authorization: Bearer <key>`. Leave empty for local servers that don't need one. |
| **Model Name** *(required)* | `gpt-4o-mini` | Type it, or click **🔄 Fetch Models** to load the list from `{Base URL}/models`. |

What the model should support:

- **Vision (image input)** for reference images and vision critique. Images are sent as standard `image_url` parts with `data:` URLs, downscaled to 1024 px. Text-only models still work for plain prompt writing.
- **JSON output.** Batch expansion requests `response_format: {"type": "json_object"}`. Models that ignore this usually still work, because the reply is parsed defensively.

Providers that work this way include, for example:

| Provider | Base URL |
|---|---|
| OpenAI | `https://api.openai.com/v1` |
| OpenRouter (many models behind one key) | `https://openrouter.ai/api/v1` |
| Google Gemini (OpenAI-compatible endpoint) | `https://generativelanguage.googleapis.com/v1beta/openai` |
| Groq | `https://api.groq.com/openai/v1` |
| Ollama (local) | `http://localhost:11434/v1` |
| LM Studio (local) | `http://localhost:1234/v1` |

Your API key is stored only in the extension's local storage in your browser (`chrome.storage.local`) and is sent only to the Base URL you enter.

---

## Installation

### Option A: Load unpacked (recommended)

1. Download the latest **`flow-sidecar-orchestrator-x.y.z.zip`** from [Releases](../../releases) and unzip it, or clone this repository.
2. Open `chrome://extensions` (Chrome) or `brave://extensions` (Brave).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the unzipped folder, or the **`flow-sidecar-extension`** folder in the cloned repository. Pick the folder that contains `manifest.json`.
5. Pin the extension and click its icon to open the side panel.

To update, replace the folder's contents with a newer release and click **⟳ Reload** on the extension card. Your settings are kept.

### Option B: The `.crx` package

Releases also include a signed `flow-sidecar-orchestrator-x.y.z.crx`. Chrome on Windows and macOS only installs `.crx` files from the Chrome Web Store, so use Option A there. Brave and Chromium on Linux usually accept it if you drag the file onto the extensions page with Developer mode on.

---

## Usage

1. Open a project in **Google Flow** (`https://flow.google.com/project/…`) and keep that tab open.
2. Click the extension icon to open the side panel. In **Settings**, enter your Base URL, API key and model, then click **💾 Save Configuration**.
3. Choose the defaults for the queue: aspect ratio, Flow model, images per prompt, download folder, and whether to upscale downloads.
4. In the chat, describe what you want, optionally attach reference images, choose how many prompts you want, and click **✨ Generate Prompts**. The prompts are added to the queue.
5. Click **▶ Start Queue**. Watch the Flow tab: the extension switches settings, starts each generation and downloads the results. You can **⏸ Pause** at any time.

### Download folder

- **Subfolder name:** type a name such as `Flow_Batches`. Images are saved to `Downloads/Flow_Batches`.
- **📂 Choose Folder:** picks any folder on disk. This needs the browser's File System Access API, which Chrome has. Brave turns it off by default: enable `brave://flags/#file-system-access-api` and restart Brave, or use a subfolder name.
- **Save As dialog:** asks where to save each file.
- **Tip:** to keep everything on another drive without any flags, change the browser's download location (`chrome://settings/downloads` or `brave://settings/downloads`) and use a subfolder name.

### Things to know

- **"Started debugging this browser" bar:** Flow ignores script-generated clicks on its *Start generation* button, so the extension clicks it through Chrome's debugger API (`Input.dispatchMouseEvent`). Chrome shows this bar while the click happens and removes it again right after. If you dismiss the bar with *Cancel* during a click, that one item fails and you can run it again.
- **Keep the Flow tab visible** while a queue runs. Background tabs are throttled and timing can break.
- **Agent mode "Confirm before generating":** if Flow's Agent is set to *Always* ask, Flow may wait for your confirmation. Set it to *Never* in Flow's Agent settings for unattended runs.
- **Debug output:** the Flow tab's console (F12) logs every step with the prefix `[FlowSidecar]`, including which settings were applied and which download size was picked.

---

## Permissions

| Permission | Why |
|---|---|
| `sidePanel` | The extension's UI lives in the browser side panel. |
| `storage` | Saves your settings (including the API key) locally. |
| `tabs`, `activeTab`, `scripting` | Finds the Flow tab and injects the automation script into it. |
| `debugger` | Sends a real (trusted) mouse click to Flow's *Start generation* button. Only used on the Flow tab, only for that click. |
| `downloads` | Saves results and routes Flow's own downloads into your chosen folder. |
| Host access to `flow.google.com` / `labs.google` | Runs the automation on Flow. |
| Host access to `<all_urls>` | Lets the side panel call whatever API Base URL you configure (including `localhost`). |

---

## Browser support

| Browser | Status |
|---|---|
| Chrome | ✅ Supported |
| Brave | ✅ Supported. *Choose Folder* needs `brave://flags/#file-system-access-api`; subfolders in Downloads work without it. |
| Edge, other Chromium browsers | Should work, not tested |
| Firefox | ❌ Not supported. Firefox has no `debugger` or `sidePanel` API and no folder picker, and Flow ignores the script-generated clicks Firefox would have to rely on. |

---

## Project structure

```text
flow-sidecar-extension/          ← load this folder as the unpacked extension
├── manifest.json                Manifest V3
├── background/
│   └── service-worker.js        Side panel, Flow tab discovery, trusted click, download routing
├── sidepanel/
│   ├── index.html / sidepanel.css / sidepanel.js   UI, settings, chat, queue runner
│   ├── api-client.js            OpenAI-compatible client: chat, /models, batch JSON, vision critique
│   └── image-utils.js           Image downscaling, folder-handle storage, direct folder writes
├── content/                     Injected into the Flow tab
│   ├── dom-selectors.js         Robust element finding (Angular Material, shadow DOM)
│   ├── dom-actions.js           Settings, prompt input, submit + verification, completion, download
│   └── content.js               Runs one queue item end to end
└── assets/icons/
docs/                            Architecture notes and the original specification
```

There is no build step: the extension is plain JavaScript. See [`docs/AGENT_HANDOFF.md`](docs/AGENT_HANDOFF.md) for architecture details and known pitfalls when Flow's UI changes.

### Packaging a release

```bash
cd flow-sidecar-extension && zip -r -X ../dist/flow-sidecar-orchestrator-<version>.zip manifest.json assets background content sidepanel
```

Bump `"version"` in `manifest.json` first. To build a signed `.crx`, use the browser's **Pack extension** button on the extensions page (or `--pack-extension`) and always reuse the same private key (`.pem`) so the extension ID stays the same. Never commit the key.
