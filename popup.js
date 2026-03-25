const statusDiv = document.getElementById('status');
const translateBtn = document.getElementById('translateBtn');
const stopBtn = document.getElementById('stopBtn');

translateBtn.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (tab) {
        statusDiv.style.display = 'block';
        statusDiv.style.color = '#28a745';
        statusDiv.innerText = 'Initializing translation...';
        translateBtn.disabled = true;

        const metricsDiv = document.getElementById('metrics');
        if (metricsDiv) metricsDiv.style.display = 'none'; // Ensure metrics are hidden on new translation start

        chrome.tabs.sendMessage(tab.id, { action: 'startTranslation' }, (response) => {
            translateBtn.disabled = false;
            if (chrome.runtime.lastError) {
                statusDiv.innerText = 'Error: Please refresh the page.';
                statusDiv.style.color = 'red';
            } else if (response && response.status === 'no_paragraphs_found') {
                statusDiv.innerText = 'No article content found.';
                statusDiv.style.color = '#666';
            } else if (response && response.status === 'completed') {
                statusDiv.innerText = `${response.count} paragraphs translated!`;
                statusDiv.style.color = '#28a745';
                
                // Display Metrics
                const metricsDiv = document.getElementById('metrics');
                metricsDiv.style.display = 'block';
                
                let metricsText = `Model: <strong>${response.apiUsed || 'Unknown'}</strong> • Cost: <strong>${response.charCount || 0}</strong> chars`;
                if (response.duration) {
                    metricsText += ` • Time: <strong>${(response.duration / 1000).toFixed(1)}s</strong>`;
                }
                if (response.tokens && (response.tokens.prompt > 0 || response.tokens.completion > 0)) {
                    metricsText += `<br>Tokens: <strong>${response.tokens.prompt}</strong> in / <strong>${response.tokens.completion}</strong> out`;
                }
                metricsDiv.innerHTML = metricsText;

                translateBtn.innerText = 'Redo Translation';
            } else if (response && response.status === 'already_running') {
                statusDiv.innerText = 'Already translating...';
            } else {
                statusDiv.innerText = `Translation started...`;
            }
        });
    }
});

stopBtn.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
        chrome.tabs.sendMessage(tab.id, { action: 'stopTranslation' }, () => {
            statusDiv.innerText = 'Translation turned off.';
            statusDiv.style.color = '#666';
            translateBtn.innerText = 'Translate Article';
            
            const metricsDiv = document.getElementById('metrics');
            if(metricsDiv) metricsDiv.style.display = 'none';
        });
    }
});

// Settings Logic
const settingsToggle = document.getElementById('settingsToggle');
const settingsPanel = document.getElementById('settingsPanel');
const providerSelect = document.getElementById('provider');
const googleSettings = document.getElementById('googleSettings');
const llmSettings = document.getElementById('llmSettings');
const qwenMtSettings = document.getElementById('qwenMtSettings'); // Added
const googleModelSelect = document.getElementById('googleModel'); // Added
const apiKeyInput = document.getElementById('apiKey');
const llmEndpointInput = document.getElementById('llmEndpoint');
const llmApiKeyInput = document.getElementById('llmApiKey');
const llmModelInput = document.getElementById('llmModel');
const qwenMtEndpointInput = document.getElementById('qwenMtEndpoint'); // Added
const qwenMtApiKeyInput = document.getElementById('qwenMtApiKey'); // Added
const qwenMtModelSelect = document.getElementById('qwenMtModel'); // Added
const googleChunkSizeInput = document.getElementById('googleChunkSize'); // Added
const llmChunkSizeInput = document.getElementById('llmChunkSize'); // Added
const qwenMtChunkSizeInput = document.getElementById('qwenMtChunkSize'); // Added
const saveKeyBtn = document.getElementById('saveKeyBtn');
const saveStatus = document.getElementById('saveStatus');

function updateProviderUI() {
    const provider = providerSelect.value;
    googleSettings.style.display = provider === 'google' ? 'block' : 'none';
    llmSettings.style.display = provider === 'llm' ? 'block' : 'none';
    qwenMtSettings.style.display = provider === 'qwenmt' ? 'block' : 'none';
}

providerSelect.addEventListener('change', updateProviderUI);

// Load existing settings
chrome.storage.local.get([
    'provider', 'googleApiKey', 'llmEndpoint', 'llmApiKey', 'llmModel', 
    'googleChunkSize', 'llmChunkSize', 'qwenMtChunkSize', 'chunkSize',
    'googleModel', 'qwenMtEndpoint', 'qwenMtApiKey', 'qwenMtModel'
], (result) => {
    providerSelect.value = result.provider || 'llm'; 
    googleModelSelect.value = result.googleModel || 'legacy';
    apiKeyInput.value = result.googleApiKey || '';
    llmEndpointInput.value = result.llmEndpoint || 'https://api.openai.com/v1';
    llmApiKeyInput.value = result.llmApiKey || '';
    llmModelInput.value = result.llmModel || 'gpt-4o-mini';
    
    // Qwen MT Defaults
    qwenMtEndpointInput.value = result.qwenMtEndpoint || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
    qwenMtApiKeyInput.value = result.qwenMtApiKey || '';
    qwenMtModelSelect.value = result.qwenMtModel || 'qwen-mt-flash';
    
    // Chunk Sizes (with fallback to old shared chunkSize)
    const oldSharedSize = result.chunkSize || 3000;
    googleChunkSizeInput.value = result.googleChunkSize || oldSharedSize;
    llmChunkSizeInput.value = result.llmChunkSize || oldSharedSize;
    qwenMtChunkSizeInput.value = result.qwenMtChunkSize || oldSharedSize;
    
    updateProviderUI();
});

settingsToggle.addEventListener('click', () => {
    const isVisible = settingsPanel.style.display === 'block';
    settingsPanel.style.display = isVisible ? 'none' : 'block';
});

saveKeyBtn.addEventListener('click', () => {
    const key = apiKeyInput.value.trim();
    
    const settings = {
        provider: providerSelect.value,
        googleModel: googleModelSelect.value,
        googleApiKey: key,
        googleChunkSize: Math.min(Math.max(parseInt(googleChunkSizeInput.value.trim()) || 3000, 500), 10000),
        llmEndpoint: llmEndpointInput.value.trim(),
        llmApiKey: llmApiKeyInput.value.trim(),
        llmModel: llmModelInput.value.trim(),
        llmChunkSize: Math.min(Math.max(parseInt(llmChunkSizeInput.value.trim()) || 3000, 500), 10000),
        qwenMtEndpoint: qwenMtEndpointInput.value.trim(),
        qwenMtApiKey: qwenMtApiKeyInput.value.trim(),
        qwenMtModel: qwenMtModelSelect.value,
        qwenMtChunkSize: Math.min(Math.max(parseInt(qwenMtChunkSizeInput.value.trim()) || 3000, 500), 10000)
    };
    
    chrome.storage.local.set(settings, () => {
        if (chrome.runtime.lastError) {
            saveStatus.style.display = 'block';
            saveStatus.innerText = 'Error saving settings!';
            saveStatus.style.color = 'red';
            console.error('Settings save failed:', chrome.runtime.lastError.message);
            return;
        }
        saveStatus.style.display = 'block';
        saveStatus.innerText = 'Settings saved!';
        saveStatus.style.color = '#28a745';
        setTimeout(() => {
            saveStatus.style.display = 'none';
        }, 2000);
    });
});
