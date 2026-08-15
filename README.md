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
| Other vision plugins lock you into one vendor | **Antigravity (default) + any OpenAI-compatible endpoint** + Gemini + local Ollama — your key just works |
| Paying per image recognition | **Antigravity IDE quota by default** (flash/pro tiers) when the IDE is running; free local Ollama otherwise |
| Setup is a chore with registrations everywhere | **Local Ollama auto-detection, zero config**; one line for a free Gemini key |
| The model "forgets" what it saw | **Vision evidence memory**: results persist in the session, reused across turns, restored after compaction |
| Paying to re-recognize the same image | **Content-hash cache**: same image + same question = recognized once per process |
| Complex images get shallow answers | **Auto detail escalation**: standard pass first, auto-upgrade to deep for complex scenes |
| WSL / firewalled networks can't reach APIs | **winCurl fallback**: native fetch fails → automatically retries via Windows curl |

## 🎯 Real results (2026-08-15, full end-to-end calls)

**Input**: an orange cat photo + *"What animal is this and what is it doing? Answer in Chinese."*

**Output (Antigravity channel · flash tier — default)**:
> 这是一只**橘猫**（橘色虎斑家猫）。它正仰面熟睡/惬意放松：四脚朝天、露出圆滚滚毛茸茸的肚子，正舒适地躺在深色床垫/毯子上睡觉。双眼闭合，前爪向上举起并露出了粉嫩的小肉垫，显得十分放松和安心。

**Output (Gemini channel)**:
> 这是一只橘色虎斑猫（橘猫）。它正四脚朝天、肚皮朝上地仰卧在黑色床单/毯子上安稳地睡觉，姿态非常放松惬意。

**Output (OpenAI-compatible channel · Qwen qwen3.7-flash)**:
> 这是一只**橘猫**（或者叫橘色虎斑猫）。它正**四脚朝天地仰面躺在深色的床单（或毯子）上**。它闭着眼睛，看起来睡得很沉或很香；阳光照在它身上形成了明显的光影；四肢完全伸展，呈现出一种非常舒展、毫无防备的姿态。

```
you paste an image + ask
  → dsh-youreyes turns the image into a placeholder; DeepSeek (the brain) sees it
  → DeepSeek calls the vision tool → Antigravity (default) / other VLM channels recognize it
  → text evidence flows back → DeepSeek continues the answer
```

## 🧠 The vision engine — how complex recognition actually works

A naive "see → describe" loop fails on dense screenshots, tables, UI mockups and multi-image comparisons. dsh-youreyes turns recognition into a **structured, self-escalating, memory-backed pipeline**:

### 1. Auto detail escalation — it knows when one pass isn't enough

`detail: auto` runs a **two-pass strategy**:

```
pass 1 (standard + triage) ──▶ complexity == "simple" ──▶ done
                            └─▶ complexity == "complex" ──▶ pass 2 (deep) ──▶ escalated result
```

The vision model itself classifies complexity. These all count as **complex** and trigger the deep pass automatically:

- multi-subject relationships · dense small text · OCR-heavy content
- tables / charts / code / UI screens · counting · comparison / spot-the-difference
- professional imagery · multi-step spatial reasoning

The response carries an `escalated` flag so you always know which pass answered.

### 2. Four task modes, one tool

| Mode | What it does | Typical use |
|---|---|---|
| `glance` | general understanding, evidence selected around your question | everyday questions |
| `ocr` | transcribes visible text in natural reading order, preserving headings/tables/UI hierarchy | screenshots, docs, error messages |
| `region` | focuses on one area — normalized coords `0.1,0.2,0.8,0.9` **or** plain language (`"top right"`) | UI bugs, chart details |
| `compare` | item-by-item differences between ≥2 images, with confidence | before/after, versions, A/B |

### 3. Structured evidence, not raw prose

Every pass asks the VLM for a **strict JSON evidence object**:

```json
{
  "complexity": "simple|complex",
  "base_evidence": {
    "summary": "neutral overview",
    "ocr": "visible text (empty if none)",
    "layout": ["layout observations"],
    "entities": ["entities"],
    "relations": ["relations"],
    "uncertainty": ["explicit unknowns"]
  },
  "query_answer": "direct answer to the user"
}
```

Observations vs. inference are separated, uncertainty is made explicit (never hallucinated), and every list is capped (≤8 items, ≤160 chars) to keep the context tight.

### 4. Long-context visual memory — the model never "forgets" what it saw

This is the part that makes recognition useful **across turns**:

- Every result is written into the **session timeline** as a durable `<dsh-youreyes-evidence>` record (a plugin notice message), not just returned once.
- **Reuse across turns**: the same image + same question hits the existing record — recognized once, remembered forever.
- **Vision memory manifest**: every request stream carries a compact catalog of recent evidence (`attachment=… | mode=… | detail=… | summary`), so the model can follow up — zoom in on a region, re-OCR, compare against a new screenshot — without you re-pasting anything.
- **Compaction rehydration**: after DSH compresses a long session, the most recent vision records are **restored automatically** — memory survives summarization.

### 5. Content-hash caching — never pay twice for the same pixels

Cache key = `SHA-256(image bytes) + prompt + detail + mode + region + model + channel + prompt-version`. An in-process LRU (64 entries) means the same image asked the same way is recognized **at most once per process** — even across conversations.

### 6. Stream repair for flaky upstreams

`repairLegacyPlanningStream` re-labels pre-tool planning that some OpenAI-compatible DeepSeek routes misreport as text — so tool-calling flows stay clean on every backend.

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

### Path 0: Antigravity IDE (default when configured)

If you use [Antigravity IDE](https://antigravity.io) (already running + logged in), configure it as the default recognition channel — recognition goes through your **IDE subscription quota** (flash/pro tiers, auto-selected by model name):

```yaml
- insert:
    - id: youreyes
      name: dsh-youreyes
      config:
        antigravityWorkspace: /path/to/workspace
        antigravityProjectId: your-project-id
        antigravityLsExe: /path/to/language_server.exe
        antigravityWindowsHome: /mnt/c/Users/you
        antigravityBrainDir: /mnt/c/Users/you/.gemini/antigravity/brain
```

Ports/CSRF are auto-discovered on every call — no manual config after IDE restarts. When the IDE is unavailable, the channel falls back to Gemini → OpenAI → Ollama automatically.

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
| `defaultChannel` | `auto` | Panel default: `auto` (Antigravity first) / `antigravity` / `openai` / `gemini` / `ollama` |
| `defaultModel` | `gemini-3.7-flash` | Panel default model (name containing `pro` → Antigravity pro tier) |
| `antigravityWorkspace` | `""` | Antigravity IDE workspace (WSL path) |
| `antigravityProjectId` | `""` | Antigravity project id |
| `antigravityLsExe` | `""` | Antigravity `language_server.exe` path |
| `antigravityWindowsHome` | `""` | Windows home dir (for the project file) |
| `antigravityBrainDir` | `""` | Antigravity brain transcript dir |
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
| `visionUpstreams` | `["deepseek", "opencode-go"]` | Upstream LLM providers to wrap for conversation vision (e.g. `deepseek-vision` + `deepseek-vision-opencode-go`) |
| `cacheMax` | `64` | In-memory LRU cache size |
| `allowedImageDirs` | `[]` | If set, `image_path` only reads these dirs |

## 🎨 Backend matrix

| Scenario | baseURL | Example models | Notes |
|---|---|---|---|
| **Antigravity IDE (default)** | (agentapi) | `gemini-3.7-flash` / `gemini-3.7-pro` | Uses your IDE quota; flash/pro tiers auto-selected; ports/CSRF auto-discovered |
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
