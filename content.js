/**
 * Content script for Web Article Translator.
 * Implements "Universal Content Detection" with "Context-Aware HTML Batching".
 */

const TARGET_TAGS = ['P', 'DIV', 'BLOCKQUOTE', 'FIGCAPTION', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'];
const EXCLUDE_KEYWORDS = [
    'nav', 'header', 'footer', 'sidebar', 'rail', 'menu', 'ad-', 'banner', 'social',
    'comment', 'share', 'ticker', 'chiclet', 'popup', 'modal', 'sign-in', 'subscribe'
];

let isTranslating = false;
let translationCache = new Map(); // originalText → translatedText
let lastResult = null;            // last translation result for popup restore
let translationsVisible = true;   // visibility state of translated elements

function init() {
    console.log("Web Article Translator: Context-Aware Batching active.");
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'startTranslation') {
            startTranslation()
                .then(result => sendResponse(result))
                .catch(err => sendResponse({ status: 'error', message: err.message }));
            return true;
        }
        if (request.action === 'stopTranslation') {
            stopTranslation();
            sendResponse({ status: 'stopped' });
        }
        if (request.action === 'getState') {
            const hasTranslations = document.querySelectorAll('.wat-translated-p').length > 0;
            sendResponse({
                hasTranslations,
                isVisible: translationsVisible,
                result: lastResult
            });
        }
        if (request.action === 'toggleTranslation') {
            translationsVisible = !translationsVisible;
            document.querySelectorAll('.wat-translated-p').forEach(el => {
                el.style.display = translationsVisible ? '' : 'none';
            });
            sendResponse({ isVisible: translationsVisible });
        }
    });
}

function shouldTranslate(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (el.offsetHeight === 0 && el.offsetWidth === 0) return false;
    if (!TARGET_TAGS.includes(el.tagName)) return false;

    const text = el.innerText ? el.innerText.trim() : "";
    if (text.length < 15) return false;
    if (text.split(' ').length < 3) return false;

    let current = el;
    while (current && current !== document.body) {
        const classStr = (current.className || "").toString().toLowerCase();
        const idStr = (current.id || "").toString().toLowerCase();
        const tagName = current.tagName.toLowerCase();

        if (['nav', 'header', 'footer', 'aside'].includes(tagName)) return false;
        if (EXCLUDE_KEYWORDS.some(kw => idStr.includes(kw))) return false;
        const classTokens = classStr.split(/\s+/);
        if (classTokens.some(token => {
            // Strip Tailwind group modifiers (e.g., "group/header-bar" → "header-bar")
            // and arbitrary values in brackets (e.g., "scroll-mt-[calc(var(--header-h))]" → "scroll-mt-")
            const base = token.split('/').pop().replace(/\[.*?\]/g, '');
            return EXCLUDE_KEYWORDS.some(kw => base.startsWith(kw));
        })) return false;
        if (current.getAttribute('role') === 'button' || current.getAttribute('role') === 'menuitem') return false;

        current = current.parentElement;
    }

    let hasDirectText = false;
    for (let node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE && node.textContent.trim().length > 10) {
            hasDirectText = true;
            break;
        }
    }
    if (el.tagName === 'DIV' && !hasDirectText) return false;

    return true;
}

function getArticleElements() {
    const candidates = [];
    const all = document.querySelectorAll(TARGET_TAGS.join(', '));
    all.forEach(el => {
        if (shouldTranslate(el)) {
            candidates.push(el);
        }
    });

    // Remove ancestors when a more specific descendant is already in the list.
    // This prevents e.g. a <figcaption> and its inner <p> both being translated.
    const candidateSet = new Set(candidates);
    const elements = candidates.filter(el => {
        for (const other of candidateSet) {
            if (other !== el && el.contains(other)) return false;
        }
        return true;
    });

    return elements;
}

function stopTranslation() {
    document.querySelectorAll('.wat-translated-p').forEach(el => el.remove());
    document.querySelectorAll('[data-translated="true"]').forEach(el => delete el.dataset.translated);
    isTranslating = false;
    translationCache.clear();
    lastResult = null;
    translationsVisible = true;
}

async function startTranslation() {
    if (isTranslating) return { status: 'already_running' };

    // Remove existing translation DOM elements but keep the cache
    document.querySelectorAll('.wat-translated-p').forEach(el => el.remove());
    document.querySelectorAll('[data-translated="true"]').forEach(el => delete el.dataset.translated);

    const elements = getArticleElements();
    if (elements.length === 0) return { status: 'no_paragraphs_found' };

    isTranslating = true;
    translationsVisible = true;
    console.log(`Translating ${elements.length} elements using context-aware batching...`);

    const settings = await chrome.storage.local.get(['provider', 'googleChunkSize', 'llmChunkSize', 'qwenMtChunkSize', 'chunkSize']);
    const provider = settings.provider || 'llm';

    let maxChunkSize = 3000;
    if (provider === 'google') {
        maxChunkSize = parseInt(settings.googleChunkSize) || parseInt(settings.chunkSize) || 3000;
    } else if (provider === 'llm') {
        maxChunkSize = parseInt(settings.llmChunkSize) || parseInt(settings.chunkSize) || 3000;
    } else if (provider === 'qwenmt') {
        maxChunkSize = parseInt(settings.qwenMtChunkSize) || parseInt(settings.chunkSize) || 3000;
    }

    // 1. Prepare elements — split into cached and uncached
    const translationMap = new Map();
    const cachedElements = [];   // elements with cached translations
    const uncachedElements = []; // elements needing API translation
    const chunks = [];
    let currentChunk = "";
    let uncachedIndex = 0;

    elements.forEach((el) => {
        // Clone and strip screen-reader-only / accessibility-hidden text
        const clone = el.cloneNode(true);
        clone.querySelectorAll('.sr-only, .visually-hidden, .screen-reader-text, [aria-hidden="true"]').forEach(n => n.remove());
        const cleanText = clone.innerText;

        if (translationCache.has(cleanText)) {
            cachedElements.push({ el, cleanText });
        } else {
            uncachedElements.push({ el, cleanText, id: `wat-${uncachedIndex}` });
            uncachedIndex++;
        }
    });

    // 2. Insert cached translations immediately (no API call)
    let cachedCount = 0;
    cachedElements.forEach(({ el, cleanText }) => {
        const translatedEl = el.cloneNode(false);
        translatedEl.classList.add('wat-translated-p');
        translatedEl.innerText = translationCache.get(cleanText);
        translatedEl.removeAttribute('id');

        if (['H1', 'H2', 'H3'].includes(el.tagName)) {
            translatedEl.style.opacity = '0.8';
        }

        if (el.parentNode) {
            el.parentNode.insertBefore(translatedEl, el.nextSibling);
            el.dataset.translated = 'true';
            cachedCount++;
        }
    });

    // 3. Prepare uncached elements for API translation
    uncachedElements.forEach(({ el, cleanText, id }) => {
        translationMap.set(id, { el, cleanText });

        const translatedEl = el.cloneNode(false);
        translatedEl.classList.add('wat-translated-p', 'wat-loading');
        translatedEl.innerText = '正在翻译...';
        translatedEl.removeAttribute('id');
        translatedEl.dataset.watId = id;

        if (['H1', 'H2', 'H3'].includes(el.tagName)) {
            translatedEl.style.opacity = '0.8';
        }

        if (el.parentNode) {
            el.parentNode.insertBefore(translatedEl, el.nextSibling);
            el.dataset.translated = 'true';
        }

        const spanHtml = `<span id="${id}">${cleanText}</span> `;
        if (currentChunk.length + spanHtml.length > maxChunkSize && currentChunk.length > 0) {
            chunks.push(currentChunk);
            currentChunk = spanHtml;
        } else {
            currentChunk += spanHtml;
        }
    });

    if (currentChunk.length > 0) {
        chunks.push(currentChunk);
    }

    let totalApiUsed = new Set();
    let totalCharCount = 0;
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let maxDuration = 0;

    // 4. Perform Batch Translations for uncached elements
    if (chunks.length > 0) {
        try {
            const promises = chunks.map(batchHtml => {
                return new Promise((resolve) => {
                    chrome.runtime.sendMessage(
                        { action: 'translate', text: batchHtml, targetLang: 'zh' },
                        (res) => resolve(res)
                    );
                });
            });
            const results = await Promise.all(promises);

            results.forEach(result => {
                if (result && result.success) {
                    totalCharCount += result.charCount || 0;
                    totalPromptTokens += (result.tokens && result.tokens.prompt) || 0;
                    totalCompletionTokens += (result.tokens && result.tokens.completion) || 0;
                    maxDuration = Math.max(maxDuration, result.duration || 0);
                    totalApiUsed.add(result.apiUsed);

                    const tempDiv = document.createElement('div');
                    tempDiv.innerHTML = result.translatedText;

                    // 5. Map translations back to placeholders and cache them
                    tempDiv.querySelectorAll('span').forEach(span => {
                        const id = span.id;
                        const translatedEl = document.querySelector(`.wat-translated-p[data-wat-id="${id}"]`);
                        let translatedHtml = span.innerText.trim();
                        if (translatedHtml) {
                            if (translatedEl) {
                                translatedEl.innerText = translatedHtml;
                                translatedEl.classList.remove('wat-loading');
                            }
                            // Store in cache
                            const entry = translationMap.get(id);
                            if (entry) {
                                translationCache.set(entry.cleanText, translatedHtml);
                            }
                        }
                    });
                }
            });

            // Clean up any remaining loaders if span IDs were mangled
            document.querySelectorAll('.wat-loading').forEach(el => {
                el.innerText = '无法获取对应翻译';
                el.classList.remove('wat-loading');
                el.classList.add('wat-error');
            });

        } catch (err) {
            console.error("Batch translation failed:", err);
        }
    }

    isTranslating = false;

    const result = {
        status: 'completed',
        count: elements.length,
        cachedCount,
        apiCount: uncachedElements.length,
        apiUsed: [...totalApiUsed].join(' + ') || (cachedCount > 0 ? 'Cache' : 'Unknown'),
        charCount: totalCharCount,
        duration: maxDuration,
        tokens: {
            prompt: totalPromptTokens,
            completion: totalCompletionTokens
        }
    };

    lastResult = result;
    return result;
}

init();
