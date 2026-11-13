chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ extInstalled: Date.now() });
});
