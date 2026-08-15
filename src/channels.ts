/**
 * dsh-youreyes — general vision channels.
 *
 * v0.1 targets portable, API-key based backends (no Antigravity/IDE dependency):
 *   - openai  : any OpenAI-compatible /chat/completions endpoint (image_url parts)
 *   - gemini  : Google Gemini Developer API (inline_data parts)
 *   - ollama  : local Ollama (auto-detected at http://localhost:11434/v1, keyless)
 *
 * All channels speak one shape: given images [{b64, mime}] + prompt, return text.
 */

export interface VisionImage {
	b64: string;
	mime: string;
}

export interface ChannelCall {
	baseURL: string;
	apiKey: string;
	model: string;
	prompt: string;
	images: VisionImage[];
	maxTokens: number;
	timeoutMs: number;
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
	/** WSL/受限网络环境下：原生 fetch 失败时用 Windows curl.exe 重试（可选，自动探测） */
	winCurl?: string;
}

const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_TIMEOUT = 60_000;

/** 网络类错误（fetch 失败、DNS、连接拒绝）——这些才值得走 curl 重试。 */
function isNetworkError(error: unknown): boolean {
	const message = String(error?.message || error);
	return /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network/i.test(message);
}

function winTempPaths() {
	const name = `dsh-youreyes-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
	return { wsl: `/mnt/c/Temp/${name}`, win: `C:\\Temp\\${name}` };
}

/**
 * 带传输降级的 JSON POST：
 * 1) 原生 fetch（正常网络）
 * 2) 网络类失败时，若配置了 winCurl（Windows curl.exe 路径），写 Windows 可见
 *    临时文件后用 Windows 网络栈重试（WSL + 被墙环境的常见解法）。
 * 返回 { status, body }。
 */
async function postJson(url: string, headers: Record<string, string>, payload: unknown, call: ChannelCall): Promise<{ status: number; body: string }> {
	const doFetch = call.fetchImpl ?? fetch;
	const bodyText = JSON.stringify(payload);
	try {
		const response = await doFetch(url, {
			method: "POST",
			headers,
			body: bodyText,
			signal: call.signal
		});
		return { status: response.status, body: await response.text() };
	} catch (error) {
		if (!isNetworkError(error) || !call.winCurl) throw error;
		// WSL → Windows curl 降级
		const { wsl, win } = winTempPaths();
		const { writeFileSync, unlinkSync } = await import("node:fs");
		writeFileSync(wsl, bodyText);
		try {
			const { execFile } = await import("node:child_process");
			const args = [call.winCurl, "-s", "-S", "--max-time", String(Math.ceil((call.timeoutMs || 60000) / 1000)), "-X", "POST", "--data-binary", `@${win}`];
			for (const [key, value] of Object.entries(headers)) args.push("-H", `${key}: ${value}`);
			args.push(url);
			const stdout = await new Promise<string>((resolve, reject) => {
				execFile(args[0], args.slice(1), { timeout: (call.timeoutMs || 60000) + 10000, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, out) => {
					if (err) reject(err);
					else resolve(String(out));
				});
			});
			return { status: 200, body: stdout };
		} finally {
			try { unlinkSync(wsl); } catch { /* ignore */ }
		}
	}
}

/** Redact the API key from error text before it reaches logs/tools. */
function redact(text: string, apiKey: string): string {
	if (!apiKey) return text;
	return text.split(apiKey).join("***");
}

function redactMessage(error: unknown, apiKey: string): string {
	const message = error instanceof Error ? error.message : String(error);
	return redact(message, apiKey);
}

/** OpenAI-compatible chat completions with image_url content parts. */
export async function openaiChat(request: ChannelCall): Promise<string> {
	const url = `${request.baseURL.replace(/\/+$/, "")}/chat/completions`;
	const payload = {
		model: request.model,
		max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
		messages: [{
			role: "user",
			content: [
				...request.images.map((image) => ({
					type: "image_url",
					image_url: { url: `data:${image.mime || "image/jpeg"};base64,${image.b64}` }
				})),
				{ type: "text", text: request.prompt }
			]
		}]
	};
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (request.apiKey) headers.authorization = `Bearer ${request.apiKey}`;
	let response: { status: number; body: string };
	try {
		response = await postJson(url, headers, payload, request);
	} catch (error) {
		throw new Error(redactMessage(`openai channel: request to ${url} failed: ${redactMessage(error, request.apiKey)}`, request.apiKey));
	}
	if (response.status < 200 || response.status >= 300) {
		throw new Error(redact(`openai channel: ${url} returned ${response.status}: ${response.body.slice(0, 500)}`, request.apiKey));
	}
	let parsed: any;
	try {
		parsed = JSON.parse(response.body);
	} catch {
		throw new Error(redact(`openai channel: ${url} returned non-JSON body: ${response.body.slice(0, 200)}`, request.apiKey));
	}
	const content = parsed?.choices?.[0]?.message?.content;
	let text = "";
	if (typeof content === "string") {
		text = content;
	} else if (Array.isArray(content)) {
		text = content
			.map((part) => typeof part?.text === "string" ? part.text : "")
			.filter(Boolean)
			.join("\n");
	}
	text = stripThink(text.trim());
	if (!text) {
		throw new Error(`openai channel: no assistant text in response: ${response.body.slice(0, 300)}`);
	}
	return text;
}

/** Gemini generateContent with inline_data parts (works with AIza… / AQ. keys). */
export async function geminiGenerate(request: ChannelCall): Promise<string> {
	const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(request.model)}:generateContent`;
	const payload = {
		contents: [{
			parts: [
				...request.images.map((image) => ({
					inline_data: { mime_type: image.mime || "image/jpeg", data: image.b64 }
				})),
				{ text: request.prompt }
			]
		}]
	};
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (request.apiKey) headers["x-goog-api-key"] = request.apiKey;
	let response: { status: number; body: string };
	try {
		response = await postJson(url, headers, payload, request);
	} catch (error) {
		throw new Error(redactMessage(`gemini channel: request failed: ${redactMessage(error, request.apiKey)}`, request.apiKey));
	}
	if (response.status < 200 || response.status >= 300) {
		throw new Error(redact(`gemini channel: ${response.status}: ${response.body.slice(0, 500)}`, request.apiKey));
	}
	let parsed: any;
	try {
		parsed = JSON.parse(response.body);
	} catch {
		throw new Error(redact(`gemini channel: non-JSON response: ${response.body.slice(0, 200)}`, request.apiKey));
	}
	const text = parsed?.candidates?.[0]?.content?.parts
		?.map((part: any) => typeof part?.text === "string" ? part.text : "")
		.filter(Boolean)
		.join("\n")
		?.trim();
	if (!text) {
		const err = parsed?.error;
		throw new Error(`gemini channel: ${err?.code || "?"}: ${err?.message || response.body.slice(0, 300)}`);
	}
	return text;
}

/** Ollama native /api/chat (keyless local). */
export async function ollamaChat(request: ChannelCall): Promise<string> {
	const url = `${request.baseURL.replace(/\/+$/, "")}/api/chat`;
	const payload = {
		model: request.model,
		stream: false,
		messages: [{
			role: "user",
			content: request.prompt,
			images: request.images.map((image) => image.b64)
		}]
	};
	let response: { status: number; body: string };
	try {
		response = await postJson(url, { "content-type": "application/json" }, payload, request);
	} catch (error) {
		throw new Error(`ollama channel: request failed: ${redactMessage(error, request.apiKey)}`);
	}
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`ollama channel: ${response.status}: ${response.body.slice(0, 500)}`);
	}
	let parsed: any;
	try {
		parsed = JSON.parse(response.body);
	} catch {
		throw new Error(`ollama channel: non-JSON response: ${response.body.slice(0, 200)}`);
	}
	const text = String(parsed?.message?.content || "").trim();
	if (!text) throw new Error(`ollama channel: no assistant text: ${response.body.slice(0, 300)}`);
	return text;
}

/** Strip <think>…</think> blocks from thinking-mode VLMs. */
function stripThink(text: string): string {
	const closed = text.replace(/<think>[\s\S]*?<\/think>/g, "");
	if (closed !== text) return closed.trim();
	if (/^\s*<think>/.test(text)) return "";
	return text.trim();
}

/** Detect a running local Ollama (used when autoOllama is enabled). */
export async function detectOllama(fetchImpl?: typeof fetch): Promise<string | null> {
	const doFetch = fetchImpl ?? fetch;
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 2000);
		try {
			const response = await doFetch("http://127.0.0.1:11434/api/tags", { signal: controller.signal });
			if (!response.ok) return null;
			const data: any = await response.json();
			const visionModels = (data?.models || [])
				.map((model: any) => String(model?.name || ""))
				.filter((name: string) => /(vl|vision|llava|minicpm|gemma3)/i.test(name));
			return visionModels.length ? visionModels[0] : null;
		} finally {
			clearTimeout(timer);
		}
	} catch {
		return null;
	}
}
