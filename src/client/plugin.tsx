import { useRef, useState } from "react";

/** dsh-youreyes 识图面板：选图/粘贴 → prompt → 模式/档位/通道 → 识别结果。 */

const MAX_IMAGE = 8 * 1024 * 1024;
const MAX_IMAGES = 8;

const btnStyle: React.CSSProperties = {
	position: "relative",
	display: "inline-flex",
	alignItems: "center",
	gap: 6,
	minHeight: 28,
	padding: "3px 10px",
	border: "0",
	borderRadius: 6,
	background: "var(--dsw-alias-bg-base)",
	color: "var(--dsw-alias-label-tertiary)",
	fontSize: 12,
	lineHeight: "18px",
	cursor: "pointer",
	fontFamily: "var(--dsw-font-mono)"
};
const panelStyle: React.CSSProperties = {
	position: "fixed",
	top: 52,
	right: 16,
	zIndex: 1000,
	width: 430,
	maxWidth: "calc(100vw - 32px)",
	maxHeight: "calc(100vh - 68px)",
	overflowY: "auto",
	boxSizing: "border-box",
	padding: "14px",
	border: "1px solid var(--dsw-alias-border-l2)",
	borderRadius: 12,
	background: "var(--dsw-specific-menu)",
	boxShadow: "var(--dsw-shadow-lv3)",
	fontSize: 13,
	lineHeight: "20px",
	color: "var(--dsw-alias-label-primary)",
	textAlign: "left"
};
const inputStyle: React.CSSProperties = {
	width: "100%",
	boxSizing: "border-box",
	padding: "6px 8px",
	border: "1px solid var(--dsw-alias-border-l2)",
	borderRadius: 8,
	background: "var(--dsw-alias-bg-base)",
	color: "var(--dsw-alias-label-primary)",
	fontSize: 12,
	lineHeight: "18px",
	fontFamily: "var(--dsw-font-sans)"
};
const rowStyle: React.CSSProperties = { display: "flex", gap: 8, alignItems: "center", marginTop: 8 };
const labelStyle: React.CSSProperties = { color: "var(--dsw-alias-label-tertiary)", fontSize: 12, flex: "none" };
const resultStyle: React.CSSProperties = {
	marginTop: 8,
	padding: "8px 10px",
	borderRadius: 8,
	background: "var(--dsw-alias-bg-base)",
	border: "1px solid var(--dsw-alias-border-l2)",
	whiteSpace: "pre-wrap",
	wordBreak: "break-word",
	maxHeight: 260,
	overflowY: "auto",
	fontSize: 12,
	lineHeight: "18px"
};
const errStyle: React.CSSProperties = { ...resultStyle, color: "var(--dsw-alias-state-danger)" };

function readImage(file: File) {
	return new Promise<{ dataUrl: string; b64: string; mime: string; name: string }>((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(reader.error || new Error("read error"));
		reader.onload = () => {
			const dataUrl = String(reader.result);
			resolve({
				dataUrl,
				b64: dataUrl.split(",")[1],
				mime: file.type || "image/jpeg",
				name: file.name || "paste"
			});
		};
		reader.readAsDataURL(file);
	});
}

/** 通道预置：自动 / OpenAI 兼容 / Gemini / 本地 Ollama */
const CHANNELS = [
	{ value: "auto", labelKey: "chAuto", modelKey: "modelAuto" },
	{ value: "openai", labelKey: "chOpenai", modelKey: "modelOpenai" },
	{ value: "gemini", labelKey: "chGemini", modelKey: "modelGemini" },
	{ value: "ollama", labelKey: "chOllama", modelKey: "modelOllama" }
];

function VisionPanel({ t }: any) {
	const rootRef = useRef<HTMLDivElement>(null);
	const fileRef = useRef<HTMLInputElement>(null);
	const [images, setImages] = useState<any[]>([]);
	const [prompt, setPrompt] = useState(t("defaultPrompt"));
	const [channel, setChannel] = useState("auto");
	const [model, setModel] = useState("");
	const [detail, setDetail] = useState("auto");
	const [mode, setMode] = useState("glance");
	const [region, setRegion] = useState("");
	const [busy, setBusy] = useState(false);
	const [text, setText] = useState("");
	const [meta, setMeta] = useState("");
	const [error, setError] = useState("");

	const onFiles = async (files: FileList | File[] | null) => {
		const selected = Array.from(files || []).filter(Boolean);
		if (!selected.length) return;
		if (images.length + selected.length > MAX_IMAGES) { setError(t("tooMany")); return; }
		if (selected.some((file) => file.size > MAX_IMAGE)) { setError(t("tooLarge")); return; }
		try {
			const added = await Promise.all(selected.map(readImage));
			setImages((current) => [...current, ...added].slice(0, MAX_IMAGES));
			setError("");
			setText("");
			setMeta("");
		} catch (cause) {
			setError(String((cause as any)?.message || cause));
		}
	};

	const run = async () => {
		if (!images.length) { setError(t("noImage")); return; }
		if (mode === "compare" && images.length < 2) { setError(t("compareNeedsTwo")); return; }
		if (mode === "region" && !region.trim()) { setError(t("regionNeeded")); return; }
		setBusy(true);
		setError("");
		setText("");
		setMeta("");
		try {
			const res = await fetch("/api/youreyes/vision", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					images: images.map(({ b64, mime, name }) => ({ image: b64, mime, name })),
					prompt,
					channel,
					...(model.trim() ? { model: model.trim() } : {}),
					detail,
					mode,
					region
				})
			});
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
			setText(body.text);
			const parts = [body.channel, body.model].filter(Boolean);
			if (body.cache_hit) parts.push("cache");
			if (body.escalated) parts.push("escalated");
			setMeta(parts.join(" · "));
		} catch (cause) {
			setError(String((cause as any)?.message || cause));
		} finally {
			setBusy(false);
		}
	};

	const currentChannel = CHANNELS.find((c) => c.value === channel) || CHANNELS[0];

	return (
		<div style={panelStyle} ref={rootRef} onPaste={(event) => {
			const files = Array.from(event.clipboardData?.items || [])
				.filter((item) => item.type.startsWith("image/"))
				.map((item) => item.getAsFile())
				.filter(Boolean) as File[];
			if (files.length) { event.preventDefault(); onFiles(files); }
		}}>
			<input ref={fileRef} type="file" accept="image/*" multiple style={{ display: "none" }}
				onChange={(event) => { onFiles(event.target.files); event.target.value = ""; }} />
			<div style={{ display: "flex", gap: 8, alignItems: "center" }}>
				<button type="button" style={{ ...btnStyle, minHeight: 30 }} onClick={() => fileRef.current?.click()}>
					{t("pickImage")}
				</button>
				<span style={labelStyle}>{t("imageCount").replace("{count}", String(images.length))}</span>
				{images.length ? <button type="button" style={{ ...btnStyle, marginLeft: "auto" }} onClick={() => { setImages([]); setMeta(""); }}>{t("clearImages")}</button> : null}
			</div>
			{images.length ? (
				<div style={{ display: "flex", gap: 6, marginTop: 8, overflowX: "auto", paddingBottom: 2 }}>
					{images.map((image, index) => (
						<div key={`${image.name}-${index}`} style={{ position: "relative", flex: "none" }}>
							<img src={image.dataUrl} alt={image.name} title={image.name} style={{ height: 56, width: 72, borderRadius: 6, border: "1px solid var(--dsw-alias-border-l2)", objectFit: "cover" }} />
							<button type="button" aria-label={t("removeImage")} onClick={() => setImages((current) => current.filter((_, itemIndex) => itemIndex !== index))}
								style={{ position: "absolute", top: -4, right: -4, width: 18, height: 18, padding: 0, border: 0, borderRadius: 9, background: "var(--dsw-alias-bg-base)", color: "var(--dsw-alias-label-primary)", cursor: "pointer" }}>×</button>
						</div>
					))}
				</div>
			) : <div style={{ ...rowStyle, marginTop: 6 }}><span style={labelStyle}>{t("hintPaste")}</span></div>}
			<textarea rows={2} style={{ ...inputStyle, marginTop: 8 }} value={prompt} onChange={(event) => setPrompt(event.target.value)} />
			<div style={rowStyle}>
				<span style={labelStyle}>{t("channel")}</span>
				<select style={{ ...inputStyle, width: 160 }} value={channel} onChange={(event) => { setChannel(event.target.value); setMeta(""); }}>
					{CHANNELS.map((c) => <option key={c.value} value={c.value}>{t(c.labelKey)}</option>)}
				</select>
				<span style={{ ...labelStyle, marginLeft: 4 }}>{t("modelHint")}</span>
				<input style={{ ...inputStyle, width: 110 }} value={model} placeholder={t(currentChannel.modelKey)} onChange={(event) => setModel(event.target.value)} />
			</div>
			<div style={rowStyle}>
				<span style={labelStyle}>{t("mode")}</span>
				<select style={{ ...inputStyle, width: 160 }} value={mode} onChange={(event) => setMode(event.target.value)}>
					<option value="glance">{t("modeGlance")}</option>
					<option value="ocr">{t("modeOcr")}</option>
					<option value="region">{t("modeRegion")}</option>
					<option value="compare">{t("modeCompare")}</option>
				</select>
				<span style={labelStyle}>{t("detail")}</span>
				<select style={{ ...inputStyle, width: 130 }} value={detail} onChange={(event) => setDetail(event.target.value)}>
					<option value="auto">{t("detailAuto")}</option>
					<option value="fast">{t("detailFast")}</option>
					<option value="standard">{t("detailStandard")}</option>
					<option value="deep">{t("detailDeep")}</option>
				</select>
			</div>
			{mode === "region" ? <input style={{ ...inputStyle, marginTop: 8 }} value={region} placeholder={t("regionPlaceholder")} onChange={(event) => setRegion(event.target.value)} /> : null}
			<div style={rowStyle}>
				<button type="button" disabled={busy || !images.length} style={{ ...btnStyle, minHeight: 30, marginLeft: "auto", background: "var(--dsw-alias-state-primary)", color: "#fff" }} onClick={run}>
					{busy ? t("running") : t("run")}
				</button>
			</div>
			{error ? <div style={errStyle}>{error}</div> : null}
			{text ? (
				<div>
					{meta ? <div style={{ ...labelStyle, marginTop: 6 }}>{meta}</div> : null}
					<div style={resultStyle}>{text}</div>
					<button type="button" style={{ ...btnStyle, marginTop: 6 }} onClick={() => navigator.clipboard?.writeText(text)}>{t("copy")}</button>
				</div>
			) : null}
		</div>
	);
}

const zh = {
	"button": "识图",
	"buttonAria": "dsh-youreyes 识图",
	"pickImage": "添加图片",
	"clearImages": "清空",
	"removeImage": "移除图片",
	"imageCount": "已选 {count}/8",
	"hintPaste": "选择图片，或直接 Ctrl+V 粘贴截图",
	"defaultPrompt": "请用中文详细描述图片内容。",
	"channel": "通道",
	"chAuto": "自动",
	"chOpenai": "OpenAI 兼容",
	"chGemini": "Gemini API",
	"chOllama": "本地 Ollama",
	"modelHint": "模型",
	"modelAuto": "自动",
	"modelOpenai": "glm-4.6v-flash",
	"modelGemini": "gemini-3.7-flash",
	"modelOllama": "llava",
	"mode": "任务",
	"modeGlance": "通用识图",
	"modeOcr": "OCR 文字",
	"modeRegion": "区域细查",
	"modeCompare": "多图对比",
	"regionPlaceholder": "区域：如 0.1,0.2,0.8,0.9 或‘右上角’",
	"detail": "档位",
	"detailAuto": "自动",
	"detailFast": "快速",
	"detailStandard": "标准",
	"detailDeep": "深度",
	"run": "识别",
	"running": "识别中…",
	"copy": "复制结果",
	"noImage": "请先添加或粘贴图片",
	"tooLarge": "单张图片超过 8MB，请压缩后再试",
	"tooMany": "一次最多选择 8 张图片",
	"compareNeedsTwo": "多图对比至少选择 2 张图片",
	"regionNeeded": "区域细查需要填写区域",
	"error": "识别失败"
};

const en = {
	"button": "Vision",
	"buttonAria": "dsh-youreyes vision",
	"pickImage": "Add images",
	"clearImages": "Clear",
	"removeImage": "Remove image",
	"imageCount": "Selected {count}/8",
	"hintPaste": "Pick images or press Ctrl+V to paste screenshots",
	"defaultPrompt": "Describe the image content in detail.",
	"channel": "Channel",
	"chAuto": "Auto",
	"chOpenai": "OpenAI-compatible",
	"chGemini": "Gemini API",
	"chOllama": "Local Ollama",
	"modelHint": "Model",
	"modelAuto": "auto",
	"modelOpenai": "glm-4.6v-flash",
	"modelGemini": "gemini-3.7-flash",
	"modelOllama": "llava",
	"mode": "Task",
	"modeGlance": "General vision",
	"modeOcr": "OCR text",
	"modeRegion": "Inspect region",
	"modeCompare": "Compare images",
	"regionPlaceholder": "Region: 0.1,0.2,0.8,0.9 or 'top right'",
	"detail": "Detail",
	"detailAuto": "Auto",
	"detailFast": "Fast",
	"detailStandard": "Standard",
	"detailDeep": "Deep",
	"run": "Run",
	"running": "Running…",
	"copy": "Copy",
	"noImage": "Add or paste an image first",
	"tooLarge": "An image exceeds 8MB",
	"tooMany": "Select up to 8 images",
	"compareNeedsTwo": "Comparison needs at least 2 images",
	"regionNeeded": "Region inspection needs a region",
	"error": "Recognition failed"
};

export const inject = ["slots", "locale"];

export function apply(ctx: any) {
	ctx.effect(() => ctx.locale.register("youreyes", { zh, en }), "dsh-youreyes: dictionaries");
	ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
		name: "conversation.session.header.actions",
		id: "dsh-youreyes",
		order: 20,
		locale: "youreyes"
	}, (props: any) => {
		const { t } = props;
		const [open, setOpen] = useState(false);
		const rootRef = useRef<HTMLDivElement>(null);
		return (
			<div style={{ position: "relative", display: "inline-flex" }} ref={rootRef}>
				<button type="button" style={btnStyle}
					onMouseEnter={(event) => { event.currentTarget.style.color = "var(--dsw-alias-label-secondary)"; }}
					onMouseLeave={(event) => { if (!open) event.currentTarget.style.color = ""; }}
					onClick={() => setOpen((value) => !value)} aria-expanded={open} title={t("buttonAria")}>
					{t("button")}
				</button>
				{open ? <><div style={{ position: "fixed", inset: 0, zIndex: 999 }} onClick={() => setOpen(false)} /><VisionPanel t={t} /></> : null}
			</div>
		);
	}));
}
