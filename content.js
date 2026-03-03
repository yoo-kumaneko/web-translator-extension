/**
 * Content script for Web Article Translator.
 * Implements "Universal Content Detection" to translate everything while filtering noise.
 */

// Broad list of tags that might contain article content
const TARGET_TAGS = ['P', 'DIV', 'BLOCKQUOTE', 'FIGCAPTION', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'];

// Keywords in classes/IDs that indicate non-article noise
const EXCLUDE_KEYWORDS = [
    'nav', 'header', 'footer', 'sidebar', 'rail', 'menu', 'ad-', 'banner', 'social',
    'comment', 'share', 'ticker', 'chiclet', 'popup', 'modal', 'sign-in', 'subscribe',
    'pencraft' // Substack specific noise
];

let isTranslating = false;

function init() {
    console.log("Web Article Translator: Universal Content Detection active.");
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

/**
 * Heuristic to determine if an element is a valid piece of content to translate.
 */
function shouldTranslate(el) {
    // 1. Basic checks
    if (!el || el.offsetParent === null) return false; // Hidden

    // 2. Tag check
    if (!TARGET_TAGS.includes(el.tagName)) return false;

    // 3. Text content check
    const text = el.innerText ? el.innerText.trim() : "";
    if (text.length < 15) return false; // Ignore short fragments, labels, etc.
    if (text.split(' ').length < 3) return false; // Likely not a sentence

    // 4. Ancestor Noise Check (Check parents for exclusion keywords)
    let current = el;
    while (current && current !== document.body) {
        const classStr = (current.className || "").toString().toLowerCase();
        const idStr = (current.id || "").toString().toLowerCase();
        const tagName = current.tagName.toLowerCase();

        // Check tags
        if (['nav', 'header', 'footer', 'aside'].includes(tagName)) return false;

        // Check classes/IDs for keywords
        if (EXCLUDE_KEYWORDS.some(kw => classStr.includes(kw) || idStr.includes(kw))) {
            // Special Case: MarketWatch ticker ribbon is very specific
            if (classStr.includes('chiclet') || classStr.includes('ticker')) return false;
            return false;
        }

        // Skip elements that look like buttons or menu items
        if (current.getAttribute('role') === 'button' || current.getAttribute('role') === 'menuitem') return false;

        current = current.parentElement;
    }

    // 5. Avoid translating elements that already contain other blocks we want to translate
    // (Wait: our cloneNode(false) approach handles this, but we should prioritize lower-level elements)
    // If it has children that are also in our list, we might be double-translating.
    // However, MarketWatch uses nested DIVs where the parent has the text but also children.
    // A better check: does this element have direct text nodes?
    let hasDirectText = false;
    for (let node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE && node.textContent.trim().length > 10) {
            hasDirectText = true;
            break;
        }
    }

    // If it's a DIV without direct text nodes, it's just a container. Skip it.
    if (el.tagName === 'DIV' && !hasDirectText) return false;

    return true;
}

/**
 * Finds all elements to translate using a universal heuristic approach.
 */
function getArticleElements() {
    const elements = new Set();
    const all = document.querySelectorAll(TARGET_TAGS.join(', '));

    all.forEach(el => {
        if (shouldTranslate(el)) {
            elements.add(el);
        }
    });

    return Array.from(elements);
}

function stopTranslation() {
    const translations = document.querySelectorAll('.wat-translated-p');
    translations.forEach(el => el.remove());

    const originals = document.querySelectorAll('[data-translated="true"]');
    originals.forEach(el => delete el.dataset.translated);

    isTranslating = false;
    console.log("Translations removed.");
}

async function startTranslation() {
    if (isTranslating) {
        return { status: 'already_running' };
    }

    // Clear existing
    stopTranslation();

    const elements = getArticleElements();
    if (elements.length === 0) {
        console.warn("No translatable content found with universal heuristics.");
        return { status: 'no_paragraphs_found' };
    }

    isTranslating = true;
    const translationPromises = [];

    console.log(`Starting universal translation for ${elements.length} elements.`);

    for (const el of elements) {
        const originalText = el.innerText.trim();

        // Clone original to inherit styles exactly
        const translatedEl = el.cloneNode(false);
        translatedEl.classList.add('wat-translated-p', 'wat-loading');
        translatedEl.innerText = '正在翻译...';
        translatedEl.removeAttribute('id');

        // Ensure some visual distinction if it's a headline
        if (['H1', 'H2', 'H3'].includes(el.tagName)) {
            translatedEl.style.opacity = '0.8';
        }

        if (el.parentNode) {
            el.parentNode.insertBefore(translatedEl, el.nextSibling);
            el.dataset.translated = 'true';
        }

        const pPromise = new Promise((resolve) => {
            chrome.runtime.sendMessage(
                { action: 'translate', text: originalText, targetLang: 'zh' },
                (response) => {
                    translatedEl.classList.remove('wat-loading');
                    if (response && response.success) {
                        translatedEl.innerText = response.translatedText;
                    } else {
                        translatedEl.innerText = '翻译失败';
                        translatedEl.classList.add('wat-error');
                    }
                    resolve();
                }
            );
        });
        translationPromises.push(pPromise);
    }

    Promise.all(translationPromises).finally(() => {
        isTranslating = false;
        console.log("Translation process finished.");
    });

    return { status: 'started', count: elements.length };
}

init();
