document.documentElement.dataset.extTest = 'ok';
chrome.storage?.local?.set?.({ extAlive: Date.now() });
