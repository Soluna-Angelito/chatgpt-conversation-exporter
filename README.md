# ChatGPT Conversation Exporter

A Tampermonkey userscript that captures ChatGPT conversations directly from the API and lets you export them as **Raw JSON**, **Clean JSON**, or **Markdown** — all from a sleek in-page panel.

## Why?

ChatGPT has no built-in per-conversation export. This script intercepts the same API responses the site already loads, so there's **no extra network request, no DOM scraping, and no data loss** — you get the full conversation payload including branches, model info, token counts, and timestamps.

## Features

- **Zero-dependency capture** — hooks `fetch` and `XMLHttpRequest` at `document-start` to grab conversation JSON before the page even renders.
- **Three export formats**
  - **Raw JSON** — the complete API payload, pretty-printed.
  - **Clean JSON** — linearized messages with role, content, timestamp, model, and token count; strips internal markers and hidden system messages.
  - **Markdown** — human-readable document with title, metadata, speaker headings, code fences, reasoning/thought blocks as blockquotes, and resolved citation footnotes.
- **Download or copy** — every format can be downloaded as a file; Clean JSON and Markdown can also be copied to the clipboard.
- **Floating Action Button** — a small download icon sits in the bottom-right corner; turns **green** when the current conversation has captured data.
- **Info panel** — shows conversation title, model, message counts, creation/update dates, and conversation ID.
- **Keyboard shortcut** — `Ctrl+Shift+E` instantly downloads the Raw JSON.
- **SPA-aware** — survives client-side navigation between conversations without a full page reload.
- **Light & dark theme** — auto-detects ChatGPT's current theme and styles the panel to match.

## Installation

1. Install **[Tampermonkey](https://www.tampermonkey.net/)** (Chrome, Firefox, Edge, Safari) or a compatible userscript manager (Violentmonkey, etc.).
2. **Option A — One-click install:** Click the `.js` file in this repo and use your userscript manager's "install from URL" feature.
   **Option B — Manual:** Open your userscript manager dashboard → Create a new script → Paste the contents of [`ChatGPT Conversation Exporter.js`](ChatGPT%20Conversation%20Exporter.js) → Save.
3. Make sure the script is **enabled**.

## Usage

1. Go to [chatgpt.com](https://chatgpt.com) (or `chat.openai.com`) and open any conversation.
2. The page loads the conversation from the API — the script captures it automatically. The **FAB turns green** and a brief toast confirms the capture.
3. Click the **FAB** to open the export panel.
4. Choose your format and click **Download** or **Copy**.

| Format | Filename | Download | Copy |
|--------|----------|:--------:|:----:|
| Raw JSON | `{title}.raw.json` | Yes | — |
| Clean JSON | `{title}.json` | Yes | Yes |
| Markdown | `{title}.md` | Yes | Yes |

> **Tip:** If the FAB is grey and the panel says *"No data captured"*, simply **refresh** the page so the script can intercept the API response.

## Export Format Details

### Raw JSON

The unmodified conversation object returned by ChatGPT's backend API, including the full `mapping` tree, all branches, system messages, and metadata. Useful for archival or programmatic analysis.

### Clean JSON

A simplified structure focused on the visible conversation:

```json
{
  "title": "My Conversation",
  "id": "abc-123",
  "model": "gpt-4o",
  "created_at": "2025-06-01T12:00:00.000Z",
  "updated_at": "2025-06-01T12:05:00.000Z",
  "messages": [
    {
      "role": "user",
      "content": "Hello!",
      "timestamp": "2025-06-01T12:00:01.000Z"
    },
    {
      "role": "assistant",
      "content": "Hi there! How can I help you today?",
      "model": "gpt-4o",
      "tokens": 42,
      "timestamp": "2025-06-01T12:00:03.000Z"
    }
  ]
}
```

Hidden system messages, empty assistant stubs, and internal citation markers (PUA characters) are stripped automatically.

### Markdown

A human-readable document:

```markdown
# My Conversation

- **Model:** gpt-4o
- **Created:** Jun 1, 2025, 12:00 PM
- **Updated:** Jun 1, 2025, 12:05 PM
- **Messages:** 4 user · 5 assistant

---

## You

Hello!

---

## ChatGPT *(gpt-4o)*

Hi there! How can I help you today?
```

Code blocks, reasoning/thought content (as blockquotes), and citations (as numbered footnotes with links) are all preserved.

## Keyboard Shortcut

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+E` | Download Raw JSON for the current conversation |

## How It Works

1. **Injection** — The script runs at `document-start` and patches `window.fetch` and `XMLHttpRequest.prototype.open` before the page's own code executes.
2. **Filtering** — Only responses from `/backend-api/conversation/{uuid}` with a valid `mapping` object are captured. The captured ID must match the current page URL to avoid cross-talk between overlapping requests.
3. **Storage** — Captured JSON is held in a `Map` on the page's `window` object, keyed by conversation ID. This survives SPA navigations without a full reload.
4. **Navigation tracking** — `history.pushState`, `history.replaceState`, and `popstate` are monitored to update the FAB indicator and refresh the panel when you switch conversations.
5. **Export** — Downloads use a temporary `<a download>` element with a `Blob` URL. Clipboard copy uses `navigator.clipboard.writeText` with a `textarea` + `execCommand('copy')` fallback.

## Compatibility

| Site | Supported |
|------|:---------:|
| `chatgpt.com` | Yes |
| `chat.openai.com` | Yes |

**Tested with:** Tampermonkey on Chrome and Firefox. Should work with any userscript manager that supports `@grant unsafeWindow` and `@run-at document-start`.

## License

MIT
