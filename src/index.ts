import { readFileSync, existsSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import {
	VISION_MODEL,
	VISION_PROMPT_VERSION,
	VisionPromiseCache,
	normalizeDetail,
	normalizeVisionMode,
	normalizeVisionResponse,
	buildVisionPrompt,
	visionCacheKey,
	sha256,
	makeVisionRecord,
	visionRecordText,
	isVisionRecordMessage,
	visionRecordsFromMessages,
	findVisionRecord,
	buildVisionManifest,
	collectMessageAttachmentRefs,
	flattenMessageContent,
	repairLegacyPlanningStream
} from "./vision-core.ts";
import { openaiChat, geminiGenerate, ollamaChat, detectOllama } from "./channels.ts";

/**
 * dsh-youreyes — server half.
 *
 * 给纯文本 DSH 模型一双眼睛。图片经通用视觉通道（OpenAI 兼容 / Gemini / 本地
 * Ollama）理解后，把文字证据送回对话流，DeepSeek 仍然是大脑。
 *
 * v0.1 通道（不依赖任何 IDE/反重力）：
 *   - openai : 任意 OpenAI 兼容 /chat/completions（智谱、通义、OpenRouter、vLLM…）
 *   - gemini : Google Gemini Developer API（AIza… 或 AQ. 新格式 key）
 *   - ollama : 本地 Ollama（零配置自动检测，图片不出本机）
 *
 * 特色（继承自 vision-toolkit）：
 *   1) 包装适配器：每个上游 LLM 注册一个带识图能力的 provider，图片块→文本占位
 *   2) vision 工具：模型看到占位符后主动调用（单图/多图/OCR/区域/对比 + 档位分流）
 *   3) 视觉证据：结果写入会话时间线，跨轮复用、compaction 后自动恢复
 */

export const name = "dsh-youreyes";
export const inject = ["webServer", "llm", "tools", "sessions", "attachments"];

const VISION_PROVIDER = "deepseek-vision";
const IMAGE_PLACEHOLDER_PREFIX = "[图片附件 attachment=";

/** 包装 provider 命名：deepseek → deepseek-vision；其它上游 → deepseek-vision-<上游名>。 */
function visionProviderName(upstreamProvider: string) {
	if (upstreamProvider === "deepseek") return VISION_PROVIDER;
	return `${VISION_PROVIDER}-${upstreamProvider}`;
}

/** 通道配置：每个通道可独立设置 baseURL / apiKey / model。 */
export const Config = z.object({
	// 面板与 /api/youreyes/vision 的默认通道与模型
	defaultChannel: z.union([
		z.const("auto"),
		z.const("openai"),
		z.const("gemini"),
		z.const("ollama")
	]).default("auto"),
	defaultModel: z.string().default("gemini-3.7-flash"),
	// OpenAI 兼容通道（智谱 / 通义 / OpenRouter / 本地 vLLM…）
	openaiBaseUrl: z.string().default("https://open.bigmodel.cn/api/paas/v4"),
	openaiApiKey: z.string().default(""),
	openaiModel: z.string().default("glm-4.6v-flash"),
	// Gemini Developer API 通道
	geminiApiKey: z.string().default(""),
	geminiModel: z.string().default("gemini-3.7-flash"),
	// 本地 Ollama（autoOllama 开启时自动检测）
	autoOllama: z.boolean().default(true),
	ollamaBaseUrl: z.string().default("http://127.0.0.1:11434"),
	ollamaModel: z.string().default(""),
	// WSL/受限网络降级：原生 fetch 失败时用 Windows curl.exe 重试（如 /mnt/c/Windows/System32/curl.exe）
	winCurlPath: z.string().default(""),
	// 通用请求参数
	maxTokens: z.number().default(2048),
	timeoutMs: z.number().default(60000),
	maxImageBytes: z.number().default(8 * 1024 * 1024),
	maxImages: z.number().default(8),
	// vision-toolkit: 每个上游各注册一个识图包装 provider（对话流识图）
	visionUpstreams: z.array(z.string()).default(["deepseek"]),
	// 视觉结果内存 LRU 与会话清单上限
	cacheMax: z.number().default(64),
	manifestMax: z.number().default(12),
	rehydrateMax: z.number().default(4),
	// 空数组保持旧版 image_path 行为；配置后仅接收这些目录中的本地图片
	allowedImageDirs: z.array(z.string()).default([]),
	// 旧的单值上游字段（兼容）
	upstreamProvider: z.string().default("deepseek")
});

function configFile() {
	const home = process.env.DSH_HOME || join(homedir(), ".dsh");
	return join(home, "dsh-youreyes.json");
}

function loadOverrides() {
	try {
		const p = configFile();
		if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
	} catch {
		/* ignore */
	}
	return {};
}

function abortableDelay(ms: number, signal?: AbortSignal) {
	return new Promise<void>((resolveDelay, reject) => {
		if (signal?.aborted) return reject(signal.reason || new Error("aborted"));
		const timer = setTimeout(done, ms);
		function done() {
			signal?.removeEventListener("abort", aborted);
			resolveDelay(undefined);
		}
		function aborted() {
			clearTimeout(timer);
			reject(signal.reason || new Error("aborted"));
		}
		signal?.addEventListener("abort", aborted, { once: true });
	});
}

/** attachmentId -> 完整 ImageAttachmentRef（含 bytes/尺寸，供 readImage 完整性校验） */
const attachmentRefs = new Map<string, any>();
const visionCache = new VisionPromiseCache();

function restoreRecordAttachmentRefs(records: any[]) {
	for (const record of records || []) {
		for (const ref of record.attachmentRefs || []) {
			if (ref?.attachmentId) attachmentRefs.set(ref.attachmentId, ref);
		}
	}
}

/**
 * 通道分派：openai / gemini / ollama。
 * 返回 { text } 或 { error }，与上游 API 的差异全部在此归一。
 */
async function runVisionChannel(cfg: any, channel: string, model: string, prompt: string, images: { b64: string; mime: string }[], signal?: AbortSignal) {
	const common = {
		prompt,
		images,
		maxTokens: cfg.maxTokens,
		timeoutMs: cfg.timeoutMs,
		signal,
		fetchImpl: globalThis.fetch,
		winCurl: cfg.winCurlPath || ""
	};
	const timeoutSignal = AbortSignal.timeout(cfg.timeoutMs || 60000);
	const mergedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	try {
		if (channel === "openai") {
			const text = await openaiChat({
				...common,
				baseURL: cfg.openaiBaseUrl || "https://open.bigmodel.cn/api/paas/v4",
				apiKey: cfg.openaiApiKey || "",
				model: model || cfg.openaiModel || "glm-4.6v-flash",
				signal: mergedSignal
			});
			return { text };
		}
		if (channel === "gemini") {
			if (!cfg.geminiApiKey) return { error: "未配置 geminiApiKey（Gemini API key）。可在 ~/.dsh/dsh-youreyes.json 填写，或在插件配置里设置。" };
			const text = await geminiGenerate({
				...common,
				baseURL: "",
				apiKey: cfg.geminiApiKey,
				model: model || cfg.geminiModel || VISION_MODEL,
				signal: mergedSignal
			});
			return { text };
		}
		if (channel === "ollama") {
			const text = await ollamaChat({
				...common,
				baseURL: cfg.ollamaBaseUrl || "http://127.0.0.1:11434",
				apiKey: "",
				model: model || cfg.ollamaModel || "llava",
				signal: mergedSignal
			});
			return { text };
		}
		return { error: `未知 channel: ${channel}` };
	} catch (error) {
		if (signal?.aborted) throw signal.reason || error;
		return { error: String(error?.message || error).slice(0, 1200) };
	}
}

/** auto 档位：先 standard triage，复杂画面自动升级 deep。 */
async function runAdaptiveVision(cfg: any, channel: string, requestedModel: string, detail: string, visionMode: string, userPrompt: string, region: string, images: { b64: string; mime: string }[], signal?: AbortSignal) {
	const selectedDetail = normalizeDetail(detail);
	const selectedMode = normalizeVisionMode(visionMode);
	const model = requestedModel || cfg.defaultModel || VISION_MODEL;
	const runOne = async (oneDetail: string, triage: boolean) => {
		const prompt = buildVisionPrompt({
			detail: oneDetail,
			mode: selectedMode,
			userPrompt,
			region,
			imageCount: images.length,
			triage
		});
		const raw = await runVisionChannel(cfg, channel, model, prompt, images, signal);
		if (raw.error) return raw;
		const normalized = normalizeVisionResponse(raw.text);
		return { text: normalized.answer, evidence: normalized.evidence, complexity: normalized.complexity, structured: normalized.structured, truncatedBytes: normalized.truncatedBytes };
	};

	if (selectedDetail !== "auto") {
		const result = await runOne(selectedDetail, false);
		return { ...result, detail: selectedDetail, mode: selectedMode, model, escalated: false };
	}
	const first = await runOne("standard", true);
	if (first.error) return { ...first, detail: "auto", mode: selectedMode, model, escalated: false };
	if (first.complexity !== "complex") {
		return { ...first, detail: "auto", mode: selectedMode, model, escalated: false };
	}
	const deep = await runOne("deep", false);
	if (deep.error) {
		return { ...first, detail: "auto", mode: selectedMode, model, escalated: false, escalationError: deep.error };
	}
	return { ...deep, detail: "auto", mode: selectedMode, model, escalated: true };
}

/** 包装适配器：图片占位化后转发给指定上游 provider。 */
function createVisionAdapter(ctx: any, cfg: any, wrapperName: string, upstreamProvider: string) {
	if (upstreamProvider === wrapperName || upstreamProvider === VISION_PROVIDER || upstreamProvider.startsWith(`${VISION_PROVIDER}-`)) {
		throw new Error(`upstreamProvider 禁止指向包装适配器自身: ${upstreamProvider}`);
	}
	const upstream = (options: any) => ctx.llm.stream({ ...options, provider: upstreamProvider });
	const exposeVision = (provider: string, info: any) => ({
		...info,
		provider,
		inputModalities: ["text", "image"]
	});
	return {
		providerInfo(provider: string) {
			return {
				id: provider,
				name: upstreamProvider === "deepseek"
					? "DeepSeek (Vision Toolkit)"
					: `${upstreamProvider} (Vision Toolkit)`
			};
		},
		providerRetryPolicy() {
			return undefined;
		},
		async listModels(provider: string) {
			try {
				const models = await ctx.llm.listModels(upstreamProvider);
				return models.map((model: any) => exposeVision(provider, model));
			} catch (error) {
				ctx.logger?.warn(`[dsh-youreyes] 读取上游 ${upstreamProvider} 模型目录失败，使用兼容目录: ${String(error?.message || error).slice(0, 200)}`);
				return [
					exposeVision(provider, { id: "deepseek-v4-flash-0731", name: "DeepSeek V4 Flash" }),
					exposeVision(provider, { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" })
				];
			}
		},
		async resolveModel(provider: string, model: string, signal?: AbortSignal) {
			try {
				const info = await ctx.llm.resolveModelInfo(upstreamProvider, model, signal);
				return exposeVision(provider, info);
			} catch {
				return { provider, id: model, name: model, inputModalities: ["text", "image"] };
			}
		},
		async *stream(options: any) {
			const session = options.sessionId ? ctx.get("sessions")?.get(options.sessionId) : undefined;
			const sessionMessages = session?.deriveMessages() || [];
			collectMessageAttachmentRefs(sessionMessages, attachmentRefs);
			const records = visionRecordsFromMessages(sessionMessages.length ? sessionMessages : options.messages || []);
			restoreRecordAttachmentRefs(records);
			const messages = (options.messages || [])
				.filter((message: any) => !isVisionRecordMessage(message))
				.map((message: any) => ({
					...message,
					content: message.content ? flattenMessageContent(message.content, attachmentRefs) : message.content
				}));
			const manifest = buildVisionManifest(records, cfg.manifestMax);
			if (manifest) {
				messages.push(createUserMessage({
					content: [{ type: "text", text: manifest }],
					source: { kind: "plugin", plugin: "dsh-youreyes", form: "catalog" }
				}));
			}
			const result = await upstream({ ...options, messages });
			for await (const chunk of repairLegacyPlanningStream(result)) yield chunk;
		}
	};
}

function pathIsAllowed(cfg: any, imagePath: string) {
	const roots = Array.isArray(cfg.allowedImageDirs) ? cfg.allowedImageDirs.filter(Boolean) : [];
	if (!roots.length) return true;
	const candidate = realpathSync(imagePath);
	return roots.some((root: string) => {
		let resolvedRoot: string;
		try { resolvedRoot = realpathSync(root); } catch { resolvedRoot = resolve(root); }
		return candidate === resolvedRoot || candidate.startsWith(resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep);
	});
}

function mimeForPath(imagePath: string) {
	const lower = String(imagePath).toLowerCase();
	if (lower.endsWith(".png")) return "image/png";
	if (lower.endsWith(".webp")) return "image/webp";
	if (lower.endsWith(".gif")) return "image/gif";
	return "image/jpeg";
}

function uniqueStrings(values: any) {
	return [...new Set(values.filter((value: any) => typeof value === "string" && value.trim()).map((value: string) => value.trim()))];
}

async function cachedVision(key: string, maximum: number, producer: () => Promise<any>) {
	const cached = visionCache.get(key);
	if (cached) return { result: await cached, cacheHit: true };
	const pending = producer();
	visionCache.set(key, pending, maximum);
	try {
		const result = await pending;
		if (result.error) visionCache.delete(key);
		return { result, cacheHit: false };
	} catch (error) {
		visionCache.delete(key);
		throw error;
	}
}

/** vision 工具：支持单图、多图、OCR、区域细查与对比，并把证据写入当前 Session 时间线。 */
function registerVisionTool(ctx: any, cfg: any) {
	const run = async (args: any, exec: any) => {
		const prompt = String(args.prompt || "用中文详细描述图片内容").trim();
		const detail = normalizeDetail(args.detail);
		const mode = normalizeVisionMode(args.mode);
		const region = String(args.region || "").trim();
		const attachmentIds = uniqueStrings([args.attachment_id, ...(Array.isArray(args.attachment_ids) ? args.attachment_ids : [])]);
		const imagePaths = uniqueStrings([args.image_path, ...(Array.isArray(args.image_paths) ? args.image_paths : [])]);
		if (!attachmentIds.length && !imagePaths.length) return { error: "需要 attachment_id、attachment_ids、image_path 或 image_paths" };
		if (attachmentIds.length + imagePaths.length > cfg.maxImages) return { error: `一次最多处理 ${cfg.maxImages} 张图片` };
		if (mode === "compare" && attachmentIds.length + imagePaths.length < 2) return { error: "compare 模式至少需要 2 张图片" };
		if (mode === "region" && !region) return { error: "region 模式需要 region，例如 0.1,0.2,0.8,0.9" };

		const messages = exec.agent?.session?.deriveMessages() || [];
		collectMessageAttachmentRefs(messages, attachmentRefs);
		const records = visionRecordsFromMessages(messages);
		restoreRecordAttachmentRefs(records);
		const attachments = ctx.get("attachments");
		const images: any[] = [];
		for (const id of attachmentIds) {
			const ref = attachmentRefs.get(id);
			if (!attachments) return { error: "attachments 服务未就绪" };
			if (!ref) return { error: `当前会话里缺少附件 ${id} 的完整引用，请重新粘贴该图片` };
			try {
				const stored = await attachments.readImage(ref, exec.signal);
				const bytes = Buffer.from(stored.data);
				const canonicalRef = stored.ref || ref;
				attachmentRefs.set(id, canonicalRef);
				images.push({ id, b64: bytes.toString("base64"), mime: canonicalRef.mediaType || "image/jpeg", digest: sha256(bytes), ref: canonicalRef });
			} catch (error) {
				if (exec.signal.aborted) throw exec.signal.reason || error;
				return { error: `读取附件 ${id} 失败: ${String(error?.message || error).slice(0, 500)}` };
			}
		}
		for (const imagePath of imagePaths) {
			try {
				if (!pathIsAllowed(cfg, imagePath)) return { error: `图片路径超出 allowedImageDirs: ${imagePath}` };
				const bytes = readFileSync(imagePath);
				if (bytes.length > cfg.maxImageBytes) return { error: `图片超过 ${cfg.maxImageBytes} 字节限制` };
				images.push({ id: `path:${resolve(imagePath)}`, b64: bytes.toString("base64"), mime: mimeForPath(imagePath), digest: sha256(bytes) });
			} catch (error) {
				return { error: `读取图片失败: ${String(error?.message || error).slice(0, 500)}` };
			}
		}

		const channel = args.channel || cfg.defaultChannel || "auto";
		const resolvedChannel = channel === "auto"
			? (cfg.geminiApiKey ? "gemini" : cfg.openaiApiKey ? "openai" : "ollama")
			: channel;
		const model = args.model || cfg.defaultModel || VISION_MODEL;
		const key = visionCacheKey({
			attachmentIds: images.map((image) => image.id),
			imageDigests: images.map((image) => image.digest),
			prompt,
			detail,
			mode,
			region,
			model,
			channel: resolvedChannel
		});
		const durable = findVisionRecord(messages, key);
		if (durable) {
			return {
				text: durable.answer,
				attachment_ids: durable.attachmentIds,
				cache_hit: true,
				model: durable.model,
				detail: durable.detail,
				mode: durable.mode,
				channel: durable.channel,
				escalated: Boolean(durable.escalated),
				evidence_json: JSON.stringify(durable.evidence || {})
			};
		}

		const { result, cacheHit } = await cachedVision(key, cfg.cacheMax, async () => {
			let outcome = await runAdaptiveVision(cfg, resolvedChannel, model, detail, mode, prompt, region, images, exec.signal);
			let usedChannel = resolvedChannel;
			if (outcome.error && resolvedChannel !== "gemini" && cfg.geminiApiKey) {
				outcome = await runAdaptiveVision(cfg, "gemini", VISION_MODEL, detail, mode, prompt, region, images, exec.signal);
				usedChannel = "gemini-fallback";
			} else if (outcome.error && resolvedChannel !== "openai" && cfg.openaiApiKey) {
				outcome = await runAdaptiveVision(cfg, "openai", cfg.openaiModel, detail, mode, prompt, region, images, exec.signal);
				usedChannel = "openai-fallback";
			}
			return { ...outcome, channel: usedChannel };
		});
		if (result.error) return { error: result.error };
		const record = makeVisionRecord({
			key,
			attachmentIds: images.map((image) => image.id),
			attachmentRefs: images.map((image) => image.ref).filter(Boolean),
			imageDigests: images.map((image) => image.digest),
			prompt: prompt.slice(0, 12000),
			promptHash: sha256(prompt),
			model: result.model || model,
			detail,
			mode,
			region,
			channel: result.channel,
			escalated: Boolean(result.escalated),
			evidence: result.evidence || { summary: result.text },
			answer: String(result.text || "").slice(0, 20000)
		});
		exec.deferContext(createUserMessage({
			content: [{ type: "text", text: visionRecordText(record) }],
			source: {
				kind: "plugin",
				plugin: "dsh-youreyes",
				form: "notice",
				summary: `视觉证据已记录：${record.attachmentIds.join(", ")}`.slice(0, 120)
			}
		}));
		return {
			text: record.answer,
			attachment_ids: record.attachmentIds,
			cache_hit: cacheHit,
			model: record.model,
			detail: record.detail,
			mode: record.mode,
			channel: record.channel,
			escalated: record.escalated,
			evidence_json: JSON.stringify(record.evidence)
		};
	};

	ctx.tools.register(defineTool({
		name: "vision",
		description: "用视觉模型检查对话图片或本地图片。看到 [图片附件 attachment=...] 时调用；把用户本轮原话完整传入 prompt。单图用 attachment_id，多图用 attachment_ids。mode 可选 glance、ocr、region、compare。channel 可选 openai、gemini、ollama。",
		parameters: {
			attachment_id: { type: "string", description: "单个对话图片附件 id" },
			attachment_ids: { type: "array", items: { type: "string" }, description: "多个对话图片附件 id，顺序会保留" },
			image_path: { type: "string", description: "本地图片文件路径" },
			image_paths: { type: "array", items: { type: "string" }, description: "多个本地图片文件路径" },
			prompt: { type: "string", description: "理解要求；传入用户本轮完整原话" },
			detail: { type: "string", enum: ["auto", "fast", "standard", "deep"], description: "思考档位，默认 auto" },
			mode: { type: "string", enum: ["glance", "ocr", "region", "compare"], description: "任务模式，默认 glance" },
			region: { type: "string", description: "region 模式的区域，例如归一化坐标 0.1,0.2,0.8,0.9，或自然语言区域" },
			channel: { type: "string", enum: ["auto", "openai", "gemini", "ollama"], description: "识图通道，默认 auto" },
			model: { type: "string", description: "识图模型，默认取配置 defaultModel" }
		},
		output: {
			schema: {
				type: "object",
				properties: {
					text: { type: "string", required: true },
					attachment_ids: { type: "array", items: { type: "string" }, required: true },
					cache_hit: { type: "boolean", required: true },
					model: { type: "string", required: true },
					detail: { type: "string", required: true },
					mode: { type: "string", required: true },
					channel: { type: "string", required: true },
					escalated: { type: "boolean", required: true },
					evidence_json: { type: "string", required: true }
				},
				additionalProperties: false
			},
			render(_args: any, value: any) {
				return [{ type: "text", text: String(value.text) }];
			}
		},
		timeoutMs: 260000,
		async execute(args: any, exec: any) {
			const result = await run(args, exec);
			if (result.error) throw new Error(result.error);
			return result;
		}
	}));
	ctx.logger?.info("[dsh-youreyes] vision 工具已注册");
}

function normalizeApiImages(body: any) {
	const source = Array.isArray(body.images) && body.images.length
		? body.images
		: body.image ? [{ image: body.image, mime: body.mime, name: body.name }] : [];
	if (!source.length) throw new Error("缺少 image 或 images");
	if (source.length > 8) throw new Error("一次最多处理 8 张图片");
	let totalBytes = 0;
	return source.map((item: any, index: number) => {
		let base64 = String(item?.image || item?.data || "").trim();
		const dataUrl = base64.match(/^data:([^;,]+);base64,(.*)$/s);
		const mime = String(item?.mime || dataUrl?.[1] || "image/jpeg");
		if (dataUrl) base64 = dataUrl[2];
		if (!base64) throw new Error(`第 ${index + 1} 张图片缺少 base64`);
		const bytes = Buffer.from(base64, "base64");
		if (!bytes.length) throw new Error(`第 ${index + 1} 张图片数据为空`);
		if (bytes.length > 8 * 1024 * 1024) throw new Error(`第 ${index + 1} 张图片超过 8MB`);
		totalBytes += bytes.length;
		if (totalBytes > 32 * 1024 * 1024) throw new Error("图片总大小超过 32MB");
		return {
			id: `api:${sha256(bytes)}`,
			b64: bytes.toString("base64"),
			mime,
			name: String(item?.name || `image-${index + 1}`),
			digest: sha256(bytes),
			bytes: bytes.length
		};
	});
}

/** 只在 DSH compaction 事务后补回被摘要遮蔽的近期视觉记录；普通回溯/替换不会触发。 */
function installCompactionRehydration(ctx: any, cfg: any) {
	const beforeCompaction = new WeakMap();
	ctx.on("session/event", (session: any, event: any) => {
		if (event.type === "compaction/summary") {
			beforeCompaction.set(session, visionRecordsFromMessages(session.deriveMessages()));
			return;
		}
		if (event.type !== "compaction/end") return;
		const before = beforeCompaction.get(session) || [];
		beforeCompaction.delete(session);
		if (event.data?.error || !before.length) return;
		queueMicrotask(async () => {
			try {
				const visibleKeys = new Set(visionRecordsFromMessages(session.deriveMessages()).map((record) => record.key));
				const limit = Math.max(1, Math.floor(Number(cfg.rehydrateMax) || 4));
				const missing = before.filter((record) => !visibleKeys.has(record.key)).slice(-limit);
				if (!missing.length) return;
				for (const record of missing) {
					session.append("user/message", createUserMessage({
						content: [{ type: "text", text: visionRecordText(record) }],
						source: {
							kind: "plugin",
							plugin: "dsh-youreyes",
							form: "notice",
							summary: `视觉证据已从摘要恢复：${(record.attachmentIds || []).join(", ")}`.slice(0, 120)
						}
					}), { surfaceOp: "append" });
				}
				await ctx.get("sessions")?.flush(session);
				ctx.logger?.info(`[dsh-youreyes] compaction 后恢复 ${missing.length} 条视觉记录`);
			} catch (error) {
				ctx.logger?.warn(`[dsh-youreyes] compaction 视觉记录恢复失败: ${String(error?.message || error).slice(0, 300)}`);
			}
		});
	});
}

export function apply(ctx: any, config: any) {
	const cfg = { ...config, ...loadOverrides() };
	installCompactionRehydration(ctx, cfg);

	// vision-toolkit：注册包装适配器（每个上游一个带识图能力的 provider）+ vision 工具
	const upstreams = uniqueStrings(
		Array.isArray(cfg.visionUpstreams) && cfg.visionUpstreams.length
			? cfg.visionUpstreams
			: [cfg.upstreamProvider || "deepseek"]
	);
	for (const upstreamProvider of upstreams) {
		const wrapperName = visionProviderName(upstreamProvider);
		try {
			ctx.llm.registerAdapter([wrapperName], createVisionAdapter(ctx, cfg, wrapperName, upstreamProvider));
			ctx.logger?.info(`[dsh-youreyes] 适配器 ${wrapperName} 已注册（图片→占位文本→${upstreamProvider}）`);
		} catch (e) {
			ctx.logger?.warn(`[dsh-youreyes] 适配器 ${wrapperName} 注册失败: ${e?.message}`);
		}
	}
	try {
		registerVisionTool(ctx, cfg);
	} catch (e) {
		ctx.logger?.warn(`[dsh-youreyes] vision 工具注册失败: ${e?.message}`);
	}

	const webServer = ctx.get("webServer");
	if (!webServer) {
		ctx.logger?.info("[dsh-youreyes] no webServer present — /api/youreyes/vision route skipped");
		return;
	}
	const dispose = webServer.register({
		kind: "exact",
		path: "/api/youreyes/vision",
		handler: async (req: any, res: any) => {
			const controller = new AbortController();
			const abort = () => {
				if (!controller.signal.aborted) controller.abort(new Error("vision client disconnected"));
			};
			const close = () => { if (!res.writableEnded) abort(); };
			req.once("aborted", abort);
			res.once("close", close);
			const send = (code: number, obj: any) => {
				if (res.destroyed || res.writableEnded) return;
				res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
				res.end(JSON.stringify(obj));
			};
			try {
				let raw = "";
				let requestBytes = 0;
				for await (const chunk of req) {
					requestBytes += chunk.length;
					if (requestBytes > 48 * 1024 * 1024) return send(413, { error: "请求体超过 48MB" });
					raw += chunk;
				}
				const body = JSON.parse(raw || "{}");
				const images = normalizeApiImages(body);
				const prompt = String(body.prompt || "请用中文详细描述图片内容。").trim();
				const detail = normalizeDetail(body.detail);
				const mode = normalizeVisionMode(body.mode);
				const region = String(body.region || "").trim();
				if (mode === "compare" && images.length < 2) return send(400, { error: "compare 模式至少需要 2 张图片" });
				if (mode === "region" && !region) return send(400, { error: "region 模式需要 region" });
				const requestedChannel = body.channel || cfg.defaultChannel || "auto";
				const autoChannel = requestedChannel === "auto";
				const channel = autoChannel
					? (cfg.geminiApiKey ? "gemini" : cfg.openaiApiKey ? "openai" : "ollama")
					: requestedChannel;
				const model = body.model || cfg.defaultModel || VISION_MODEL;
				const key = visionCacheKey({
					attachmentIds: images.map((image) => image.id),
					imageDigests: images.map((image) => image.digest),
					prompt,
					detail,
					mode,
					region,
					model,
					channel
				});
				ctx.logger?.info(`[dsh-youreyes] channel=${channel} model=${model} detail=${detail} mode=${mode} images=${images.length} imageBytes=${images.reduce((sum, image) => sum + image.bytes, 0)}`);
				const cached = await cachedVision(key, cfg.cacheMax, async () => {
					let result = await runAdaptiveVision(cfg, channel, model, detail, mode, prompt, region, images, controller.signal);
					let usedChannel = channel;
					if (result.error && autoChannel) {
						if (cfg.geminiApiKey && channel !== "gemini") {
							result = await runAdaptiveVision(cfg, "gemini", VISION_MODEL, detail, mode, prompt, region, images, controller.signal);
							usedChannel = "gemini-fallback";
						} else if (cfg.openaiApiKey && channel !== "openai") {
							result = await runAdaptiveVision(cfg, "openai", cfg.openaiModel, detail, mode, prompt, region, images, controller.signal);
							usedChannel = "openai-fallback";
						}
					}
					return { ...result, channel: usedChannel };
				});
				const result = cached.result;
				if (result.error) return send(502, { error: result.error, channel });
				return send(200, {
					text: result.text,
					channel: result.channel,
					model: result.model,
					detail: result.detail,
					mode: result.mode,
					escalated: result.escalated,
					complexity: result.complexity,
					structured: result.structured,
					truncated_bytes: result.truncatedBytes || 0,
					evidence: result.evidence,
					cache_hit: cached.cacheHit,
					prompt_version: VISION_PROMPT_VERSION
				});
			} catch (e) {
				if (!controller.signal.aborted) send(500, { error: String(e?.message || e).slice(0, 1200) });
			} finally {
				req.removeListener("aborted", abort);
				res.removeListener("close", close);
			}
		}
	});
	ctx.effect(() => dispose, "dsh-youreyes: webServer route");
	ctx.logger?.info("[dsh-youreyes] /api/youreyes/vision route registered");
}

export const __testing = Object.freeze({
	normalizeDetail,
	normalizeVisionMode,
	normalizeVisionResponse,
	buildVisionPrompt,
	visionCacheKey,
	makeVisionRecord,
	visionRecordText,
	isVisionRecordMessage,
	visionRecordsFromMessages,
	findVisionRecord,
	buildVisionManifest,
	flattenMessageContent,
	VisionPromiseCache,
	installCompactionRehydration,
	repairLegacyPlanningStream,
	visionProviderName,
	openaiChat,
	geminiGenerate,
	ollamaChat,
	detectOllama
});
