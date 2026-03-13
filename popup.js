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
        });
    }
});

// Settings Logic
const settingsToggle = document.getElementById('settingsToggle');
const settingsPanel = document.getElementById('settingsPanel');
const apiKeyInput = document.getElementById('apiKey');
const saveKeyBtn = document.getElementById('saveKeyBtn');
const saveStatus = document.getElementById('saveStatus');

// Load existing key
chrome.storage.local.get(['googleApiKey'], (result) => {
    if (result.googleApiKey) {
        apiKeyInput.value = result.googleApiKey;
    }
});

settingsToggle.addEventListener('click', () => {
    const isVisible = settingsPanel.style.display === 'block';
    settingsPanel.style.display = isVisible ? 'none' : 'block';
});

saveKeyBtn.addEventListener('click', () => {
    const key = apiKeyInput.value.trim();
    chrome.storage.local.set({ googleApiKey: key }, () => {
        saveStatus.style.display = 'block';
        setTimeout(() => {
            saveStatus.style.display = 'none';
        }, 2000);
    });
});
