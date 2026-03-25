# Web Article Translator Extension - Agent Knowledge Base

This document serves as a comprehensive reference guide to the "Web Article Translator" Chrome extension project. It outlines the project's architecture, features, supported translation providers, and implementation details based on our development history.

## Project Overview

The **Web Article Translator** is a Chrome extension designed to translate web articles (specifically optimized for news sites like The Guardian, The New York Times, WSJ, and Barron's) paragraph by paragraph. It injects a side-by-side bilingual reading experience, displaying the translated text directly below the original English text.

## Core Features

1.  **Multi-Provider Translation Support:**
    *   **Google Translate:** Supports both the Official Google Cloud Translation API (paid, requires API key) and a Legacy/Unofficial endpoint (free fallback).
    *   **OpenAI Models:** Supports any standard OpenAI-compatible `/v1/chat/completions` API endpoint. Optimized for models like `gpt-4o-mini` with zero reasoning overhead.
    *   **Qwen Machine Translation (MT):** Specialized support for Alibaba Cloud's DashScope Qwen MT models (`qwen-mt-plus`, `qwen-mt-flash`, `qwen-mt-lite`).

2.  **Intelligent Content Extraction (`content.js`):**
    *   Uses a robust, heuristic-based `TARGET_TAGS` list and `shouldTranslate()` filter to correctly identify main article paragraphs, headlines, subheadings, and captions while ignoring noise like footers, navigation menus, and ads.
    *   Injects translated elements (cloned from the original tag) directly below the original text, styled with the `wat-translated-p` class.

3.  **Context-Aware Batch Translation:**
    *   Groups multiple paragraphs into single HTML-structured API requests. This provides the translation engine (especially Neural Machine Translation or LLMs) with broader context, yielding far more accurate translations (e.g., correctly inferring that "Black Baldy" refers to a cattle breed within an agricultural article).

4.  **Parallel Chunking & Limits:**
    *   To prevent timeouts and "URI Too Long" errors on massive articles, the system splits content into manageable chunks.
    *   **Provider-Specific Limits:** Users can independently configure the "Max Chunk Size (chars)" for Google Translate, OpenAI Models, and Qwen MT in the settings (clamped to 500–10,000 chars). This allows tuning for context windows versus latency.
    *   Chunks are processed asynchronously and in parallel by the background worker.

5.  **Safety Fallback Mechanism for Qwen MT:**
    *   Alibaba's Qwen models have strict political safety filters that return a `data_inspection_failed` (400 Bad Request) error when triggered.
    *   **The Fix:** If this error is detected, the `background.js` script gracefully catches it and uses `translateUnofficialBatch()` to translate each paragraph individually through the free Google Translate API, preserving the `<span>` ID mapping.
    *   A `[Google翻译]` prefix is added to each fallback-translated paragraph so the user can see which segments used the fallback.

## Architecture & Key Files

*   **`manifest.json`**:
    *   Defines extension permissions (`activeTab`, `storage`, `scripting`), background service worker, popup UI, and content scripts.
*   **`popup.html` & `popup.js`**:
    *   The user interface accessible by clicking the extension icon.
    *   Handles user settings: selecting the active translation provider, entering API keys, setting base URLs, selecting specific models, and defining max chunk sizes.
    *   Settings are persisted using `chrome.storage.local` (chosen over `sync` to keep API keys on-device).
    *   Provides live status updates during the translation process (e.g., "Translating 15 paragraphs").
*   **`background.js`**:
    *   The core engine running invisibly in the background.
    *   Listens for translation requests (grouped chunks of text) from `content.js`.
    *   Routes requests to the user's selected provider:
        *   `translateOfficial` / `translateUnofficial`: Handles Official (POST, HTML-aware) vs. Unofficial (POST, form-encoded) Google API logic.
        *   `translateLLM`: Constructs OpenAI-compatible chat completion JSON payloads (`max_tokens: 8000`).
        *   `translateQwenMT`: Constructs Qwen translation payloads (includes `translation_options` for source/target languages and flat parameters to disable reasoning).
    *   Implements the Qwen safety fallback logic via `translateUnofficialBatch()`.
    *   All API calls use `fetchWithTimeout()` (30s for Google, 60s for LLM/Qwen) to prevent hanging requests.
*   **`content.js`**:
    *   Injected into the target web page.
    *   Scans the DOM based on predefined selectors.
    *   Batches text nodes according to the user's active provider's chunk size limit.
    *   Uses `chrome.runtime.sendMessage` to send chunks to `background.js`.
    *   Parses the returned HTML strings and dynamically mounts the translated elements into the DOM.
*   **`styles.css`**: Injected into all pages via the content script manifest entry. Defines styles for `.wat-translated-p`, `.wat-loading` (pulse animation), and `.wat-error` classes.
*   **`.env.local`**: Config file (ignored by Git) used locally for testing scripts with our personal API keys for DashScope and AtlasCloud.

## Known API Quirks & Optimizations

*   **Reasoning Models (OpenAI Compatibles):** When pointing the OpenAI provider to reasoning models (like `openai/gpt-5-nano` on AtlasCloud), the model spins up hundreds of "reasoning tokens" before translating, which can cause timeouts or empty responses if `max_tokens` is too low.
    *   *Solution implemented:* Recommended using `gpt-4o-mini` for instant 0-reasoning-token translations. Removed Qwen-specific parameters (`enable_thinking`, `top_k`) from the LLM logic to prevent 400 Bad Request errors on strict OpenAI endpoints.
*   **Qwen "Thinking Mode":** Qwen APIs often enable reasoning by default. We explicitly disabled this in the integration to ensure rapid, cost-effective translation.

## Developer Notes / Future Scope
*   To add a new translation provider:
    1.  Add the option & HTML settings inputs in `popup.html`.
    2.  Add load/save logic in `popup.js`.
    3.  Add the routing logic in `content.js` to fetch its specific chunk size.
    4.  Implement the API request function (e.g., `translateNewService`) in `background.js` and add it to the `handleTranslation` orchestrator.
