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
    const elements = [];
    const all = document.querySelectorAll(TARGET_TAGS.join(', '));
    all.forEach(el => {
        if (shouldTranslate(el)) {
            elements.push(el);
        }
    });
    return elements;
}

function stopTranslation() {
    document.querySelectorAll('.wat-translated-p').forEach(el => el.remove());
    document.querySelectorAll('[data-translated="true"]').forEach(el => delete el.dataset.translated);
    isTranslating = false;
}

async function startTranslation() {
    if (isTranslating) return { status: 'already_running' };
    stopTranslation();

    const elements = getArticleElements();
    if (elements.length === 0) return { status: 'no_paragraphs_found' };

    isTranslating = true;
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

    // 1. Prepare elements and UI placeholders
    const translationMap = new Map();
    const chunks = [];
    let currentChunk = "";

    elements.forEach((el, index) => {
        const id = `wat-${index}`;
        translationMap.set(id, el);

        const translatedEl = el.cloneNode(false);
        translatedEl.classList.add('wat-translated-p', 'wat-loading');
        translatedEl.innerText = '正在翻译...';
        translatedEl.removeAttribute('id');
        translatedEl.dataset.watId = id; // Map back to this element

        if (['H1', 'H2', 'H3'].includes(el.tagName)) {
            translatedEl.style.opacity = '0.8';
        }

        if (el.parentNode) {
            el.parentNode.insertBefore(translatedEl, el.nextSibling);
            el.dataset.translated = 'true';
        }

        // Add to batch string wrapped in spans to preserve context
        const spanHtml = `<span id="${id}">${el.innerText}</span> `;
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

    // 2. Perform Batch Translations All At Once
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
                
                // 3. Map translations back to placeholders
                tempDiv.querySelectorAll('span').forEach(span => {
                    const id = span.id;
                    const translatedEl = document.querySelector(`.wat-translated-p[data-wat-id="${id}"]`);
                    let translatedHtml = span.innerText.trim();
                    if (translatedHtml) {
                        if (translatedEl) {
                            translatedEl.innerText = translatedHtml;
                            translatedEl.classList.remove('wat-loading');
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
    } finally {
        isTranslating = false;
    }

    return { 
        status: 'completed', 
        count: elements.length, 
        apiUsed: [...totalApiUsed].join(' + ') || 'Unknown',
        charCount: totalCharCount,
        duration: maxDuration,
        tokens: {
            prompt: totalPromptTokens,
            completion: totalCompletionTokens
        }
    };
}

init();
