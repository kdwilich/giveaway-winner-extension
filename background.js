// Background service worker for side panel
chrome.action.onClicked.addListener(async (tab) => {
  // Open the side panel when extension icon is clicked
  await chrome.sidePanel.open({ windowId: tab.windowId });
});

// Silently handle messages from content script that the sidepanel would normally
// receive. Without this, chrome.runtime.sendMessage from content.js produces
// "Receiving end does not exist" errors when the sidepanel isn't loaded.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // The sidepanel listener handles these when it's open.
  // This just prevents errors when it's not.
  return false;
});

// Optional: Set up side panel to be available only on Instagram post pages
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (!tab.url) return;
  
  // Enable side panel on Instagram post pages
  if (tab.url.includes('instagram.com/p/')) {
    await chrome.sidePanel.setOptions({
      tabId,
      path: 'sidepanel.html',
      enabled: true
    });
  }
});
