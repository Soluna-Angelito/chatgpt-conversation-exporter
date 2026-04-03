// export.js
// ==UserScript==
// @name         ChatGPT Conversation Exporter
// @namespace    chatgpt.conversation.exporter
// @version      2.3.4
// @description  Capture and export ChatGPT conversations in multiple formats (Raw JSON, Clean JSON, Markdown) with an in-page UI panel.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
    "use strict";

    const w = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;

    const BOOT = "__cce_boot_v234__";
    if (w[BOOT]) return;
    w[BOOT] = true;

    const SCRIPT_NAME = "ChatGPT Exporter";
    const VERSION = "2.3.4";

    /* =================================================================
       State — keyed by conversation ID so we survive SPA navigations
       ================================================================= */
    if (!w.__cce_captures__) w.__cce_captures__ = new Map();
    const captures = w.__cce_captures__;

    /* Thinking/reasoning toggle — persisted per browser */
    let includeThinking = false;
    try { includeThinking = localStorage.getItem("__cce_think__") === "1"; } catch {}
    function setIncludeThinking(v) {
        includeThinking = v;
        try { localStorage.setItem("__cce_think__", v ? "1" : "0"); } catch {}
    }

    /* =================================================================
       URL helpers
       ================================================================= */
    function toUrl(raw) {
        try { return new URL(String(raw), location.origin); }
        catch { return null; }
    }

    function currentConvId() {
        const m = location.pathname.match(/\/c\/([0-9a-f-]{36})(?:[/?#]|$)/i);
        return m ? m[1] : null;
    }

    function apiConvId(raw) {
        const u = toUrl(raw);
        if (!u) return null;
        const m = u.pathname.match(/^\/backend-api\/conversation\/([0-9a-f-]{36})$/i);
        return m ? m[1] : null;
    }

    /* =================================================================
       Validation & caching
       ================================================================= */
    function isConversation(o) {
        return o && typeof o === "object" && !Array.isArray(o)
            && o.mapping && typeof o.mapping === "object"
            && Object.keys(o.mapping).length > 0;
    }

    function store(rawUrl, json) {
        const pageId = currentConvId();
        const reqId = apiConvId(rawUrl);
        if (!pageId || !reqId || reqId !== pageId) return;
        if (!isConversation(json)) return;

        captures.set(reqId, { id: reqId, url: String(rawUrl), ts: Date.now(), json });
        console.log(`[${SCRIPT_NAME}] captured ${reqId}`);
        refreshFab();
        toast("Conversation captured", "success");
    }

    function active() {
        const id = currentConvId();
        return id ? captures.get(id) ?? null : null;
    }

    /* =================================================================
       Network hooks — installed at document-start
       ================================================================= */
    (function hookFetch() {
        if (w.__cce_fh__) return;
        w.__cce_fh__ = true;
        const orig = w.fetch;
        if (typeof orig !== "function") return;

        w.fetch = function (...a) {
            const p = orig.apply(this, a);
            p.then(res => {
                try {
                    const req = a[0];
                    const url = typeof req === "string" ? req : req?.url ?? "";
                    if (!apiConvId(url) || !res?.ok) return;
                    if (!(res.headers.get("content-type") ?? "").includes("application/json")) return;
                    res.clone().json().then(j => store(url, j)).catch(() => {});
                } catch { /* never disrupt the page */ }
            }).catch(() => {});
            return p;
        };
    })();

    (function hookXhr() {
        if (w.__cce_xh__) return;
        w.__cce_xh__ = true;
        const X = w.XMLHttpRequest;
        if (!X?.prototype) return;
        const oOpen = X.prototype.open;
        const oSend = X.prototype.send;

        X.prototype.open = function (m, url, ...r) {
            this.__cce_u__ = url;
            return oOpen.call(this, m, url, ...r);
        };
        X.prototype.send = function (...a) {
            this.addEventListener("load", function () {
                try {
                    const url = this.__cce_u__;
                    if (!apiConvId(url)) return;
                    if (this.status < 200 || this.status >= 300) return;
                    if (this.responseType && this.responseType !== "" && this.responseType !== "text") return;
                    store(url, JSON.parse(this.responseText));
                } catch { /* silent */ }
            });
            return oSend.apply(this, a);
        };
    })();

    /* =================================================================
       Conversation tree → linear message list + metadata
       ================================================================= */
    function linearize(json) {
        if (!isConversation(json)) return [];
        const { mapping, current_node } = json;
        if (!current_node || !mapping[current_node]) return [];

        const chain = [];
        let id = current_node;
        while (id && mapping[id]) {
            chain.push(mapping[id]);
            id = mapping[id].parent;
        }
        chain.reverse();

        return chain
            .filter(n => n.message && !n.message.metadata?.is_visually_hidden_from_conversation)
            .map(n => n.message);
    }

    function meta(json, msgs) {
        if (!msgs) msgs = linearize(json);
        const users = msgs.filter(m => m.author?.role === "user");
        const bots = msgs.filter(m => m.author?.role === "assistant");
        const last = bots[bots.length - 1];
        const model = last?.metadata?.model_slug
            ?? last?.metadata?.resolved_model_slug
            ?? json.default_model_slug ?? "unknown";

        return {
            title: json.title || "Untitled",
            id: json.conversation_id,
            model,
            created: json.create_time ? new Date(json.create_time * 1000) : null,
            updated: json.update_time ? new Date(json.update_time * 1000) : null,
            userCount: users.length,
            botCount: bots.length,
        };
    }

    /* =================================================================
       Formatters
       ================================================================= */

    /*  ChatGPT wraps citation markers with Private Use Area characters:
            U+E200 = start delimiter
            U+E202 = internal separator (between "cite"/"turn" groups)
            U+E201 = end delimiter
        We handle both PUA-wrapped and bare markers for robustness. */
    const PUA = "\uE200-\uE202";
    const CITE_STRIP_RE = new RegExp(
        `[${PUA}]*cite[${PUA}]*turn[${PUA}\\d]*view[${PUA}\\d]+` +
        `(?:[${PUA}]*turn[${PUA}\\d]*view[${PUA}\\d]+)*[${PUA}]*`, "g"
    );

    function stripCites(text) {
        CITE_STRIP_RE.lastIndex = 0;
        return text.replace(CITE_STRIP_RE, "");
    }

    function extractText(msg) {
        const ct = msg.content?.content_type;
        const parts = Array.isArray(msg.content?.parts) ? msg.content.parts : null;

        // `multimodal_text` is common for prompts with uploads/images.
        // Keep only user-visible text parts and ignore asset pointer objects.
        if ((ct === "text" || ct === "multimodal_text") && parts) {
            return parts.filter(p => typeof p === "string").join("\n");
        }
        if (ct === "code") return msg.content.text ?? "";
        return "";
    }

    function isRenderedAssistant(msg) {
        if (msg.metadata?.is_thinking_preamble_message) return false;
        if (msg.channel === "commentary") return false;
        if (msg.metadata?.reasoning_status === "is_reasoning") return false;
        return msg.channel === "final" || msg.end_turn;
    }

    /* ---- Thinking / reasoning extraction ---- */
    function isThinkingToolMsg(msg) {
        if (msg.author?.role !== "tool") return false;
        if (msg.metadata?.initial_text === "Thinking") return true;
        const ft = msg.metadata?.finished_text;
        if (ft && /^(?:.*동안\s+)?(?:\*\*)?Thought\s+(?:for|about)\b/i.test(ft)) return true;
        if (ft && /(?:Thought\s+for|동안)\s*$/i.test(ft)) return true;
        return false;
    }

    function isThinkingSummaryLine(line) {
        return /^(?:\d+\S*\s+동안\s+)?(?:\*\*)?Thought\s+(?:for|about)\b/i.test(line)
            || /^\d+\S*\s+동안\b/i.test(line)
            || /^Thinking$/i.test(line);
    }

    function parseThinkingSummary(text) {
        if (!text) return "Thinking";
        const clean = text.replace(/\*\*/g, "");
        const first = clean.split("\n")[0].trim();
        if (first.length <= 80 && isThinkingSummaryLine(first)) return first;
        if (first.length <= 80) return first;
        const m = clean.match(/^(?:\d+\S*\s+동안\s+)?Thought\s+(?:for|about)\b[^\n]{0,80}/i);
        if (m) return m[0].trim();
        const dur = clean.match(/(?:Thought\s+)?for\s+(\d+)\s+seconds?\s*$/i);
        if (dur) return `Thought for ${dur[1]} seconds`;
        const k = clean.match(/(\d+)\S*\s+동안/);
        if (k) return `Thought for ${k[1]}s`;
        return "Thinking";
    }

    function extractThinkingContent(msg) {
        const text = extractText(msg).trim();
        if (text) return text;
        const ft = msg.metadata?.finished_text;
        if (!ft || ft.length < 150) return null;
        const nlIdx = ft.indexOf("\n");
        if (nlIdx < 0) return null;
        const firstLine = ft.substring(0, nlIdx).trim();
        const rest = ft.substring(nlIdx).replace(/^\n+/, "").trim();
        if (!rest) return null;
        if (isThinkingSummaryLine(firstLine.replace(/\*\*/g, ""))) return rest;
        return ft;
    }

    function fmtThinkingDuration(sec) {
        if (!sec) return null;
        sec = Math.round(sec);
        if (sec < 2) return "Thought briefly";
        const m = Math.floor(sec / 60), s = sec % 60;
        if (m > 0) return `Thought for ${m}m ${s}s`;
        return `Thought for ${sec} seconds`;
    }

    function buildThinkingMap(msgs) {
        const map = new Map();
        let pending = null;
        for (let i = 0; i < msgs.length; i++) {
            const msg = msgs[i];
            const ct = msg.content?.content_type;
            if (isThinkingToolMsg(msg)) {
                const content = extractThinkingContent(msg);
                const sec = msg.metadata?.finished_duration_sec;
                pending = { summary: parseThinkingSummary(msg.metadata?.finished_text), content };
                if (sec) { pending.duration_seconds = sec; pending._durSummary = true; }
                continue;
            }
            if (ct === "reasoning_recap") {
                const sec = msg.metadata?.finished_duration_sec;
                const s = msg.content?.content || fmtThinkingDuration(sec);
                pending = pending || {};
                if (s) pending.summary = s;
                else if (!pending.summary) pending.summary = "Thinking";
                if (sec) pending.duration_seconds = sec;
                continue;
            }
            if (ct === "thoughts") {
                const rawThoughts = msg.content?.thoughts;
                if (Array.isArray(rawThoughts) && rawThoughts.length > 0) {
                    pending = pending || { summary: "Thinking" };
                    if (!pending.thoughts) pending.thoughts = [];
                    for (const t of rawThoughts) {
                        if (!t.content && !(Array.isArray(t.chunks) && t.chunks.length)) continue;
                        const entry = {};
                        if (t.summary) entry.summary = t.summary;
                        if (t.content) entry.content = t.content;
                        if (Array.isArray(t.chunks) && t.chunks.length > 0) entry.chunks = t.chunks;
                        pending.thoughts.push(entry);
                        if (t.content) {
                            pending.content = pending.content
                                ? pending.content + "\n\n" + t.content : t.content;
                        }
                    }
                    if (!pending._durSummary) {
                        let last = null;
                        for (const t of rawThoughts) if (t.summary) last = t.summary;
                        if (last) pending.summary = last;
                    }
                } else {
                    const text = extractText(msg).trim();
                    if (text) {
                        pending = pending || { summary: "Thinking" };
                        pending.content = pending.content
                            ? pending.content + "\n\n" + text : text;
                    }
                }
                continue;
            }
            if (msg.author?.role === "assistant") {
                if (msg.metadata?.is_thinking_preamble_message || msg.channel === "commentary") {
                    const text = extractText(msg).trim();
                    if (text) {
                        pending = pending || { summary: "Thinking" };
                        if (!pending.preambles) pending.preambles = [];
                        pending.preambles.push(text);
                    }
                    continue;
                }
                if (ct === "code" && msg.metadata?.reasoning_status === "is_reasoning") continue;
                if (msg.metadata?.finished_duration_sec && !extractText(msg).trim()) {
                    const sec = msg.metadata.finished_duration_sec;
                    const s = fmtThinkingDuration(sec);
                    pending = pending || {};
                    if (s) { pending.summary = s; pending._durSummary = true; }
                    if (sec) pending.duration_seconds = sec;
                    continue;
                }
                if (isRenderedAssistant(msg)) {
                    if (pending) {
                        delete pending._durSummary;
                        map.set(i, pending);
                        pending = null;
                    }
                    continue;
                }
            }
            if (msg.author?.role === "user") pending = null;
        }
        return map;
    }

    /* ---- Clean JSON ---- */
    function toCleanJson(json) {
        const msgs = linearize(json);
        const m = meta(json, msgs);
        const thinkingMap = includeThinking ? buildThinkingMap(msgs) : null;
        const out = [];

        for (let i = 0; i < msgs.length; i++) {
            const msg = msgs[i];
            const role = msg.author?.role;
            if (role !== "user" && role !== "assistant") continue;
            const ct = msg.content?.content_type;
            if (ct === "reasoning_recap" || ct === "thoughts") continue;

            if (role === "assistant" && !isRenderedAssistant(msg)) continue;

            const text = stripCites(extractText(msg)).trim();
            if (!text) continue;

            const entry = { role, content: text };
            if (msg.create_time) entry.timestamp = new Date(msg.create_time * 1000).toISOString();
            if (msg.metadata?.resolved_model_slug) entry.model = msg.metadata.resolved_model_slug;
            if (msg.metadata?.token_count) entry.tokens = msg.metadata.token_count;
            if (thinkingMap?.has(i)) {
                const th = thinkingMap.get(i);
                entry.thinking = { summary: th.summary };
                if (th.duration_seconds) entry.thinking.duration_seconds = th.duration_seconds;
                if (th.preambles?.length) entry.thinking.preambles = th.preambles;
                if (th.content) entry.thinking.content = th.content;
                if (th.thoughts?.length) entry.thinking.thoughts = th.thoughts;
            }
            out.push(entry);
        }

        return {
            title: m.title, id: m.id, model: m.model,
            created_at: m.created?.toISOString() ?? null,
            updated_at: m.updated?.toISOString() ?? null,
            messages: out,
        };
    }

    /* ---- Citation resolver (mirrors ChatGPT's copy-message format) ---- */
    function createCiteResolver() {
        const urlToNum = new Map();
        const footnotes = [];
        let counter = 0;

        return {
            resolve(text, contentRefs) {
                if (!Array.isArray(contentRefs) || contentRefs.length === 0) {
                    return stripCites(text);
                }

                for (const ref of contentRefs) {
                    const mt = ref?.matched_text;
                    if (typeof mt !== "string" || !text.includes(mt)) continue;

                    const item = ref.items?.[0];
                    if (!item?.url) { text = text.replace(mt, ""); continue; }

                    const { url, title, attribution } = item;
                    let num;
                    if (urlToNum.has(url)) {
                        num = urlToNum.get(url);
                    } else {
                        num = ++counter;
                        urlToNum.set(url, num);
                        footnotes.push({ num, url, title: title || url });
                    }
                    text = text.replace(mt, ` ([${attribution || "Source"}][${num}])`);
                }
                return stripCites(text);
            },

            getFootnotes() {
                return footnotes.map(f => `[${f.num}]: ${f.url} "${f.title}"`);
            },
            hasFootnotes() { return footnotes.length > 0; },
        };
    }

    /* ---- Markdown ---- */
    function toMarkdown(json) {
        const msgs = linearize(json);
        const m = meta(json, msgs);
        const thinkingMap = includeThinking ? buildThinkingMap(msgs) : null;
        const lines = [];
        let preambleBuf = [];

        lines.push(`# ${m.title}`, "");
        const info = [];
        if (m.model) info.push(`**Model:** ${m.model}`);
        if (m.created) info.push(`**Created:** ${m.created.toLocaleString()}`);
        if (m.updated) info.push(`**Updated:** ${m.updated.toLocaleString()}`);
        info.push(`**Messages:** ${m.userCount} user · ${m.botCount} assistant`);
        lines.push(info.join("  \n"), "", "---", "");

        for (let i = 0; i < msgs.length; i++) {
            const msg = msgs[i];
            const role = msg.author?.role;
            const ct = msg.content?.content_type;

            if (role === "system" || role === "tool") continue;
            if (ct === "thoughts") continue;

            if (ct === "reasoning_recap") {
                if (!includeThinking) {
                    const recapText = msg.content?.content
                        || fmtThinkingDuration(msg.metadata?.finished_duration_sec);
                    if (recapText) preambleBuf.push(recapText);
                }
                continue;
            }

            if (role === "assistant") {
                if (msg.metadata?.is_thinking_preamble_message || msg.channel === "commentary") {
                    const t = extractText(msg).trim();
                    if (t) preambleBuf.push(t);
                    continue;
                }
                if (ct === "code" && msg.metadata?.reasoning_status === "is_reasoning") continue;
                if (!(msg.channel === "final" || msg.end_turn)) continue;

                const model = msg.metadata?.resolved_model_slug ?? m.model;
                lines.push(`# ChatGPT *(${model})*`, "");

                if (preambleBuf.length) {
                    // for (const p of preambleBuf) lines.push(`> *${p}*`, "");
                    for (const p of preambleBuf) lines.push(`*${p}*`, "");
                    lines.push("");
                    preambleBuf = [];
                }

                if (thinkingMap?.has(i)) {
                    const th = thinkingMap.get(i);
                    if (th.content || th.thoughts?.length) {
                        lines.push("<details>", `<summary><b>${escHtml(th.summary)}</b></summary>`, "");
                        if (th.thoughts?.length) {
                            for (const t of th.thoughts) {
                                if (t.summary) lines.push(`**${t.summary}**`, "");
                                if (t.content) lines.push(t.content, "");
                            }
                        } else if (th.content) {
                            lines.push(th.content, "");
                        }
                        lines.push("</details>", "");
                    } else if (th.summary) {
                        lines.push(`*${th.summary}*`, "");
                    }
                }
            } else if (role === "user") {
                lines.push("# You", "");
                preambleBuf = [];
            }

            let text = extractText(msg);
            if (ct === "code") {
                text = "```" + (msg.content.language ?? "") + "\n" + text + "\n```";
            }

            const cite = createCiteResolver();
            text = cite.resolve(text, msg.metadata?.content_references).trim();
            if (text) {
                lines.push(text, "");
                if (cite.hasFootnotes()) lines.push(...cite.getFootnotes(), "");
                lines.push("---", "");
            }
        }

        return lines.join("\n");
    }

    /* =================================================================
       File / clipboard helpers
       ================================================================= */
    function safeName(n) {
        return String(n || "conversation")
            .replace(/[\\/:*?"<>|]+/g, "_")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 120);
    }

    function download(name, content, mime) {
        const blob = new Blob([content], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = Object.assign(document.createElement("a"), { href: url, download: name });
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 3000);
    }

    async function clip(text) {
        try { await navigator.clipboard.writeText(text); return true; }
        catch {
            const t = Object.assign(document.createElement("textarea"), { value: text });
            t.style.cssText = "position:fixed;opacity:0;pointer-events:none";
            document.body.appendChild(t);
            t.select();
            const ok = document.execCommand("copy");
            t.remove();
            return ok;
        }
    }

    /* =================================================================
       Export actions
       ================================================================= */
    function noData() { toast("No data captured for this conversation — refresh the page.", "error"); }

    function dlRaw() {
        const c = active();
        if (!c) return noData();
        const n = safeName(c.json.title ?? c.id);
        download(`${n}.raw.json`, JSON.stringify(c.json, null, 2), "application/json");
        toast(`Downloaded ${n}.raw.json`, "success");
    }

    function dlClean() {
        const c = active();
        if (!c) return noData();
        const obj = toCleanJson(c.json);
        const n = safeName(obj.title);
        download(`${n}.json`, JSON.stringify(obj, null, 2), "application/json");
        toast(`Downloaded ${n}.json`, "success");
    }

    function dlMarkdown() {
        const c = active();
        if (!c) return noData();
        const n = safeName(c.json.title ?? c.id);
        download(`${n}.md`, toMarkdown(c.json), "text/markdown");
        toast(`Downloaded ${n}.md`, "success");
    }

    function cpClean() {
        const c = active();
        if (!c) return noData();
        clip(JSON.stringify(toCleanJson(c.json), null, 2))
            .then(ok => toast(ok ? "Clean JSON → clipboard" : "Copy failed", ok ? "success" : "error"));
    }

    function cpMarkdown() {
        const c = active();
        if (!c) return noData();
        clip(toMarkdown(c.json))
            .then(ok => toast(ok ? "Markdown → clipboard" : "Copy failed", ok ? "success" : "error"));
    }

    /* =================================================================
       UI — Toast notifications
       ================================================================= */
    let toastBox = null;

    function toast(msg, type = "info") {
        if (!document.body) return;
        if (!toastBox) {
            toastBox = document.createElement("div");
            Object.assign(toastBox.style, {
                position: "fixed", top: "50px", right: "16px", zIndex: "2147483647",
                display: "flex", flexDirection: "column", gap: "8px", pointerEvents: "none",
            });
            document.body.appendChild(toastBox);
        }

        const bg = { success: "#10a37f", error: "#ef4444", info: "#3b82f6" }[type] ?? "#3b82f6";
        const el = document.createElement("div");
        el.textContent = msg;
        Object.assign(el.style, {
            background: bg, color: "#fff",
            padding: "10px 16px", borderRadius: "8px",
            font: '13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
            boxShadow: "0 4px 12px rgba(0,0,0,.3)",
            opacity: "0", transform: "translateX(20px)",
            transition: "all .3s ease", pointerEvents: "auto",
            maxWidth: "340px", wordBreak: "break-word",
        });
        toastBox.appendChild(el);
        requestAnimationFrame(() => { el.style.opacity = "1"; el.style.transform = "translateX(0)"; });
        setTimeout(() => {
            el.style.opacity = "0";
            el.style.transform = "translateX(20px)";
            setTimeout(() => el.remove(), 300);
        }, 3000);
    }

    /* =================================================================
       UI — SVG icons
       ================================================================= */
    const svgAttrs = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
    const ICONS = {
        download: `<svg ${svgAttrs}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
        close:    `<svg ${svgAttrs}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
        copy:     `<svg ${svgAttrs}><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
        md:       `<svg ${svgAttrs}><path d="M2 4h20v16H2z"/><path d="M6 12V8l2 2 2-2v4"/><path d="M18 12l-2-2v4"/><path d="M16 10v4"/></svg>`,
        json:     `<svg ${svgAttrs}><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`,
        think:    `<svg ${svgAttrs}><path d="M12 2a7 7 0 0 0-4 12.7V16a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-1.3A7 7 0 0 0 12 2z"/><line x1="9" y1="18" x2="15" y2="18"/><line x1="10" y1="21" x2="14" y2="21"/></svg>`,
    };

    function icon(name, size = 16) {
        const span = document.createElement("span");
        span.innerHTML = ICONS[name] ?? "";
        Object.assign(span.style, { display: "inline-flex", width: `${size}px`, height: `${size}px`, flexShrink: "0" });
        return span;
    }

    /* =================================================================
       UI — Theme detection
       ================================================================= */
    function getTheme() {
        const dark = document.documentElement.classList.contains("dark")
            || document.documentElement.getAttribute("data-theme") === "dark"
            || (getComputedStyle(document.body).backgroundColor.match(/rgb\((\d+)/) ?? [])[1] < 50;

        return dark
            ? { bg: "#2f2f2f", surface: "#383838", text: "#e8e8e8", dim: "#9a9a9a", border: "#4a4a4a", btn: "#424242", btnH: "#4f4f4f" }
            : { bg: "#ffffff", surface: "#f7f7f8", text: "#1a1a1a", dim: "#666666", border: "#e5e5e5", btn: "#f0f0f0", btnH: "#e0e0e0" };
    }

    /* =================================================================
       UI — Floating Action Button & Panel
       ================================================================= */
    let fab = null;
    let panel = null;
    let panelVisible = false;

    function createFab() {
        if (fab) return;
        document.getElementById("__cce_fab__")?.remove();
        fab = document.createElement("div");
        fab.id = "__cce_fab__";
        fab.innerHTML = ICONS.download;
        Object.assign(fab.style, {
            position: "fixed", bottom: "30px", right: "40px", zIndex: "2147483646",
            width: "40px", height: "40px", borderRadius: "50%",
            background: "#6e6e80", color: "#fff", cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: "0 2px 10px rgba(0,0,0,.35)",
            transition: "all .25s ease", padding: "11px", userSelect: "none",
        });
        fab.title = `${SCRIPT_NAME} v${VERSION}`;
        fab.addEventListener("mouseenter", () => {
            fab.style.transform = "scale(1.08)";
            fab.style.boxShadow = "0 4px 16px rgba(0,0,0,.45)";
        });
        fab.addEventListener("mouseleave", () => {
            fab.style.transform = "scale(1)";
            fab.style.boxShadow = "0 2px 10px rgba(0,0,0,.35)";
        });
        fab.addEventListener("click", () => { panelVisible ? closePanel() : openPanel(); });
        document.body.appendChild(fab);
    }

    function refreshFab() {
        if (fab) fab.style.background = active() ? "#10a37f" : "#6e6e80";
    }

    function escHtml(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
    function fmtDate(d) { return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }

    function openPanel() {
        if (panel) panel.remove();
        panelVisible = true;
        const T = getTheme();
        const cap = active();
        const m = cap ? meta(cap.json) : null;

        panel = document.createElement("div");
        Object.assign(panel.style, {
            position: "fixed", bottom: "90px", right: "40px", zIndex: "2147483646",
            width: "360px", background: T.bg, color: T.text,
            border: `1px solid ${T.border}`, borderRadius: "14px",
            boxShadow: "0 8px 32px rgba(0,0,0,.35)",
            font: '13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
            opacity: "0", transform: "translateY(10px) scale(.97)",
            transition: "all .2s cubic-bezier(.4,0,.2,1)", overflow: "hidden",
        });

        /* ---- header ---- */
        const hdr = document.createElement("div");
        Object.assign(hdr.style, {
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "14px 16px", borderBottom: `1px solid ${T.border}`,
        });

        const hLeft = document.createElement("div");
        Object.assign(hLeft.style, { display: "flex", alignItems: "center" });
        const hTitle = Object.assign(document.createElement("span"), { textContent: SCRIPT_NAME });
        Object.assign(hTitle.style, { fontWeight: "600", fontSize: "15px" });
        const verBadge = Object.assign(document.createElement("span"), { textContent: `v${VERSION}` });
        Object.assign(verBadge.style, { fontSize: "10px", padding: "2px 6px", borderRadius: "4px", background: T.surface, color: T.dim, marginLeft: "8px" });
        hLeft.append(hTitle, verBadge);

        const closeBtn = document.createElement("div");
        closeBtn.innerHTML = ICONS.close;
        Object.assign(closeBtn.style, { width: "22px", height: "22px", cursor: "pointer", opacity: ".5", transition: "opacity .15s", padding: "1px" });
        closeBtn.onmouseenter = () => closeBtn.style.opacity = "1";
        closeBtn.onmouseleave = () => closeBtn.style.opacity = ".5";
        closeBtn.onclick = closePanel;
        hdr.append(hLeft, closeBtn);

        /* ---- info ---- */
        const info = document.createElement("div");
        Object.assign(info.style, { padding: "14px 16px", borderBottom: `1px solid ${T.border}` });

        if (m) {
            info.innerHTML = `
                <div style="font-weight:600;font-size:14px;margin-bottom:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(m.title)}</div>
                <div style="display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12px">
                    <span style="color:${T.dim}">Model</span>  <span>${escHtml(m.model)}</span>
                    <span style="color:${T.dim}">Messages</span><span>${m.userCount} user · ${m.botCount} assistant</span>
                    <span style="color:${T.dim}">Created</span> <span>${m.created ? fmtDate(m.created) : "—"}</span>
                    <span style="color:${T.dim}">Updated</span> <span>${m.updated ? fmtDate(m.updated) : "—"}</span>
                    ${m.id ? `<span style="color:${T.dim}">ID</span><span style="font-family:monospace;font-size:11px;opacity:.7;overflow:hidden;text-overflow:ellipsis">${escHtml(m.id)}</span>` : ""}
                </div>`;
        } else {
            const hint = currentConvId()
                ? "No data captured yet. <b>Refresh</b> this page to capture."
                : "Navigate to a conversation to begin.";
            info.innerHTML = `<div style="color:${T.dim};text-align:center;padding:12px 0">${hint}</div>`;
        }

        /* ---- export rows ---- */
        const actions = document.createElement("div");
        Object.assign(actions.style, { padding: "0 16px" });

        function makeRow(label, iconName, onDl, onCopy) {
            const row = document.createElement("div");
            Object.assign(row.style, { display: "flex", alignItems: "center", gap: "8px", padding: "7px 0", borderBottom: `1px solid ${T.border}` });

            const lbl = Object.assign(document.createElement("span"), { textContent: label });
            Object.assign(lbl.style, { flex: "1", fontWeight: "500", fontSize: "13px" });

            function actionBtn(ico, title, fn) {
                const b = document.createElement("div");
                b.appendChild(icon(ico, 15));
                b.title = title;
                Object.assign(b.style, {
                    width: "30px", height: "30px", borderRadius: "6px",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    cursor: "pointer", background: T.btn, transition: "background .15s",
                });
                b.onmouseenter = () => b.style.background = T.btnH;
                b.onmouseleave = () => b.style.background = T.btn;
                b.onclick = e => { e.stopPropagation(); fn(); };
                return b;
            }

            row.append(icon(iconName, 16), lbl, actionBtn("download", `Download ${label}`, onDl));
            if (onCopy) row.appendChild(actionBtn("copy", `Copy ${label}`, onCopy));
            return row;
        }

        function makeToggleRow() {
            const row = document.createElement("div");
            Object.assign(row.style, {
                display: "flex", alignItems: "center", gap: "8px",
                padding: "7px 0", borderBottom: `1px solid ${T.border}`,
            });

            row.appendChild(icon("think", 16));
            const lbl = Object.assign(document.createElement("span"), { textContent: "Include thinking" });
            Object.assign(lbl.style, { flex: "1", fontWeight: "500", fontSize: "13px" });
            row.appendChild(lbl);

            const sw = document.createElement("div");
            Object.assign(sw.style, {
                width: "36px", height: "20px", borderRadius: "10px",
                background: includeThinking ? "#10a37f" : T.btn, cursor: "pointer",
                transition: "background .2s ease", position: "relative", flexShrink: "0",
            });
            const knob = document.createElement("div");
            Object.assign(knob.style, {
                width: "16px", height: "16px", borderRadius: "50%",
                background: "#fff", position: "absolute", top: "2px",
                left: includeThinking ? "18px" : "2px",
                transition: "left .2s ease", boxShadow: "0 1px 3px rgba(0,0,0,.3)",
            });
            sw.appendChild(knob);
            sw.addEventListener("click", () => {
                setIncludeThinking(!includeThinking);
                knob.style.left = includeThinking ? "18px" : "2px";
                sw.style.background = includeThinking ? "#10a37f" : T.btn;
            });
            row.appendChild(sw);
            return row;
        }

        if (m) {
            actions.append(
                makeToggleRow(),
                makeRow("Raw JSON",   "json", dlRaw, null),
                makeRow("Clean JSON", "json", dlClean, cpClean),
                makeRow("Markdown",   "md",   dlMarkdown, cpMarkdown),
            );
            actions.lastChild.style.borderBottom = "none";
        }

        /* ---- footer ---- */
        const foot = document.createElement("div");
        Object.assign(foot.style, { padding: "8px 16px", textAlign: "center", fontSize: "11px", color: T.dim, borderTop: `1px solid ${T.border}`, background: T.surface });
        foot.innerHTML = `<kbd style="padding:1px 4px;border:1px solid ${T.border};border-radius:3px;font-size:10px;font-family:inherit">Ctrl+Shift+E</kbd> quick export Raw JSON`;

        panel.append(hdr, info);
        if (m) panel.appendChild(actions);
        panel.appendChild(foot);
        document.body.appendChild(panel);
        requestAnimationFrame(() => { panel.style.opacity = "1"; panel.style.transform = "translateY(0) scale(1)"; });
    }

    function closePanel() {
        panelVisible = false;
        if (!panel) return;
        panel.style.opacity = "0";
        panel.style.transform = "translateY(10px) scale(.97)";
        const ref = panel;
        setTimeout(() => ref.remove(), 220);
        panel = null;
    }

    /* =================================================================
       Keyboard shortcut & SPA navigation
       ================================================================= */
    function bindKeys() {
        document.addEventListener("keydown", e => {
            if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === "KeyE") {
                e.preventDefault();
                dlRaw();
            }
        });
    }

    function watchNav() {
        let last = location.href;
        const check = () => {
            if (location.href !== last) {
                last = location.href;
                refreshFab();
                if (panelVisible) { closePanel(); setTimeout(openPanel, 240); }
            }
        };
        const origPush = history.pushState;
        const origReplace = history.replaceState;
        history.pushState = function (...a) { origPush.apply(this, a); check(); };
        history.replaceState = function (...a) { origReplace.apply(this, a); check(); };
        w.addEventListener("popstate", check);
    }

    function bindClickAway() {
        document.addEventListener("click", e => {
            if (!panelVisible || !panel) return;
            if (panel.contains(e.target) || fab?.contains(e.target)) return;
            closePanel();
        }, true);
    }

    /* =================================================================
       Init
       ================================================================= */
    function boot() {
        if (!document.body) {
            if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
            else setTimeout(boot, 50);
            return;
        }
        createFab();
        refreshFab();
        bindKeys();
        watchNav();
        bindClickAway();
    }

    boot();

    // GM_registerMenuCommand("Export Raw JSON",   dlRaw);
    // GM_registerMenuCommand("Export Clean JSON", dlClean);
    // GM_registerMenuCommand("Export Markdown",   dlMarkdown);
    // GM_registerMenuCommand("Copy Clean JSON",   cpClean);
    // GM_registerMenuCommand("Copy Markdown",     cpMarkdown);

})();
