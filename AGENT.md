# Web Article Translator Extension - Agent Knowledge Base

This document serves as a comprehensive reference guide to the "Web Article Translator" Chrome extension project. It outlines the project's architecture, features, supported translation providers, and implementation details based on our development history.

## Project Overview

The **Web Article Translator** is a Chrome extension (Manifest V3) that translates English web articles to Chinese with a side-by-side bilingual reading experience. It uses "Universal Content Detection" with "Context-Aware HTML Batching", displaying translated text directly below the original English text. Optimized for modern sites including Next.js/React SPAs and Tailwind CSS frameworks.

## Architecture & Key Files

*   **`manifest.json`**:
    *   MV3 manifest; content script injected at `document_idle` on all HTTPS pages.
    *   Defines extension permissions (`activeTab`, `storage`, `scripting`), background service worker, popup UI, and content scripts.
*   **`content.js`**:
    *   Injected into the target web page.
    *   Detects article elements via `getArticleElements()` → `shouldTranslate()` filter.
    *   Strips screen-reader-only content (`.sr-only`, `.visually-hidden`, `.screen-reader-text`, `[aria-hidden="true"]`) before extracting text.
    *   Batches text into `<span id="wat-N">` wrapped HTML chunks, sized per provider's chunk limit.
    *   Sends chunks in parallel to `background.js` via `chrome.runtime.sendMessage`.
    *   Parses returned HTML, maps `<span>` IDs back to DOM placeholders.
*   **`background.js`**:
    *   The core engine running as a service worker.
    *   Listens for translation requests (grouped chunks of text) from `content.js`.
    *   Routes requests to the user's selected provider:
        *   `translateOfficial` / `translateUnofficial`: Handles Official (POST, HTML-aware) vs. Unofficial (POST, form-encoded) Google API logic.
        *   `translateLLM`: Constructs OpenAI-compatible chat completion JSON payloads (`max_tokens: 8000`). Uses a system prompt instructing HTML structure preservation; default model: `gpt-4o-mini`.
        *   `translateQwenMT`: Constructs Qwen translation payloads (includes `translation_options` for source/target languages). **NO system prompt** — only `user`/`assistant` roles allowed; sending `role: 'system'` returns 400.
    *   Implements the Qwen safety fallback logic via `translateUnofficialBatch()`.
    *   All API calls use `fetchWithTimeout()` (30s for Google, 60s for LLM/Qwen) to prevent hanging requests.
*   **`popup.html` & `popup.js`**:
    *   The user interface accessible by clicking the extension icon.
    *   Handles user settings: selecting the active translation provider, entering API keys, setting base URLs, selecting specific models, and defining max chunk sizes.
    *   Settings are persisted using `chrome.storage.local` (chosen over `sync` to keep API keys on-device).
    *   Provides live status updates and metrics during translation (model used, char count, duration, token usage).
*   **`styles.css`**: Injected into all pages via the content script manifest entry. Defines styles for `.wat-translated-p`, `.wat-loading` (pulse animation), and `.wat-error` classes.

## Core Features

1.  **Multi-Provider Translation Support:**
    *   **Google Translate:** Supports both the Official Google Cloud Translation API (paid, requires API key) and a Legacy/Unofficial endpoint (free fallback).
    *   **OpenAI Models:** Supports any standard OpenAI-compatible `/v1/chat/completions` API endpoint. Optimized for models like `gpt-4o-mini` with zero reasoning overhead.
    *   **Qwen Machine Translation (MT):** Specialized support for Alibaba Cloud's DashScope Qwen MT models (`qwen-mt-plus`, `qwen-mt-flash`, `qwen-mt-lite`).

2.  **Intelligent Content Detection (`content.js`):**
    *   **Target tags**: P, DIV, BLOCKQUOTE, FIGCAPTION, LI, H1-H6.
    *   **Visibility check**: Uses `getComputedStyle` for `display:none`/`visibility:hidden` + zero-dimension check. Does NOT use `offsetParent` — that breaks `position:fixed` elements and React-hydrated pages.
    *   **Ancestor exclusion**: Semantic HTML tags (`nav`, `header`, `footer`, `aside`) and keyword matching on class tokens using token-level `startsWith()`, not substring `.includes()`. This prevents Tailwind false positives where utility classes contain keywords in non-semantic contexts (e.g., `scroll-mt-header-h`, `text-nav`, `h-header-h`).
    *   **Deduplication**: When nested elements both qualify (e.g., `<figcaption>` containing `<p>`), only the innermost element is kept to prevent duplicate translations.
    *   **SR-only stripping**: Clones elements and removes `.sr-only`, `.visually-hidden`, `.screen-reader-text`, `[aria-hidden="true"]` nodes before extracting `innerText`. This prevents accessibility annotations like "(opens in a new window)" from being sent to translation providers.
    *   **DIV filter**: DIVs require direct text nodes (>10 chars) to qualify, preventing container DIVs from being translated.

3.  **Context-Aware Batch Translation:**
    *   Groups multiple paragraphs into single HTML-structured API requests. This provides the translation engine (especially Neural Machine Translation or LLMs) with broader context, yielding far more accurate translations (e.g., correctly inferring that "Black Baldy" refers to a cattle breed within an agricultural article).

4.  **Parallel Chunking & Limits:**
    *   To prevent timeouts and "URI Too Long" errors on massive articles, the system splits content into manageable chunks.
    *   **Provider-Specific Limits:** Users can independently configure the "Max Chunk Size (chars)" for Google Translate, OpenAI Models, and Qwen MT in the settings (clamped to 500–10,000 chars, default 3000). This allows tuning for context windows versus latency.
    *   Chunks are processed asynchronously and in parallel by the background worker.

5.  **Safety Fallback Mechanism for Qwen MT:**
    *   Alibaba's Qwen models have strict political safety filters that return a `data_inspection_failed` (400 Bad Request) error when triggered.
    *   **The Fix:** If this error is detected, the `background.js` script gracefully catches it and uses `translateUnofficialBatch()` to translate each paragraph individually through the free Google Translate API, preserving the `<span>` ID mapping.
    *   A `[Google翻译]` prefix is added to each fallback-translated paragraph so the user can see which segments used the fallback.

## Translation Flow

1. User clicks "Translate" in popup → sends `startTranslation` message to content script
2. `content.js` finds translatable elements via `getArticleElements()` → `shouldTranslate()` filter
3. Text extracted from elements (with sr-only content stripped via clone), wrapped in `<span id="wat-N">` tags, chunked by size limit
4. Chunks sent in parallel to background.js via `chrome.runtime.sendMessage`
5. Background routes to configured provider, returns translated HTML
6. Content script parses response, maps `<span>` IDs back to DOM placeholders
7. Any unmapped placeholders show error text "无法获取对应翻译"

## Key Design Decisions & Gotchas

*   **Span ID preservation is critical**: The `<span id="wat-N">` wrapper is how translations map back to DOM elements. If an API mangles or drops these IDs, translations show "无法获取对应翻译" (cannot retrieve translation).
*   **Qwen MT does NOT support system role**: Sending `role: 'system'` returns 400 `invalid_parameter_error`. Any instructions must go in the user message or be handled client-side (e.g., sr-only stripping).
*   **Tailwind/modern CSS compatibility**: Class-based keyword exclusion must use token-level `startsWith()` matching, not substring `.includes()`. Tailwind utility classes embed words like "header", "nav", "footer" in non-semantic contexts (e.g., `scroll-mt-header-h`, `text-nav`). The matching also strips Tailwind group modifiers (`group/header-bar` → `header-bar`) and arbitrary values in brackets (`scroll-mt-[calc(var(--header-h))]` → `scroll-mt-`).
*   **Client-side rendered pages** (Next.js, React): The old `offsetParent === null` visibility check broke on hydrated pages and `position:fixed` elements. Current approach uses `getComputedStyle` + dimension checks.
*   **LLM markdown cleanup**: OpenAI sometimes wraps output in ```html blocks despite system prompt; regex cleanup handles this.
*   **Reasoning Models (OpenAI Compatibles):** When pointing the OpenAI provider to reasoning models (like `openai/gpt-5-nano` on AtlasCloud), the model spins up hundreds of "reasoning tokens" before translating, which can cause timeouts or empty responses if `max_tokens` is too low. Recommended: use `gpt-4o-mini` for instant 0-reasoning-token translations.

## Common Test Sites

*   **OpenAI blog** (`openai.com/index/...`) — Next.js/React, Tailwind CSS, sr-only spans, figcaptions
*   **Guardian / NYT** — Traditional article layout, regression baseline

## Developer Notes / Future Scope

*   To add a new translation provider:
    1.  Add the option & HTML settings inputs in `popup.html`.
    2.  Add load/save logic in `popup.js`.
    3.  Add the routing logic in `content.js` to fetch its specific chunk size.
    4.  Implement the API request function (e.g., `translateNewService`) in `background.js` and add it to the `handleTranslation` orchestrator.
