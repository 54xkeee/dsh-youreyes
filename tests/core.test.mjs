// dsh-youreyes core tests: channels, vision-core, cache, prompt building.
// Run: npm test  (node --test tests/*.test.mjs)

import { test } from "node:test";
import assert from "node:assert/strict";
import { __testing } from "../lib/index.js";

const {
	openaiChat,
	geminiGenerate,
	ollamaChat,
	detectOllama,
	normalizeDetail,
	normalizeVisionMode,
	normalizeVisionResponse,
	buildVisionPrompt,
	visionCacheKey,
	VisionPromiseCache,
	makeVisionRecord,
	visionRecordText,
	isVisionRecordMessage,
	visionRecordsFromMessages,
	findVisionRecord,
	buildVisionManifest,
	flattenMessageContent,
	repairLegacyPlanningStream,
	visionProviderName
} = __testing;

// ---------- vision-core ----------

test("normalizeDetail / normalizeVisionMode clamp bad values", () => {
	assert.equal(normalizeDetail("deep"), "deep");
	assert.equal(normalizeDetail("bogus"), "auto");
	assert.equal(normalizeVisionMode("ocr"), "ocr");
	assert.equal(normalizeVisionMode("nope"), "glance");
});

test("buildVisionPrompt includes mode/detail instructions", () => {
	const p = buildVisionPrompt({ detail: "deep", mode: "ocr", userPrompt: "读文字", region: "", imageCount: 1, triage: false });
	assert.ok(p.includes("OCR"));
	assert.ok(p.includes("base_evidence"));
	assert.ok(p.includes("读文字"));
});

test("normalizeVisionResponse: raw text → simple answer", () => {
	const r = normalizeVisionResponse("一只橘猫在睡觉");
	assert.equal(r.answer, "一只橘猫在睡觉");
	assert.equal(r.complexity, "simple");
	assert.equal(r.structured, false);
});

test("normalizeVisionResponse: JSON payload → structured", () => {
	const raw = JSON.stringify({
		complexity: "complex",
		base_evidence: { summary: "一只猫", ocr: "", layout: ["床"], entities: ["猫"], relations: [], uncertainty: [] },
		query_answer: "猫在睡觉"
	});
	const r = normalizeVisionResponse(raw);
	assert.equal(r.answer, "猫在睡觉");
	assert.equal(r.complexity, "complex");
	assert.equal(r.structured, true);
	assert.equal(r.evidence.summary, "一只猫");
});

test("visionCacheKey differs by content and is stable", () => {
	const a = visionCacheKey({ attachmentIds: ["x"], imageDigests: ["d1"], prompt: "p", detail: "auto", mode: "glance", region: "", model: "m", channel: "auto" });
	const b = visionCacheKey({ attachmentIds: ["x"], imageDigests: ["d1"], prompt: "p", detail: "auto", mode: "glance", region: "", model: "m", channel: "auto" });
	const c = visionCacheKey({ attachmentIds: ["x"], imageDigests: ["d2"], prompt: "p", detail: "auto", mode: "glance", region: "", model: "m", channel: "auto" });
	assert.equal(a, b);
	assert.notEqual(a, c);
});

test("VisionPromiseCache LRU evicts oldest", async () => {
	const cache = new VisionPromiseCache();
	for (let i = 0; i < 5; i++) cache.set(`k${i}`, Promise.resolve(i), 3);
	assert.equal(cache.get("k0"), undefined); // evicted
	assert.ok(cache.get("k4"));
});

test("vision record roundtrip: make → text → parse → find", () => {
	const record = makeVisionRecord({
		key: "abc",
		attachmentIds: ["att-1"],
		imageDigests: ["d"],
		prompt: "p",
		promptHash: "h",
		model: "m",
		detail: "standard",
		mode: "glance",
		region: "",
		channel: "gemini",
		escalated: false,
		evidence: { summary: "一只猫" },
		answer: "猫在睡觉"
	});
	const text = visionRecordText(record);
	const message = { source: { kind: "plugin", plugin: "dsh-youreyes", form: "notice" }, content: [{ type: "text", text }] };
	assert.ok(isVisionRecordMessage(message));
	const records = visionRecordsFromMessages([message]);
	assert.equal(records.length, 1);
	assert.equal(records[0].key, "abc");
	assert.equal(findVisionRecord([message], "abc").answer, "猫在睡觉");
});

test("flattenMessageContent turns image blocks into placeholders", () => {
	const target = new Map();
	const out = flattenMessageContent([
		{ type: "text", text: "看图" },
		{ type: "image", attachment: { attachmentId: "att-9", mediaType: "image/png", width: 100, height: 50 } }
	], target);
	assert.ok(out.some((b) => b.type === "text" && b.text.includes("[图片附件 attachment=att-9")));
	assert.ok(out.some((b) => b.type === "text" && b.text.includes("调用 vision")));
	assert.equal(target.get("att-9").mediaType, "image/png");
});

test("buildVisionManifest renders recent records", () => {
	const records = [makeVisionRecord({ key: "k", attachmentIds: ["a1"], evidence: { summary: "一只猫" }, mode: "glance", detail: "auto", answer: "x" })];
	const manifest = buildVisionManifest(records);
	assert.ok(manifest.includes("a1"));
	assert.ok(manifest.includes("视觉记忆"));
});

test("visionProviderName maps upstreams", () => {
	assert.equal(visionProviderName("deepseek"), "deepseek-vision");
	assert.equal(visionProviderName("deepseek-official"), "deepseek-vision-deepseek-official");
	assert.equal(visionProviderName("openrouter"), "deepseek-vision-openrouter");
});

// ---------- channels (mock fetch) ----------

function mockFetch(handler) {
	const calls = [];
	globalThis.fetch = async (url, opts) => {
		calls.push({ url, opts });
		return handler(url, opts, calls.length);
	};
	return calls;
}

const res = (status, body) => new Response(body, { status, headers: { "content-type": "application/json" } });
const img = [{ b64: "aGVsbG8=", mime: "image/jpeg" }];

test("openaiChat: builds correct request, strips <think>", async () => {
	const calls = mockFetch(async (url, opts) => {
		assert.equal(url, "https://x.example/v1/chat/completions");
		assert.equal(opts.headers.authorization, "Bearer sk-test");
		const payload = JSON.parse(opts.body);
		assert.equal(payload.messages[0].content[0].type, "image_url");
		assert.ok(payload.messages[0].content[0].image_url.url.startsWith("data:image/jpeg;base64,"));
		return res(200, JSON.stringify({ choices: [{ message: { content: "看到一只猫 <think>内部</think> 在睡觉" } }] }));
	});
	const text = await openaiChat({ baseURL: "https://x.example/v1", apiKey: "sk-test", model: "glm-4v", prompt: "描述", images: img, maxTokens: 100, timeoutMs: 5000, fetchImpl: fetch });
	assert.equal(text, "看到一只猫  在睡觉");
	assert.equal(calls.length, 1);
});

test("openaiChat: parts content joins text", async () => {
	mockFetch(async () => res(200, JSON.stringify({ choices: [{ message: { content: [{ type: "text", text: "A" }, { type: "text", text: "B" }] } }] })));
	const text = await openaiChat({ baseURL: "https://x.example/v1", apiKey: "", model: "m", prompt: "p", images: img, maxTokens: 100, timeoutMs: 5000, fetchImpl: fetch });
	assert.equal(text, "A\nB");
});

test("openaiChat: redacts api key in errors", async () => {
	mockFetch(async () => res(401, JSON.stringify({ error: "bad key sk-super-secret" })));
	await assert.rejects(
		openaiChat({ baseURL: "https://x.example/v1", apiKey: "sk-super-secret", model: "m", prompt: "p", images: img, maxTokens: 100, timeoutMs: 5000, fetchImpl: fetch }),
		(error) => {
			const message = String(error.message);
			return !message.includes("sk-super-secret") && message.includes("***");
		}
	);
});

test("geminiGenerate: builds inline_data request", async () => {
	const calls = mockFetch(async (url, opts) => {
		assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent");
		assert.equal(opts.headers["x-goog-api-key"], "AIza-test");
		const payload = JSON.parse(opts.body);
		assert.equal(payload.contents[0].parts[0].inline_data.mime_type, "image/jpeg");
		return res(200, JSON.stringify({ candidates: [{ content: { parts: [{ text: "一只猫" }] } }] }));
	});
	const text = await geminiGenerate({ baseURL: "", apiKey: "AIza-test", model: "gemini-3.7-flash", prompt: "描述", images: img, maxTokens: 100, timeoutMs: 5000, fetchImpl: fetch });
	assert.equal(text, "一只猫");
	assert.equal(calls.length, 1);
});

test("ollamaChat: sends base64 images", async () => {
	const calls = mockFetch(async (url, opts) => {
		assert.equal(url, "http://127.0.0.1:11434/api/chat");
		const payload = JSON.parse(opts.body);
		assert.deepEqual(payload.messages[0].images, ["aGVsbG8="]);
		return res(200, JSON.stringify({ message: { content: "本地模型说：一只猫" } }));
	});
	const text = await ollamaChat({ baseURL: "http://127.0.0.1:11434", apiKey: "", model: "llava", prompt: "描述", images: img, maxTokens: 100, timeoutMs: 5000, fetchImpl: fetch });
	assert.equal(text, "本地模型说：一只猫");
	assert.equal(calls.length, 1);
});

test("detectOllama: finds vision models", async () => {
	mockFetch(async () => res(200, JSON.stringify({ models: [{ name: "llava:latest" }, { name: "qwen3:8b" }] })));
	const model = await detectOllama(fetch);
	assert.equal(model, "llava:latest");
});

test("detectOllama: returns null when unavailable", async () => {
	mockFetch(async () => { throw new Error("fetch failed"); });
	const model = await detectOllama(fetch);
	assert.equal(model, null);
});

// ---------- stream repair ----------

async function collect(gen) {
	const out = [];
	for await (const chunk of gen) out.push(chunk);
	return out;
}

test("repairLegacyPlanningStream: plain text passes through", async () => {
	const input = [
		{ type: "block-start", blockType: "text", index: 0 },
		{ type: "text-delta", index: 0, text: "你好" },
		{ type: "block-end", block: { type: "text", text: "你好" }, index: 0 },
		{ type: "finish", index: 0 }
	];
	const out = await collect(repairLegacyPlanningStream(input));
	assert.equal(out[0].blockType, "text");
	assert.equal(out[1].type, "text-delta");
});

test("repairLegacyPlanningStream: text before tool-call becomes reasoning", async () => {
	const input = [
		{ type: "block-start", blockType: "text", index: 0 },
		{ type: "text-delta", index: 0, text: "我要识图" },
		{ type: "block-end", block: { type: "text", text: "我要识图" }, index: 0 },
		{ type: "block-start", blockType: "tool-call", index: 1 }
	];
	const out = await collect(repairLegacyPlanningStream(input));
	assert.equal(out[0].blockType, "reasoning");
	assert.equal(out[1].type, "reasoning-delta");
	assert.equal(out[2].block.type, "reasoning");
	assert.equal(out[3].blockType, "tool-call");
});
