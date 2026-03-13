/**
 * Background script to handle translation requests.
 */

console.log("Background service worker started.");

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'translate') {
    handleTranslation(request.text, request.targetLang)
      .then(translatedText => sendResponse({ success: true, translatedText }))
      .catch(error => {
        console.error("Translation error:", error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // Keep the message channel open for async response
  }
});

/**
 * Orchestrates translation using either official or unofficial API.
 */
async function handleTranslation(text, targetLang) {
  const settings = await chrome.storage.local.get(['googleApiKey']);
  const apiKey = settings.googleApiKey;

  if (apiKey) {
    try {
      return await translateOfficial(text, targetLang, apiKey);
    } catch (e) {
      console.warn("Official API failed, falling back to unofficial:", e);
      return await translateUnofficial(text, targetLang);
    }
  } else {
    return await translateUnofficial(text, targetLang);
  }
}

/**
 * Calls the Official Google Cloud Translation API (V2).
 */
async function translateOfficial(text, targetLang, apiKey) {
  const tl = targetLang === 'zh' ? 'zh-CN' : targetLang;
  const url = `https://translation.googleapis.com/language/translate/v2?key=${apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      q: text,
      target: tl,
      format: 'html' // Changed from 'text' to 'html' to support batching tags
    })
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(`Official API Error: ${errorData.error ? errorData.error.message : response.statusText}`);
  }

  const data = await response.json();
  return data.data.translations[0].translatedText;
}

/**
 * Calls the unofficial Google Translate API.
 */
async function translateUnofficial(text, targetLang) {
  // targetLang 'zh' often needs to be 'zh-CN' for this API
  const tl = targetLang === 'zh' ? 'zh-CN' : targetLang;

  // client=webapp often yields better results than client=gtx in some regions
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=${tl}&dt=t&q=${encodeURIComponent(text)}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Unofficial API returned status ${response.status}`);
  }

  const data = await response.json();

  if (data && data[0]) {
    return data[0].map(part => part[0]).join("");
  }

  throw new Error("Invalid response format from Google Translate");
}
