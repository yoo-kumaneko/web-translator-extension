# Web Article Translator - Chrome Extension

## Overview
Chrome extension (Manifest V3) that translates English web articles to Chinese with side-by-side display. Uses "Universal Content Detection" with "Context-Aware HTML Batching".

## Architecture

### Files
- **manifest.json** — MV3 manifest; content script injected at `document_idle` on all HTTPS pages
- **content.js** — Content script: detects article elements, batches text into `<span id="wat-N">` wrapped HTML chunks, sends to background for translation, maps results back to DOM
- **background.js** — Service worker: routes translation requests to the configured provider (Google, OpenAI LLM, or Qwen MT)
- **popup.js** / **popup.html** — Extension popup UI: translate/stop buttons, settings panel, metrics display
- **styles.css** — Styles for translated elements and loading states

### Translation Flow
1. User clicks "Translate" in popup → sends `startTranslation` message to content script
2. `content.js` finds translatable elements via `getArticleElements()` → `shouldTranslate()` filter
3. Text extracted from elements (with sr-only content stripped), wrapped in `<span id="wat-N">` tags, chunked by size limit
4. Chunks sent in parallel to background.js via `chrome.runtime.sendMessage`
5. Background routes to configured provider, returns translated HTML
6. Content script parses response, maps `<span>` IDs back to DOM placeholders

### Translation Providers (background.js)
- **Google Translate** — Official V2 API (with API key) or unofficial/free endpoint; format: `html`
- **OpenAI LLM** (`translateLLM`) — OpenAI-compatible chat completions; uses system prompt instructing HTML structure preservation; default model: `gpt-4o-mini`
- **Qwen MT** (`translateQwenMT`) — Alibaba's specialized MT model; uses `translation_options` field, **NO system prompt** (only `user`/`assistant` roles allowed); auto-fallbacks to Google on safety filter rejection (`data_inspection_failed`)

### Content Detection (content.js)
- **Target tags**: P, DIV, BLOCKQUOTE, FIGCAPTION, LI, H1-H6
- **Visibility check**: `getComputedStyle` for `display:none`/`visibility:hidden` + zero-dimension check (NOT `offsetParent` — that breaks `position:fixed` and React-hydrated pages)
- **Ancestor exclusion**: Semantic tags (`nav`, `header`, `footer`, `aside`) and keyword matching on class tokens (token-level `startsWith`, not substring `.includes()` — prevents Tailwind false positives like `scroll-mt-header-h`)
- **Deduplication**: When nested elements both qualify (e.g., `<figcaption>` containing `<p>`), only the innermost is kept
- **SR-only stripping**: Clones elements and removes `.sr-only`, `.visually-hidden`, `.screen-reader-text`, `[aria-hidden="true"]` before extracting `innerText`
- **DIV filter**: DIVs require direct text nodes (>10 chars) to qualify

## Key Design Decisions & Gotchas

- **Span ID preservation is critical**: The `<span id="wat-N">` wrapper is how translations map back to DOM elements. If an API mangles or drops these IDs, translations show "无法获取对应翻译" (cannot retrieve translation).
- **Qwen MT does NOT support system role**: Sending `role: 'system'` returns 400 `invalid_parameter_error`. Any instructions must go in the user message or be handled client-side.
- **Tailwind/modern CSS compatibility**: Class-based keyword exclusion must use token-level matching, not substring. Tailwind utility classes embed words like "header", "nav", "footer" in non-semantic contexts (e.g., `scroll-mt-header-h`, `text-nav`).
- **Client-side rendered pages** (Next.js, React): The old `offsetParent === null` check broke on hydrated pages. Current approach uses computed style + dimensions.
- **Chunk size** is configurable per provider (default 3000 chars, range 500-10000).
- **LLM markdown cleanup**: OpenAI sometimes wraps output in ```html blocks despite system prompt; regex cleanup handles this.

## Common Test Sites
- **OpenAI blog** (`openai.com/index/...`) — Next.js/React, Tailwind CSS, sr-only spans
- **Guardian / NYT** — Traditional article layout, regression baseline
