/**
 * dsh-youreyes — vision channels.
 *
 *   - openai      : any OpenAI-compatible /chat/completions endpoint (image_url parts)
 *   - gemini      : Google Gemini Developer API (inline_data parts)
 *   - ollama      : local Ollama (auto-detected at http://localhost:11434/v1, keyless)
 *   - antigravity : Antigravity IDE agentapi (默认通道；flash/pro 双档，走 IDE 订阅额度)
 *
 * All channels speak one shape: given images [{b64, mime}] + prompt, return text.
 */

import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync, unlinkSync, existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join, dirname } from "node:path";

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

// ──────────────────────────────────────────────────────────────────────────
// Antigravity IDE agentapi channel (反重力额度，flash/pro 双档)
// 通过本机 Antigravity 语言服务器 agentapi 调用 Gemini，走 IDE 订阅额度。
// 端口/CSRF 每次 IDE 重启都会变 → 动态发现；WSL 调 Windows exe → WSLENV 合并。
// ──────────────────────────────────────────────────────────────────────────

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

function imageExtension(mime: string) {
	if (mime === "image/png") return ".png";
	if (mime === "image/webp") return ".webp";
	if (mime === "image/gif") return ".gif";
	return ".jpg";
}

/** WSL 路径 → Windows file:// URI（agent 用 view_file 看图需要）。 */
function windowsFileUri(wslPath: string) {
	const match = String(wslPath).match(/^\/mnt\/([a-z])\/(.*)$/i);
	if (!match) return `file://${encodeURI(wslPath)}`;
	return `file:///${encodeURI(`${match[1].toUpperCase()}:/${match[2]}`).replace(":", "%3A")}`;
}

/** 从运行中的 LS 进程提取 gRPC 端口与 CSRF token（每次 IDE 重启都会变）。 */
export async function findLs(signal?: AbortSignal) {
	signal?.throwIfAborted();
	const run = (cmd: string, args: string[], timeout = 15000) => new Promise<string>((resolveRun, reject) => {
		execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true, signal },
			(error, stdout) => {
				if (signal?.aborted) return reject(signal.reason || error);
				resolveRun(String(stdout || ""));
			});
	});
	// 1. 找 language_server.exe PID
	const tl = await run("/mnt/c/Windows/System32/tasklist.exe", ["/FI", "IMAGENAME eq language_server.exe"]);
	let pid: string | null = null;
	for (const line of tl.split("\n")) {
		if (line.includes("language_server.exe")) {
			const parts = line.trim().split(/\s+/);
			pid = parts[1] || null;
			break;
		}
	}
	if (!pid) return { port: null, csrf: null, error: "找不到 language_server.exe 进程。请先启动并登录 Antigravity IDE。" };
	// 2. 该 PID 的 127.0.0.1 LISTENING 端口
	const ns = await run("/mnt/c/Windows/System32/netstat.exe", ["-ano", "-p", "tcp"]);
	const ports: string[] = [];
	for (const line of ns.split("\n")) {
		const parts = line.trim().split(/\s+/);
		if (parts.length >= 5 && parts[0] === "TCP" && parts[3] === "LISTENING" && parts[4] === pid) {
			const m = parts[1].match(/^127\.0\.0\.1:(\d+)$/);
			if (m) ports.push(m[1]);
		}
	}
	if (!ports.length) return { port: null, csrf: null, error: `language_server.exe PID ${pid} 没有监听 127.0.0.1 端口。` };
	// 3. CSRF（进程命令行）
	const csrfOut = await run("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
		["-NoProfile", "-Command",
			`Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object -ExpandProperty CommandLine`], 30000);
	const m = csrfOut.match(/--csrf_token\s+([a-f0-9-]{20,})/);
	const csrf = m ? m[1] : null;
	// 4. Windows 侧 socket 探测 h2c gRPC 端口（回 SETTINGS 帧 type=0x04 的是 gRPC）
	const probe = (
		"$ports=@(" + ports.join(",") + ");" +
		"foreach($p in $ports){" +
		"  try{" +
		"    $c=New-Object System.Net.Sockets.TcpClient;" +
		"    $c.ReceiveTimeout=1500; $c.SendTimeout=1500;" +
		"    $c.Connect('127.0.0.1',$p);" +
		"    $s=$c.GetStream();" +
		"    $pre=[byte[]](0x50,0x52,0x49,0x20,0x2a,0x20,0x48,0x54,0x54,0x50,0x2f,0x32,0x2e,0x30,0x0d,0x0a,0x0d,0x0a,0x53,0x4d,0x0d,0x0a,0x0d,0x0a);" +
		"    $s.Write($pre,0,$pre.Length);" +
		"    $buf=New-Object byte[] 9;" +
		"    $n=$s.Read($buf,0,9);" +
		"    if($n -ge 4 -and $buf[3] -eq 4){ Write-Output $p; $s.Close(); $c.Close(); break }" +
		"    $s.Close(); $c.Close()" +
		"  }catch{}" +
		"}"
	);
	const probeOut = await run("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
		["-NoProfile", "-Command", probe], 30000);
	for (const line of probeOut.split("\n")) {
		const t = line.trim();
		if (/^\d+$/.test(t)) return { port: Number(t), csrf, error: null };
	}
	return {
		port: null,
		csrf,
		error: `已找到 language_server.exe PID ${pid} 和端口 ${ports.join(", ")}，但 h2c gRPC SETTINGS 探测全部失败。`
	};
}

/** 确保本地项目文件存在（agentapi StartCascade 需要）。 */
export async function ensureProjectFile(cfg: any) {
	const home = cfg.antigravityWindowsHome;
	if (!home || !cfg.antigravityProjectId) return { error: "未配置 antigravityWindowsHome / antigravityProjectId" };
	const projPath = join(home, ".gemini", "config", "projects", `${cfg.antigravityProjectId}.json`);
	if (existsSync(projPath)) return null;
	try {
		mkdirSync(dirname(projPath), { recursive: true });
		const winDir = cfg.antigravityWorkspace.replace(/^\/mnt\/([a-z])/, (_: string, d: string) => `${d.toUpperCase()}:`).replace(/\//g, "\\");
		const folderUri = "file:///" + winDir.replace(/\\/g, "/").replace(":", "%3A");
		writeFileSync(projPath, JSON.stringify({
			id: cfg.antigravityProjectId,
			name: "dsh-youreyes",
			projectResources: { resources: [{ gitFolder: { folderUri, allowWrite: true } }] }
		}));
	} catch (e: any) {
		return { error: `创建项目文件失败: ${e.message}` };
	}
	return null;
}

/**
 * 通道 antigravity: 官方 agentapi（反重力订阅额度）。
 * 图片写入工作区 → file:// 引用 → agent 用 view_file 看图 → transcript 轮询回复。
 * model 含 "pro" 用 pro 档，否则 flash 档。
 */
export async function runAntigravity(cfg: any, model: string, prompt: string, images: VisionImage[], signal?: AbortSignal) {
	const imagePaths: string[] = [];
	try {
		signal?.throwIfAborted();
		const wslDir = cfg.antigravityWorkspace;
		if (!wslDir) return { error: "未配置 antigravityWorkspace（反重力工作区路径）" };
		mkdirSync(wslDir, { recursive: true });
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const links = images.map((image, index) => {
			const imageName = `dsh-youreyes-${stamp}-${index + 1}${imageExtension(image.mime)}`;
			const imagePath = join(wslDir, imageName);
			writeFileSync(imagePath, Buffer.from(image.b64, "base64"));
			imagePaths.push(imagePath);
			return `图片 ${index + 1}${(image as any).id ? `（attachment=${(image as any).id}）` : ""}: ![img${index + 1}](${windowsFileUri(imagePath)})`;
		});

		const { port, csrf, error: discoveryError } = await findLs(signal);
		if (!port || !csrf) {
			return { error: discoveryError || "找不到运行中的 Antigravity 语言服务器。请先启动并登录 Antigravity IDE。" };
		}
		const fullPrompt = `${prompt}\n\n${links.join("\n")}`;
		const tier = model.includes("pro") ? "pro" : "flash";
		const existingWslEnv = process.env.WSLENV || "";
		const env = {
			WSLENV: ["ANTIGRAVITY_LS_ADDRESS", "ANTIGRAVITY_CSRF_TOKEN", "ANTIGRAVITY_PROJECT_ID", existingWslEnv]
				.filter(Boolean).join(":"),
			ANTIGRAVITY_LS_ADDRESS: `http://127.0.0.1:${port}`,
			ANTIGRAVITY_CSRF_TOKEN: csrf,
			ANTIGRAVITY_PROJECT_ID: cfg.antigravityProjectId
		};
		const ensureProject = await ensureProjectFile(cfg);
		if (ensureProject) return ensureProject;
		const started = await new Promise<{ error?: string; stdout?: string }>((resolveStarted, reject) => {
			execFile(cfg.antigravityLsExe, ["agentapi", "new-conversation", `--model=${tier}`, fullPrompt],
				{ cwd: wslDir, env: { ...process.env, ...env }, timeout: 120000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, signal },
				(error, stdout, stderr) => {
					if (signal?.aborted) return reject(signal.reason || error);
					if (error) resolveStarted({ error: String(stderr || error.message).slice(0, 1200) });
					else resolveStarted({ stdout: String(stdout) });
				});
		});
		if (started.error) return { error: `agentapi new-conversation 失败: ${started.error}` };
		let conversation: any;
		try {
			conversation = JSON.parse(started.stdout || "");
		} catch {
			return { error: `agentapi 输出异常: ${(started.stdout || "").slice(0, 500)}` };
		}
		if (conversation.error) return { error: `agentapi 错误: ${conversation.error}` };
		const conversationId = conversation.response?.newConversation?.conversationId;
		if (!conversationId) return { error: `未拿到 conversationId: ${JSON.stringify(conversation).slice(0, 500)}` };

		const logDir = join(cfg.antigravityBrainDir, conversationId, ".system_generated", "logs");
		const fullTranscript = join(logDir, "transcript_full.jsonl");
		const compactTranscript = join(logDir, "transcript.jsonl");
		const startedAt = Date.now();
		let transcript = "";
		let offset = 0;
		let remainder = "";
		while (Date.now() - startedAt < 240000) {
			signal?.throwIfAborted();
			try {
				const nextTranscript = existsSync(fullTranscript)
					? fullTranscript
					: Date.now() - startedAt >= 8000 && existsSync(compactTranscript) ? compactTranscript : "";
				if (!nextTranscript) throw new Error("transcript pending");
				if (transcript !== nextTranscript) {
					transcript = nextTranscript;
					offset = 0;
					remainder = "";
				}
				const size = statSync(transcript).size;
				if (size < offset) { offset = 0; remainder = ""; }
				if (size > offset) {
					const length = size - offset;
					const buffer = Buffer.alloc(length);
					const fd = openSync(transcript, "r");
					try { readSync(fd, buffer, 0, length, offset); } finally { closeSync(fd); }
					offset = size;
					const lines = (remainder + buffer.toString("utf8")).split("\n");
					remainder = lines.pop() || "";
					for (const line of lines) {
						try {
							const entry = JSON.parse(line);
							if (entry.source === "MODEL" && entry.type === "PLANNER_RESPONSE" && entry.content?.trim()) {
								return { text: entry.content.trim() };
							}
						} catch { /* 等待完整行 */ }
					}
				}
			} catch { /* transcript 尚未出现 */ }
			await abortableDelay(2000, signal);
		}
		return { error: "等待反重力回复超时" };
	} catch (error) {
		if (signal?.aborted) throw signal.reason || error;
		return { error: String((error as any)?.message || error).slice(0, 1200) };
	} finally {
		for (const imagePath of imagePaths) {
			try { unlinkSync(imagePath); } catch { /* ignore cleanup errors */ }
		}
	}
}
