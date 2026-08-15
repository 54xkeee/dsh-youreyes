# 👁️ dsh-youreyes

**Eyes for text-only DeepSeek on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).**
给纯文本的 DSH 模型一双眼睛——粘贴图片、截图、文件路径，模型就能"看见"并回答与图片相关的问题。

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-0B7285?style=flat-square" alt="MIT" />
  <img src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node >=20" />
  <img src="https://img.shields.io/badge/dsh-%3E%3D0.1-blue?style=flat-square" alt="DSH" />
</p>

## Why this exists

DeepSeek 的对话模型是纯文本的。DSH 会按模型的 `inputModalities` 拒绝图片附件——粘贴图片会直接报错。本插件补齐这个缺口：

- **对话流识图**：注册带识图能力的包装 provider（`deepseek-vision` / `deepseek-vision-<上游>`），图片附件自动转成文本占位符，模型看到占位符后**主动调用 `vision` 工具**完成理解。
- **独立识图面板**：会话头部「识图」按钮，选图/粘贴 → 提示词 → 模式/档位/通道 → 结果。
- **通用 API 通道**（v0.1）：任意 **OpenAI 兼容**端点（智谱 GLM-4V、通义 Qwen-VL、OpenRouter、本地 vLLM…）、**Google Gemini**、**本地 Ollama**（零配置自动检测）。不依赖任何 IDE 或专有服务。
- **大脑始终是 DeepSeek**：识图只是"眼睛"，回答、推理、工具调用仍然由你选的 DeepSeek 模型完成。

```
用户粘贴图片 ──▶ deepseek-vision 适配器 ──▶ 图片 → [图片附件] 文本占位
                                              │
                                              ▼
                                    DeepSeek 模型（大脑）
                                              │ 看到占位 → 调用 vision 工具
                                              ▼
                              通用视觉通道（openai / gemini / ollama）
                                              │
                                              ▼
                              文字证据回填对话流 → DeepSeek 继续回答
```

## Features

- 🖼️ **对话流图片理解**：包装适配器 + `vision` 工具，模型主动识图，无需手动操作
- 🔀 **多通道**：OpenAI 兼容 / Gemini / 本地 Ollama，通道间可自动降级（fallback）
- 📋 **多图**：一次最多 8 张；`compare` 多图对比、`region` 区域细查、`ocr` 文字提取、`glance` 通用理解
- 🎚️ **档位分流**：`auto` 先标准检查，画面复杂自动升级深度检查
- 🧠 **视觉证据记忆**：每次识图结果写入会话时间线（`<dsh-youreyes-evidence>`），后续轮次可复用，compaction 后自动恢复
- ⚡ **内容哈希缓存**：同一张图同一问题进程内只识别一次（LRU 64 条）
- 🌐 **多语言 UI**：中文 / English 面板
- 🛡️ **安全**：API key 自动脱敏、`allowedImageDirs` 路径白名单（可选）、本地 Ollama 图片不出本机

## Quick start

### 安装

```bash
# 在 DSH profile 中注册（等价于手动 patch cordis.yml）
dsh plugin --profile web add dsh-youreyes --registry=https://registry.npmmirror.com
```

或手动在 `~/.dsh/profiles/web/cordis.patch.yml` 追加：

```yaml
- insert:
    - id: youreyes
      name: dsh-youreyes
      config:
        geminiApiKey: ""            # 或 openaiApiKey
        openaiBaseUrl: https://open.bigmodel.cn/api/paas/v4
        openaiApiKey: ""
        openaiModel: glm-4.6v-flash
```

然后重启 `dsh web`。

### 配置一个通道（至少一个）

**方案 A：Gemini API（免费额度）**
```yaml
config:
  geminiApiKey: AIza...   # https://aistudio.google.com/apikey
  geminiModel: gemini-3.7-flash
```

**方案 B：OpenAI 兼容端点（智谱 GLM-4V 免费档 / 通义 / OpenRouter / 本地 vLLM）**
```yaml
config:
  openaiBaseUrl: https://open.bigmodel.cn/api/paas/v4
  openaiApiKey: xxx
  openaiModel: glm-4.6v-flash
```

**方案 C：本地 Ollama（零配置）**
安装 [Ollama](https://ollama.com) 并拉取一个视觉模型（`llama3.2-vision` / `llava` / `qwen2.5vl`），`autoOllama` 默认开启会自动检测，图片不出本机。

### 使用

1. **面板**：会话头部点「识图」→ 添加/粘贴图片 → 填提示词 → 选模式/档位/通道 → 识别。
2. **对话流**：在模型选择器选 `DeepSeek (Vision Toolkit)`（或 `deepseek-vision-official` 等），直接粘贴图片发送——模型会看到占位符并主动调用 `vision` 工具。

## Configuration

完整配置项（`~/.dsh/profiles/web/cordis.patch.yml` 或运行时覆盖 `~/.dsh/dsh-youreyes.json`）：

| Key | Default | Description |
|---|---|---|
| `defaultChannel` | `auto` | 面板默认通道：`auto` / `openai` / `gemini` / `ollama` |
| `defaultModel` | `gemini-3.7-flash` | 面板默认模型 |
| `openaiBaseUrl` | `https://open.bigmodel.cn/api/paas/v4` | OpenAI 兼容端点（自动追加 `/chat/completions`） |
| `openaiApiKey` | `""` | OpenAI 兼容端点 key（也可用环境变量 `YOUREYES_OPENAI_API_KEY`） |
| `openaiModel` | `glm-4.6v-flash` | OpenAI 兼容端点模型 |
| `geminiApiKey` | `""` | Gemini API key（`AIza…` / `AQ.` 新格式） |
| `geminiModel` | `gemini-3.7-flash` | Gemini 模型 |
| `autoOllama` | `true` | 启动时自动检测本地 Ollama |
| `ollamaBaseUrl` | `http://127.0.0.1:11434` | Ollama 地址 |
| `ollamaModel` | `""` | Ollama 模型（空则自动选视觉模型） |
| `maxTokens` | `2048` | 视觉模型最大输出 token |
| `timeoutMs` | `60000` | 单次请求超时 |
| `maxImageBytes` | `8MB` | 单张图片上限 |
| `maxImages` | `8` | 一次最多图片数 |
| `visionUpstreams` | `["deepseek"]` | 对话流包装 provider 的上游列表（如 `["deepseek", "deepseek-official"]`） |
| `cacheMax` | `64` | 内存 LRU 缓存条数 |
| `allowedImageDirs` | `[]` | 非空时仅允许 `image_path` 读取这些目录 |

## Interfaces

插件提供多层次的接口：

### 1. `vision` 工具（模型主动调用 / Agent 调用）

| 参数 | 类型 | 说明 |
|---|---|---|
| `attachment_id` | string | 单个对话图片附件 id |
| `attachment_ids` | string[] | 多个附件 id（顺序保留） |
| `image_path` / `image_paths` | string / string[] | 本地图片路径 |
| `prompt` | string | 理解要求（传用户原话） |
| `detail` | `auto`/`fast`/`standard`/`deep` | 思考档位 |
| `mode` | `glance`/`ocr`/`region`/`compare` | 任务模式 |
| `region` | string | region 模式区域 |
| `channel` | `auto`/`openai`/`gemini`/`ollama` | 识图通道 |
| `model` | string | 识图模型覆盖 |

返回：`text`（答案）、`channel`、`model`、`detail`、`mode`、`cache_hit`、`escalated`、`evidence_json`、`attachment_ids`。

### 2. `/api/youreyes/vision` HTTP 接口

```bash
curl -X POST http://127.0.0.1:3080/api/youreyes/vision \
  -H "content-type: application/json" \
  -d '{
    "images": [{"image": "<base64>", "mime": "image/jpeg"}],
    "prompt": "图片里有什么动物？",
    "channel": "auto",
    "detail": "auto",
    "mode": "glance"
  }'
```

### 3. 包装 provider（模型选择器可见）

每个上游注册一个带识图能力的 provider：
- `deepseek`（默认上游）→ **`deepseek-vision`**
- `deepseek-official` → **`deepseek-vision-official`**
- 其它上游 `X` → `deepseek-vision-X`

选中后对话里粘贴图片即可走完整识图流程。

## Architecture

```
src/
├── index.ts        # 服务端：适配器注册、vision 工具、/api/youreyes/vision、compaction 恢复
├── vision-core.ts  # 核心：提示词构建、响应归一、证据记录、占位符、流修复
├── channels.ts     # 通用视觉通道：openai / gemini / ollama
└── client/
    ├── entry.ts
    └── plugin.tsx  # 客户端面板（多图/粘贴/模式/档位/通道）
```

- **证据记录**：识图结果以 `<dsh-youreyes-evidence>` 标记写入会话，跨轮复用；`buildVisionManifest` 在请求流中附加视觉记忆清单，模型可据此追问。
- **compaction 恢复**：会话压缩后自动补回近期视觉记录（`rehydrateMax` 条）。
- **流修复**：`repairLegacyPlanningStream` 兼容把工具前规划误报成 text 的上游路由。

## Development

```bash
git clone https://github.com/54xkeee/dsh-youreyes
cd dsh-youreyes
npm install        # 或 pnpm install
npm run build      # esbuild 构建 lib/index.js + lib/client.js
```

> 注：`tsc --noEmit` 因项目沿用 dsh-vision 的宽松类型约定（node 类型未全量引入）可能报少量类型错误；构建以 esbuild 为准。

## License

[MIT](LICENSE)

## Credits

- 架构与特色继承自内部项目 dsh-vision（vision-toolkit：占位符 + vision 工具 + 包装适配器 + 证据记忆）
- 通道与错误处理参考 [dsh-vision-proxy](https://github.com/Flyvhidbwo/dsh-vision-proxy)、[dsh-vision](https://github.com/william-jin-cmu/dsh-vision) 等社区插件的公共约定
