# Web Article Translator - Chrome Extension

> **Note:** This CLAUDE.md serves as the project's living documentation. Keep it updated whenever code changes are made — new features, modified behavior, changed defaults, or architectural shifts should be reflected here.

## Overview
Chrome extension (Manifest V3) that translates English web articles to Chinese with side-by-side display. Uses "Universal Content Detection" with "Context-Aware HTML Batching". Translated paragraphs are inserted directly below the original text in the DOM, preserving the article's native styling.

## Project Structure

```
├── manifest.json        — MV3 manifest; content script on all HTTPS pages (default document_idle)
├── content.js (303 lines)  — Content script: detection, batching, DOM insertion, caching
├── background.js (314 lines) — Service worker: provider routing, API calls, fallback logic
├── popup.html           — Extension popup UI (300px wide, inline CSS + external JS)
├── popup.js (211 lines) — Popup logic: translate/toggle buttons, settings CRUD, metrics display
├── styles.css           — Minimal injected styles for translated elements + loading animation
├── icons/               — Extension icons (16, 48, 128px PNG)
├── package.json         — Only dependency: jsdom (for local testing)
└── .env.local           — Local secrets (not committed)
```

## Architecture

### Message Flow Between Components

```
[Popup (popup.js)]
    │
    │ chrome.tabs.sendMessage
    ▼
[Content Script (content.js)]
    │
    │ chrome.runtime.sendMessage({action: 'translate', text, targetLang})
    ▼
[Service Worker (background.js)]
    │
    │ fetch() to translation API
    ▼
[Translation Provider (Google/OpenAI/Qwen)]
```

### Translation Flow (Detailed)
1. User clicks "Translate Article" in popup → `popup.js` sends `startTranslation` to active tab's content script
2. `content.js` calls `getArticleElements()` → filters through `shouldTranslate()` → deduplicates nested matches
3. Elements split into **cached** (instant display) and **uncached** (needs API call) groups
4. Uncached elements: text extracted from cloned elements (sr-only stripped), wrapped in `<span id="wat-N">text</span>`, accumulated into chunks up to `maxChunkSize`
5. All chunks sent **in parallel** via `Promise.all` to background.js
6. Background routes to provider, returns translated HTML string preserving `<span id="wat-N">` structure
7. Content script parses response HTML, matches `<span>` IDs to DOM placeholders (`[data-wat-id]`), updates text
8. Successfully translated text stored in `translationCache` Map for instant reuse on re-translate
9. Any unmatched placeholders (mangled IDs) get error text: "无法获取对应翻译"

### State Management
- **`isTranslating`** — mutex preventing concurrent translation runs
- **`translationCache`** — `Map<originalText, translatedText>`, survives re-translate within same page session
- **`lastResult`** — cached result object so popup can restore metrics on re-open
- **`translationsVisible`** — toggle state for show/hide functionality
- **Settings** — stored in `chrome.storage.local`, read on each translation and on popup open

### Popup Actions & Messages
| Popup Action | Message | Content Script Handler |
|---|---|---|
| "Translate Article" / "Redo Translation" | `startTranslation` | Runs full pipeline, returns result |
| "Hide Translation" / "Show Translation" | `toggleTranslation` | Toggles `.wat-translated-p` display |
| Popup opens | `getState` | Returns `{hasTranslations, isVisible, result}` |
| (unused currently) | `stopTranslation` | Removes all translated DOM elements, clears cache |

## Translation Providers (background.js)

All providers use `fetchWithTimeout(url, options, timeoutMs)` — a wrapper using `AbortController` to enforce request timeouts. Timeout errors surface as user-friendly messages suggesting chunk size reduction.

### Google Translate
- **Official** (`translateOfficial`): Google Cloud Translation V2 API, requires API key, format `html`, timeout 30s
- **Unofficial/Free** (`translateUnofficial`): POST to `translate.googleapis.com/translate_a/single?client=gtx`, no key needed, timeout 30s
- **Fallback chain**: Official fails → automatically falls back to Unofficial
- Response label: `'Official Google (NMT)'` or `'Free Google (Legacy)'` or `'Free Google (Legacy) [Fallback]'`

### OpenAI LLM (`translateLLM`)
- Any OpenAI-compatible endpoint (auto-appends `/chat/completions` to base URL)
- System prompt instructs HTML structure/ID preservation and no markdown wrapping
- Parameters: `max_tokens: 8000`, `temperature: 0.7`, `top_p: 0.8`, `presence_penalty: 1.5`
- Default model: `gpt-4o-mini`
- Timeout: 60s
- Post-processing: regex strips residual ` ```html ` / ` ``` ` fences
- Returns token usage (prompt + completion) for metrics display

### Qwen MT (`translateQwenMT`)
- Alibaba Cloud DashScope compatible endpoint (default: `https://dashscope.aliyuncs.com/compatible-mode/v1`)
- Uses `translation_options: { source_lang: "auto", target_lang: "Chinese" }` field in request body
- **NO system prompt allowed** — only `user` role message (sending `system` returns 400 `invalid_parameter_error`)
- Available models: `qwen-mt-flash` (default), `qwen-mt-plus` (quality), `qwen-mt-lite` (speed)
- Timeout: 60s
- **Safety filter fallback**: On `data_inspection_failed` (status 400), falls back to `translateUnofficialBatch()` which:
  1. Parses `<span id="wat-N">` structure from the HTML batch
  2. Translates each span individually via Google Unofficial
  3. Reassembles with `[Google翻译]` prefix on each span
  4. If no span structure found, translates as plain text
- Returns token usage for metrics display

## Content Detection (content.js)

### Element Selection Pipeline
1. **Query**: `document.querySelectorAll('P, DIV, BLOCKQUOTE, FIGCAPTION, LI, H1, H2, H3, H4, H5, H6')`
2. **`shouldTranslate()` filter** (per element):
   - Visibility: `getComputedStyle` checks `display:none` / `visibility:hidden` + zero-dimension check
   - Tag must be in TARGET_TAGS
   - Text length >= 15 chars AND >= 3 words (space-split)
   - Ancestor walk to `document.body`:
     - Reject if any ancestor is semantic nav element (`nav`, `header`, `footer`, `aside`)
     - Reject if ancestor ID contains any EXCLUDE_KEYWORD (substring match)
     - Reject if ancestor class token starts with any EXCLUDE_KEYWORD (after stripping Tailwind group modifiers `/` and bracket values `[...]`)
     - Reject if ancestor has `role="button"` or `role="menuitem"`
   - DIV-specific: must have a direct text node > 10 chars
3. **Deduplication**: Remove ancestors when a descendant is already in the candidate set (`el.contains(other)` check)

### EXCLUDE_KEYWORDS List
```
nav, header, footer, sidebar, rail, menu, ad-, banner, social,
comment, share, ticker, chiclet, popup, modal, sign-in, subscribe
```

### Tailwind & CSS-in-JS Class Token Handling
```javascript
// Skip CSS-in-JS / JSS tokens (PascalCase prefix like "Header-headerHeight", "Footer-root")
// These are component styling classes, not semantic section indicators
if (/^[A-Z]/.test(token)) return false;
// Lowercase the token, then strip Tailwind group modifiers (e.g., "group/header-bar" → "header-bar")
// and arbitrary values in brackets (e.g., "scroll-mt-[calc(var(--header-h))]" → "scroll-mt-")
const base = token.toLowerCase().split('/').pop().replace(/\[.*?\]/g, '');
// Keyword match requires exact match OR separator after keyword (-, _)
// CamelCase continuations do NOT match (e.g., "commentOnSelection" won't match "comment")
return EXCLUDE_KEYWORDS.some(kw => {
    if (!base.startsWith(kw)) return false;
    if (base.length === kw.length) return true;
    const next = base[kw.length];
    return next === '-' || next === '_';
});
```

### SR-Only Text Stripping
Before extracting text from elements, the content script:
1. Clones the element (`el.cloneNode(true)`)
2. Removes all children matching: `.sr-only`, `.visually-hidden`, `.screen-reader-text`, `[aria-hidden="true"]`
3. Reads `clone.innerText` as the clean source text

## DOM Insertion & Styling

### How Translations Appear
- Each translated element is a **clone** of the original element node (preserves tag, classes, attributes)
- Clone gets class `wat-translated-p` added, original `id` removed
- Inserted as `nextSibling` of the original element
- H1-H3 headings get `opacity: 0.8` to visually distinguish
- Original element gets `data-translated="true"` attribute

### CSS Classes (styles.css)
| Class | Purpose |
|---|---|
| `.wat-translated-p` | Base class for all translated elements; adds 0.5rem top margin |
| `.wat-loading` | Gray italic text with pulse animation (while waiting for API) |
| `.wat-error` | Red text for failed translations |

### Loading State
- Placeholder text: "正在翻译..." (translating...)
- Animated via `@keyframes wat-pulse` (opacity 0.5 → 0.8, 1.5s infinite)

## Settings & Configuration

### Storage Keys (`chrome.storage.local`)
| Key | Type | Default | Description |
|---|---|---|---|
| `provider` | `'google'\|'llm'\|'qwenmt'` | `'llm'` | Active translation provider |
| `googleModel` | `'legacy'\|'official'` | `'legacy'` | Google sub-mode |
| `googleApiKey` | string | `''` | Google Cloud API key |
| `googleChunkSize` | number | 3000 | Max chars per chunk (Google) |
| `llmEndpoint` | string | `'https://api.openai.com/v1'` | OpenAI-compatible base URL |
| `llmApiKey` | string | `''` | LLM API key |
| `llmModel` | string | `'gpt-4o-mini'` | LLM model name |
| `llmChunkSize` | number | 3000 | Max chars per chunk (LLM) |
| `qwenMtEndpoint` | string | `'https://dashscope.aliyuncs.com/compatible-mode/v1'` | Qwen MT base URL |
| `qwenMtApiKey` | string | `''` | Qwen MT API key |
| `qwenMtModel` | string | `'qwen-mt-flash'` | Qwen MT model |
| `qwenMtChunkSize` | number | 3000 | Max chars per chunk (Qwen) |
| `chunkSize` | number | 3000 | Legacy shared chunk size (fallback) |

### Chunk Size
- Configurable per provider (range 500-10000, clamped in popup.js on save)
- Determines how many `<span>` elements are batched into a single API request
- Larger chunks = fewer API calls but higher risk of timeout or token limits

## Metrics & Reporting

The popup displays after translation completes:
- **Model/API used** (e.g., "LLM (gpt-4o-mini)", "Qwen-MT (qwen-mt-flash)")
- **Character count** sent to API
- **Duration** (max across parallel chunks, in seconds)
- **Token usage** (prompt/completion, only for LLM and Qwen providers)
- **Cache stats** (cached count vs API count, when cache hits exist)

## Key Design Decisions & Gotchas

- **Span ID preservation is critical**: The `<span id="wat-N">` wrapper is how translations map back to DOM elements. If an API mangles or drops these IDs, translations show "无法获取对应翻译" (cannot retrieve translation).
- **Qwen MT does NOT support system role**: Sending `role: 'system'` returns 400 `invalid_parameter_error`. Any instructions must go in the user message or be handled via `translation_options`.
- **Tailwind/modern CSS/CSS-in-JS compatibility**: Class-based keyword exclusion uses token-level matching with multiple safeguards:
  - **PascalCase skip**: Tokens starting with uppercase (e.g., `Header-headerHeight`, `Footer-root`) are CSS-in-JS component classes and are skipped entirely. This prevents false positives from JSS-style naming used by sites like LessWrong (ForumMagnum).
  - **Separator-aware matching**: Keywords only match if followed by `-` or `_` (kebab/snake-case), not camelCase continuations. So `commentOnSelection` doesn't match `"comment"` but `comment-list` does.
  - **Tailwind group modifiers**: Stripped before matching (`group/header-bar` → `header-bar`).
  - This allows sites using CSS-in-JS (JSS, styled-components, CSS Modules) to work without false positives from generated class names like `Header-headerHeight`, `Navigation-sidebar`, `Footer-links`.
- **Client-side rendered pages** (Next.js, React): The old `offsetParent === null` check broke on hydrated pages. Current approach uses computed style + dimensions.
- **Chunk size** is configurable per provider (default 3000 chars, range 500-10000).
- **LLM markdown cleanup**: OpenAI sometimes wraps output in ```html blocks despite system prompt; regex cleanup handles this.
- **Parallel chunk execution**: All chunks fire simultaneously via `Promise.all`. Duration metric reports the max (slowest chunk), not sum.
- **Translation cache is per-page-session**: The `translationCache` Map lives in content script memory. Navigating away or refreshing clears it. "Redo Translation" reuses cached entries without API calls.
- **fetchWithTimeout**: All API calls use AbortController-based timeout (30s for Google, 60s for LLM/Qwen). AbortError surfaces a user-friendly message suggesting chunk size reduction.
- **Endpoint auto-completion**: Both LLM and Qwen MT endpoints auto-append `/chat/completions` if not already present, allowing users to paste just the base URL.
- **Google Unofficial uses POST**: To avoid URL length limits on large HTML batches, the unofficial Google endpoint uses POST with `application/x-www-form-urlencoded` body.
- **Element cloning for translation display**: Translated elements clone the original DOM node (not just `<p>`), preserving the site's own CSS classes and styling. This makes translations blend naturally with the article.
- **Toggle vs Stop**: The "Hide/Show Translation" button toggles visibility (`display: ''` / `display: 'none'`). The `stopTranslation` action fully removes DOM elements and clears cache (currently not exposed in UI).

## Development Notes

- No build step required — plain JS, load unpacked in `chrome://extensions`
- `jsdom` in package.json is for local testing only, not used by the extension at runtime
- `.env.local` stores local API keys (gitignored)
- Settings persist in `chrome.storage.local` across browser sessions
- Console logging: content script logs element count on translate; background logs errors

## Common Test Sites
- **OpenAI blog** (`openai.com/index/...`) — Next.js/React, Tailwind CSS, sr-only spans
- **Guardian / NYT** — Traditional article layout, regression baseline
- **LessWrong** (`lesswrong.com/posts/...`) — React SPA (ForumMagnum), `commentOnSelection` wrapper around post body, JSS class names
- Sites with heavy Tailwind utility classes (verify no false-positive exclusions)
- Pages with `<figcaption>` containing `<p>` (verify deduplication picks innermost)
