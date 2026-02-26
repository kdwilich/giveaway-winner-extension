// Background service worker for side panel
chrome.action.onClicked.addListener(async (tab) => {
  // Open the side panel when extension icon is clicked
  await chrome.sidePanel.open({ windowId: tab.windowId });
});

// Silently handle messages from content script that the sidepanel would normally
// receive. Without this, chrome.runtime.sendMessage from content.js produces
// "Receiving end does not exist" errors when the sidepanel isn't loaded.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'downloadCSV') {
    const dataUrl = 'data:text/csv;charset=utf-8,' + encodeURIComponent(request.csvContent);
    chrome.downloads.download({
      url: dataUrl,
      filename: request.filename,
      saveAs: true
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error('Background download error:', chrome.runtime.lastError);
        sendResponse({ error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ downloadId });
      }
    });
    return true; // async sendResponse
  }
  return false;
});

// Optional: Set up side panel to be available on Instagram and YouTube pages
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (!tab.url) return;
  
  // Enable side panel on Instagram post pages and YouTube video pages
  if (tab.url.includes('instagram.com/p/') || tab.url.includes('youtube.com/watch') || tab.url.includes('youtube.com/shorts/')) {
    await chrome.sidePanel.setOptions({
      tabId,
      path: 'sidepanel.html',
      enabled: true
    });
  }
});
