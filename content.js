// Minimal content script — only needed for tab discovery (ping).
// All comment fetching is driven by sidepanel.js via chrome.scripting.executeScript.

// Remove previous listener if script is re-injected
if (typeof window.__giveawayMessageListener !== 'undefined') {
  chrome.runtime.onMessage.removeListener(window.__giveawayMessageListener);
}

window.__giveawayMessageListener = (request, sender, sendResponse) => {
  if (request.action === 'ping') {
    sendResponse({ alive: true });
    return true;
  }
  return false;
};
chrome.runtime.onMessage.addListener(window.__giveawayMessageListener);

