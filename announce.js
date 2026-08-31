// Runs on luckypick.win only.
//
// A page cannot discover an extension's ID on its own, and chrome.runtime.connect()
// requires it up front — so an unpacked build (random ID) or a deploy without
// NEXT_PUBLIC_EXTENSION_ID set would leave the app unable to see a perfectly working
// extension. This stamps the ID on the document at document_start, before the app's
// React tree mounts, so the page can just read it.

document.documentElement.dataset.collectorExtensionId = chrome.runtime.id;
