# 👁️ dsh-youreyes

**Eyes for text-only DeepSeek.** Paste images, screenshots, or file paths into [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — and the model can finally "see" and answer image-related questions. DeepSeek stays the brain; vision is just the eyes.

[简体中文](README.zh-CN.md)

<p align="center">
  <a href="https://awesome-dsh-plugin.com"><img src="https://awesome-dsh-plugin.com/badge.svg" alt="awesome · DSH plugin" /></a>
  <a href="https://www.npmjs.com/package/dsh-youreyes"><img src="https://img.shields.io/npm/v/dsh-youreyes?style=flat-square" alt="npm version" /></a>
  <a href="https://github.com/54xkeee/dsh-youreyes/actions"><img src="https://github.com/54xkeee/dsh-youreyes/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <img src="https://img.shields.io/badge/license-MIT-0B7285?style=flat-square" alt="MIT" />
  <img src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node >=20" />
  <a href="https://github.com/54xkeee/dsh-youreyes"><img src="https://img.shields.io/github/stars/54xkeee/dsh-youreyes?style=flat-square" alt="GitHub stars" /></a>
</p>

> **TL;DR**: DeepSeek can't see images? Install this — paste, recognize, answer. Three steps.

## ✨ Why you'll love it

| Pain point | dsh-youreyes solution |
|---|---|
| DeepSeek is text-only; pasting an image is rejected | Wrapper adapters claim image input; images become text placeholders automatically |
| Other vision plugins lock you into one vendor | **Any OpenAI-compatible endpoint** + Gemini + local Ollama — your key just works |
| Setup is a chore with registrations everywhere | **Local Ollama auto-detection, zero config**; one line for a free Gemini key |
| The model "forgets" what it saw | **Vision evidence memory**: results persist in the session, reused across turns, restored after compaction |
| Paying to re-recognize the same image | **Content-hash cache**: same image + same question = recognized once per process |
| Complex images get shallow answers | **Auto detail escalation**: standard pass first, auto-upgrade to deep for complex scenes |
| WSL / firewalled networks can't reach APIs | **winCurl fallback**: native fetch fails → automatically retries via Windows curl |

## 🎯 Real results (2026-08-15, full end-to-end calls)

**Input**: an orange cat photo + *"What animal is this and what is it doing? Answer in Chinese."*

**Output (Gemini channel)**:
> 这是一只橘色虎斑猫（橘猫）。它正四脚朝天、肚皮朝上地仰卧在黑色床单/毯子上安稳地睡觉，姿态非常放松惬意。

**Output (OpenAI-compatible channel · Qwen qwen3.7-flash)**:
> 这是一只**橘猫**（或者叫橘色虎斑猫）。它正**四脚朝天地仰面躺在深色的床单（或毯子）上**。它闭着眼睛，看起来睡得很沉或很香；阳光照在它身上形成了明显的光影；四肢完全伸展，呈现出一种非常舒展、毫无防备的姿态。

```
you paste an image + ask
  → dsh-youreyes turns the image into a placeholder; DeepSeek (the brain) sees it
  → DeepSeek calls the vision tool → a general VLM channel recognizes it
  → text evidence flows back → DeepSeek continues the answer
```

## 🚀 Quick start

### Path 1: Local Ollama (zero config, most private)

```bash
# 1. Install Ollama and pull a vision model
ollama pull llama3.2-vision   # or llava / qwen2.5vl
# 2. Install the plugin (that's ALL you need — no keys!)
dsh plugin --profile web add dsh-youreyes
# 3. Restart dsh web, done
```

The plugin auto-detects a local Ollama at startup (`autoOllama: true` by default). **Images never leave your machine** — no key, no signup, no cost.

### Path 2: Gemini API (free tier, one line of config)

```bash
dsh plugin --profile web add dsh-youreyes
# then add config to your profile's cordis.patch.yml:
```

```yaml
- insert:
    - id: youreyes
      name: dsh-youreyes
      config:
        geminiApiKey: AIza...   # free key at https://aistudio.google.com/apikey
```

### Path 3: Any OpenAI-compatible endpoint (Zhipu / Qwen / OpenRouter / local vLLM…)

```yaml
- insert:
    - id: youreyes
      name: dsh-youreyes
      config:
        openaiBaseUrl: https://open.bigmodel.cn/api/paas/v4   # Zhipu
        openaiApiKey: xxx
        openaiModel: glm-4.6v-flash
```

### Usage

1. **Panel**: click 「识图」 in the session header → add/paste images → prompt → mode/detail/channel → recognize.
2. **In conversation**: pick `DeepSeek (Vision Toolkit)` in the model picker, paste an image and send — the model calls vision automatically.

## 🧪 Verify your setup (60-second channel check)

After installing, hit the HTTP API to confirm the channel works:

```bash
python3 - << 'EOF'
import base64, json, urllib.request
b64 = base64.b64encode(open('test.jpg','rb').read()).decode()
req = urllib.request.Request('http://127.0.0.1:3080/api/youreyes/vision',
  data=json.dumps({'images':[{'image':b64,'mime':'image/jpeg'}],
    'prompt':'What is in this image?','channel':'auto'}).encode(),
  headers={'content-type':'application/json'})
print(json.loads(urllib.request.urlopen(req, timeout=120).read())['text'])
EOF
```

Text description back = channel is live. Errors? See Troubleshooting.

## ⚙️ Configuration

| Key | Default | Description |
|---|---|---|
| `defaultChannel` | `auto` | Panel default: `auto` / `openai` / `gemini` / `ollama` |
| `defaultModel` | `gemini-3.7-flash` | Panel default model |
| `openaiBaseUrl` | `https://open.bigmodel.cn/api/paas/v4` | OpenAI-compatible endpoint (`/chat/completions` appended) |
| `openaiApiKey` | `""` | Endpoint key (or `YOUREYES_OPENAI_API_KEY` env) |
| `openaiModel` | `glm-4.6v-flash` | Endpoint model |
| `geminiApiKey` | `""` | Gemini key (`AIza…` / `AQ.`) |
| `geminiModel` | `gemini-3.7-flash` | Gemini model |
| `autoOllama` | `true` | Auto-detect local Ollama at startup |
| `ollamaBaseUrl` | `http://127.0.0.1:11434` | Ollama address |
| `ollamaModel` | `""` | Ollama model (empty = auto-pick vision model) |
| `winCurlPath` | `""` | WSL fallback: use Windows curl.exe when fetch fails |
| `maxTokens` | `2048` | VLM max output tokens |
| `timeoutMs` | `60000` | Request timeout |
| `maxImageBytes` | `8MB` | Per-image limit |
| `maxImages` | `8` | Max images per call |
| `visionUpstreams` | `["deepseek"]` | Upstream LLM providers to wrap for conversation vision |
| `cacheMax` | `64` | In-memory LRU cache size |
| `allowedImageDirs` | `[]` | If set, `image_path` only reads these dirs |

## 🎨 Backend matrix

| Scenario | baseURL | Example models | Notes |
|---|---|---|---|
| **Local Ollama (auto)** | `http://127.0.0.1:11434` | `llama3.2-vision` / `llava` | Zero config, images stay local |
| **Zhipu (free tier)** | `https://open.bigmodel.cn/api/paas/v4` | `glm-4.6v-flash` | Free tier, signup only |
| **Qwen / DashScope** | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen3-vl-flash` | Cheap, fast, no rate limit |
| **Gemini (free quota)** | (built-in) | `gemini-3.7-flash` | Free AI Studio key |
| **OpenRouter** | `https://openrouter.ai/api/v1` | `qwen/qwen-2.5-vl-72b` | One key, every model |
| **Local vLLM / any gateway** | yours | yours | Anything speaking `/chat/completions` |

## 🔧 Troubleshooting

| Symptom | Cause & fix |
|---|---|
| `gemini channel: 503 high demand` | Gemini temporarily overloaded; retry or switch model |
| `fetch failed` (then fails again) | Network blocked (WSL/GFW): set `winCurlPath: /mnt/c/Windows/System32/curl.exe` to use the Windows network stack |
| `401 / auth` | Wrong or expired key; check config |
| `model not found` | Wrong model id, or the endpoint doesn't have it |
| Image over limit | Single >8MB or >8 images; compress first |
| Panel click does nothing | Refresh the browser to reload the client bundle |

## 🔒 Privacy

- **Default**: images go to the channel you configure (OpenAI-compatible / Gemini). **With local Ollama, images never leave your machine.**
- **API keys**: stored in config only; error messages are auto-redacted (`***`), never logged.
- **Image content**: sent to the vision endpoint only for recognition; the text result is written to your session and can be deleted anytime.

## 🏗️ Architecture (for plugin developers)

```
src/
├── index.ts        # server: adapter registration, vision tool, /api/youreyes/vision, compaction rehydration
├── vision-core.ts  # core: prompt building, response normalization, evidence records, placeholders, stream repair
├── channels.ts     # general VLM channels: openai / gemini / ollama (with winCurl fallback)
└── client/
    ├── entry.ts
    └── plugin.tsx  # client panel (multi-image / paste / mode / detail / channel)
```

- **Evidence memory**: results are written into the session timeline as `<dsh-youreyes-evidence>` records, reused across turns; a vision memory manifest is attached to request streams so the model can follow up.
- **Compaction rehydration**: recent vision records are restored after session compaction.
- **Stream repair**: handles upstream routes that mislabel pre-tool planning as text.
- **Three interfaces**: the `vision` tool (agent calls), `/api/youreyes/vision` (HTTP), and wrapper providers (model picker).

## 🛠️ Development

```bash
git clone https://github.com/54xkeee/dsh-youreyes
cd dsh-youreyes
npm install
npm run build     # esbuild → lib/index.js + lib/client.js
npm test          # node --test (19 tests)
```

## 📄 License

[MIT](LICENSE)

## 🙏 Credits

- Architecture and features inherited from the internal dsh-vision project (vision-toolkit: placeholders + vision tool + wrapper adapters + evidence memory)
- Channel and error-handling conventions follow community plugins like [dsh-vision-proxy](https://github.com/Flyvhidbwo/dsh-vision-proxy) and [dsh-vision](https://github.com/william-jin-cmu/dsh-vision)
