/**
 * Background script to handle translation requests.
 */

console.log("Background service worker started.");

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'translate') {
    handleTranslation(request.text, request.targetLang)
      .then(result => sendResponse({ success: true, ...result }))
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
  const settings = await chrome.storage.local.get(['provider', 'googleApiKey', 'googleModel', 'llmEndpoint', 'llmApiKey', 'llmModel', 'maxTokens', 'qwenMtEndpoint', 'qwenMtApiKey', 'qwenMtModel']);
  const charCount = text.length;

  if (settings.provider === 'llm') {
    return await translateLLM(text, targetLang, settings);
  } else if (settings.provider === 'qwenmt') {
    return await translateQwenMT(text, targetLang, settings);
  } else {
    const isOfficial = settings.googleModel === 'official';
    const apiKey = settings.googleApiKey;

    if (isOfficial && apiKey) {
      try {
        const translatedText = await translateOfficial(text, targetLang, apiKey);
        return { translatedText, apiUsed: 'Official Google (NMT)', charCount };
      } catch (e) {
        console.warn("Official API failed, falling back to unofficial:", e);
        const translatedText = await translateUnofficial(text, targetLang);
        return { translatedText, apiUsed: 'Free Google (Legacy) [Fallback]', charCount };
      }
    } else {
      const translatedText = await translateUnofficial(text, targetLang);
      return { translatedText, apiUsed: 'Free Google (Legacy)', charCount };
    }
  }
}

/**
 * Calls Alibaba Cloud Qwen-MT specialized translation model
 */
async function translateQwenMT(text, targetLang, settings) {
  let endpoint = settings.qwenMtEndpoint || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  if (!endpoint.endsWith('/chat/completions')) {
      endpoint = endpoint.replace(/\/$/, '') + '/chat/completions';
  }

  const apiKey = settings.qwenMtApiKey;
  const model = settings.qwenMtModel || 'qwen-mt-flash';
  const charCount = text.length;

  if (!apiKey) {
    throw new Error("API Key is missing for Qwen-MT.");
  }

  const targetLangName = targetLang === 'zh' ? 'Chinese' : 'English';

  const startTime = performance.now();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model,
      messages: [
        { role: 'user', content: text }
      ],
      translation_options: {
        source_lang: "auto",
        target_lang: targetLangName
      }
    })
  });

  const duration = performance.now() - startTime;

  if (!response.ok) {
    const errorText = await response.text();
    let errorData;
    try {
        errorData = JSON.parse(errorText);
    } catch (e) {}

    // Graceful handling of inappropriate content refusal
    if (response.status === 400 && errorData && errorData.error && errorData.error.code === 'data_inspection_failed') {
        console.warn("Qwen-MT refused to translate due to safety filters. Falling back to Google (Free).");
        try {
            const translatedText = await translateUnofficial(text, targetLang);
            return {
                translatedText: `[fallback] ${translatedText}`,
                apiUsed: `Qwen-MT (Safety Fallback to Free Google)`,
                charCount,
                duration,
                warning: "Content was blocked by Qwen safety filters; using Google fallback."
            };
        } catch (fallbackError) {
            throw new Error(`Qwen-MT safety refusal and Google fallback failed: ${fallbackError.message}`);
        }
    }

    throw new Error(`Qwen-MT API Error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  const translatedText = data.choices[0].message.content.trim();
  const usage = data.usage || {};

  return {
    translatedText,
    apiUsed: `Qwen-MT (${model})`,
    charCount,
    duration,
    tokens: {
      prompt: usage.prompt_tokens || 0,
      completion: usage.completion_tokens || 0
    }
  };
}

/**
 * Calls an OpenAI-compatible LLM endpoint
 */
async function translateLLM(text, targetLang, settings) {
  let endpoint = settings.llmEndpoint || 'https://api.openai.com/v1';
  
  // Automatically append /chat/completions if only base URL is provided
  if (!endpoint.endsWith('/chat/completions')) {
      endpoint = endpoint.replace(/\/$/, '') + '/chat/completions';
  }

  const apiKey = settings.llmApiKey;
  const model = settings.llmModel || 'gpt-4o-mini';
  const charCount = text.length;

  if (!apiKey) {
    throw new Error("API Key is missing for the LLM translation model.");
  }

  const langName = targetLang === 'zh' ? 'Simplified Chinese' : targetLang;

  const systemPrompt = `You are a professional web page translator. Translate the following HTML content into ${langName}. 
You MUST strictly preserve the exact HTML structure, all tags (like <span>), IDs, and attributes. 
Only translate the human-readable textual content within the tags. 
Return ONLY the translated HTML content. Do NOT wrap your response in markdown code blocks like \`\`\`html. Do not add any conversational text.`;

  const startTime = performance.now();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text }
      ],
      // Standard OpenAI params
      max_tokens: settings.maxTokens || 4096, 
      temperature: 0.7,
      top_p: 0.8,
      presence_penalty: 1.5
    })
  });

  const duration = performance.now() - startTime;

  if (!response.ok) {
    const errorText = await response.text();
    console.error("LLM API Failed. Status:", response.status, "Raw Response:", errorText);
    
    let errorData = {};
    try {
        errorData = JSON.parse(errorText);
    } catch(e) {}
    
    const errorMessage = (errorData && errorData.error && errorData.error.message) 
                          || (errorData && errorData.msg) 
                          || (errorData && errorData.message)
                          || errorText
                          || response.statusText 
                          || response.status;
    throw new Error(`LLM API Error: ${errorMessage}`);
  }

  const data = await response.json();
  let translatedText = data.choices[0].message.content.trim();
  
  // Clean up any residual markdown blocks the LLM might have still added
  if (translatedText.startsWith("```html")) {
      translatedText = translatedText.substring(7);
  } else if (translatedText.startsWith("```")) {
      translatedText = translatedText.substring(3);
  }
  if (translatedText.endsWith("```")) {
      translatedText = translatedText.substring(0, translatedText.length - 3);
  }

  const usage = data.usage || {};
  
  return { 
    translatedText: translatedText.trim(), 
    apiUsed: `LLM (${model})`, 
    charCount,
    duration,
    tokens: {
      prompt: usage.prompt_tokens || 0,
      completion: usage.completion_tokens || 0
    }
  };
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
