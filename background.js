// The engine.
//
// Everything that used to live in the side panel lives here now: the collection loop,
// pacing, retries, checkpointing, and the run's lifecycle. The extension has no UI of
// its own — luckypick.win renders the run, the in-page pill mirrors it, and the badge
// carries it when neither is in view.
//
// MV3 tears this worker down after ~30s idle and caps any single event at 5 minutes,
// so nothing durable is kept in module scope. Three layers keep a long run alive:
// open ports reset the idle timer, every batch checkpoints to chrome.storage, and a
// watchdog alarm resurrects the loop from the last cursor when it dies anyway.

import {
  getRun, patchRun, clearRun, newRun, getComments, saveComments,
  mergeComments, shouldFlush, getSettings, setSettings, addHistory, getHistory
} from './lib/store.js';
import { Pacer, AbortError, FatalError } from './lib/pace.js';
import { collectInstagram } from './lib/instagram.js';
import { collectYouTube } from './lib/youtube.js';
import { toCSV, filename, download } from './lib/csv.js';

const WATCHDOG = 'watchdog';
const STALE_AFTER_MS = 45000;

// Worker-scoped, deliberately not persisted: if this is empty after a restart, the
// watchdog knows the loop died and needs resuming.
let active = null;
const ports = new Set();

// ── Broadcast ─────────────────────────────────────────────────

function broadcast(message) {
  for (const port of ports) {
    try {
      port.postMessage(message);
    } catch {
      ports.delete(port);
    }
  }
}

async function pushState(extra = {}) {
  const run = await getRun();
  broadcast({ type: 'state', run, ...extra });
  await paintBadge(run);
  return run;
}

async function paintBadge(run) {
  if (!run || run.status === 'idle') {
    await chrome.action.setBadgeText({ text: '' });
    return;
  }
  const colors = {
    running: '#0E6B60',
    paused: '#856614',
    blocked: '#A6402E',
    error: '#A6402E',
    done: '#0E6B60'
  };
  const text = run.status === 'running'
    ? (run.total ? `${Math.min(99, Math.floor((run.collected / run.total) * 100))}%` : '…')
    : run.status === 'done' ? '✓' : '!';

  await chrome.action.setBadgeBackgroundColor({ color: colors[run.status] || '#6B7873' });
  await chrome.action.setBadgeText({ text });
}

function notify(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icon128.png',
    title,
    message
  });
}

// ── Target parsing & tab discovery ────────────────────────────

export function parseTarget(url) {
  const ig = url.match(/instagram\.com\/(?:p|reel)\/([\w-]+)/);
  if (ig) return { platform: 'instagram', postId: ig[1] };
  const yt = url.match(/(?:youtube\.com\/watch\?(?:.*&)?v=|youtu\.be\/|youtube\.com\/shorts\/)([\w-]+)/);
  if (yt) return { platform: 'youtube', postId: yt[1] };
  return null;
}

/**
 * Which post the app should offer to collect.
 *
 * Prefers the post the user clicked the icon from, then any open post tab, most
 * recently looked at first. Returns null when nothing relevant is open, which the
 * app renders as an empty box rather than a wrong guess.
 */
async function detectPost() {
  const { pendingPost } = await chrome.storage.local.get('pendingPost');
  if (pendingPost && Date.now() - pendingPost.at < 5 * 60 * 1000) {
    const stillOpen = await chrome.tabs.get(pendingPost.tabId).catch(() => null);
    if (stillOpen) return { url: pendingPost.url, ...parseTarget(pendingPost.url) };
  }

  const tabs = (await Promise.all([
    chrome.tabs.query({ url: '*://www.instagram.com/p/*' }),
    chrome.tabs.query({ url: '*://www.instagram.com/reel/*' }),
    chrome.tabs.query({ url: '*://www.youtube.com/watch*' }),
    chrome.tabs.query({ url: '*://www.youtube.com/shorts/*' })
  ])).flat();

  if (!tabs.length) return null;
  tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));

  const url = tabs[0].url.split('?')[0];
  const target = parseTarget(tabs[0].url);
  return target ? { url: target.platform === 'youtube' ? tabs[0].url : url, ...target } : null;
}

async function findTab({ platform, postId }) {
  const patterns = platform === 'youtube'
    ? ['*://www.youtube.com/watch*', '*://www.youtube.com/shorts/*']
    : ['*://www.instagram.com/p/*', '*://www.instagram.com/reel/*'];

  const tabs = (await Promise.all(
    patterns.map(pattern => chrome.tabs.query({ url: pattern }))
  )).flat();

  // Prefer the tab actually showing this post; fall back to any tab on the platform,
  // since the fetch only needs the origin's session, not the rendered page.
  const exact = tabs.find(t => t.url?.includes(postId));
  return exact || tabs[0] || null;
}

// ── Run lifecycle ─────────────────────────────────────────────

async function startRun({ postUrl, options = {} }) {
  if (active) throw new Error('A collection is already running');

  const target = parseTarget(postUrl || '');
  if (!target) throw new Error('Not an Instagram post or YouTube video URL');

  const tab = await findTab(target);
  if (!tab) {
    throw new Error(
      target.platform === 'youtube'
        ? 'Open the YouTube video in a tab first, then start collecting.'
        : 'Open the Instagram post in a tab first, then start collecting.'
    );
  }

  const settings = await setSettings(options);
  await chrome.storage.local.remove('comments');
  const run = newRun({ ...target, postUrl, tabId: tab.id, delayMs: settings.baseDelayMs });
  await chrome.storage.local.set({ run });

  await chrome.storage.local.remove('pendingPost');
  await chrome.alarms.create(WATCHDOG, { periodInMinutes: 0.5 });
  drive(run).catch(() => { /* drive reports its own failures */ });
  return run;
}

async function resumeIfStale() {
  const run = await getRun();
  if (!run || run.status !== 'running') return;
  if (active) return;
  if (Date.now() - run.updatedAt < STALE_AFTER_MS) return;

  // The worker died mid-run. Pick up from the last checkpointed cursor.
  const tab = await findTab(run);
  if (!tab) {
    await patchRun({ status: 'blocked', error: 'The post tab was closed. Reopen it to continue.' });
    await pushState();
    return;
  }
  await patchRun({ tabId: tab.id, status: 'running' });
  drive(await getRun()).catch(() => {});
}

async function cancelRun() {
  if (active) active.controller.abort();
  const run = await patchRun({ status: 'paused' });
  await pushState();
  return run;
}

// ── The loop ──────────────────────────────────────────────────

async function drive(run) {
  const controller = new AbortController();
  active = { controller };
  const signal = controller.signal;

  const settings = await getSettings();
  const pacer = new Pacer(run.delayMs || settings.baseDelayMs);
  let comments = await getComments();
  let batchNumber = 0;

  const source = run.platform === 'youtube'
    ? collectYouTube({
        tabId: run.tabId, videoId: run.postId, startCursor: run.safeCursor,
        pacer, signal, collectReplies: settings.collectReplies
      })
    : collectInstagram({
        tabId: run.tabId, shortcode: run.postId, startCursor: run.safeCursor,
        pacer, signal, collectReplies: settings.collectReplies
      });

  try {
    for await (const step of source) {
      batchNumber++;
      const before = comments.length;
      comments = mergeComments(comments, step.batch);
      const added = comments.slice(before);

      const flush = shouldFlush(batchNumber) || step.done;
      if (flush) await saveComments(comments);

      await patchRun({
        cursor: step.cursor,
        // Only advance the resume point once the comments behind it are on disk.
        safeCursor: flush ? step.cursor : run.safeCursor,
        collected: comments.length,
        total: Math.max(step.total || 0, comments.length),
        requests: step.requests,
        retries: step.retries,
        repliesExpanded: step.repliesExpanded,
        repliesFailed: step.repliesFailed,
        postOwner: step.postOwner || null,
        delayMs: pacer.current
      });

      const current = await pushState();
      if (added.length) broadcast({ type: 'entries', comments: added });
      run = current;
    }

    await saveComments(comments);
    await finish(comments);
  } catch (err) {
    if (err instanceof AbortError) {
      await saveComments(comments);
      await patchRun({ status: 'paused', collected: comments.length });
      await pushState();
    } else {
      await saveComments(comments);
      const blocked = err instanceof FatalError && err.kind === 'notab';
      await patchRun({
        status: blocked ? 'blocked' : 'error',
        error: err.message,
        collected: comments.length
      });
      await pushState();
      // Never let a partial list pass as complete — that is the exact bug this
      // rewrite exists to remove.
      notify(
        blocked ? 'Collection paused' : 'Collection stopped',
        `${comments.length.toLocaleString()} collected. ${err.message}`
      );
    }
  } finally {
    active = null;
  }
}

async function finish(comments) {
  const run = await getRun();
  const receipt = buildReceipt(run, comments);

  await patchRun({ status: 'done', collected: comments.length, receipt });
  const final = await getRun();

  await addHistory({
    id: run.id,
    platform: run.platform,
    postId: run.postId,
    postUrl: run.postUrl,
    collected: comments.length,
    date: new Date().toISOString(),
    receipt
  });

  await chrome.alarms.clear(WATCHDOG);
  broadcast({ type: 'done', run: final, receipt });
  await pushState();

  const gap = receipt.reportedTotal - receipt.collected;
  notify(
    'Collection complete',
    gap > 0
      ? `${receipt.collected.toLocaleString()} of ${receipt.reportedTotal.toLocaleString()} — see the app for what's missing.`
      : `${receipt.collected.toLocaleString()} comments collected.`
  );
}

// A run is only trustworthy if it can account for itself. This is what the app shows
// instead of a bare number, and what makes "we got the whole list" checkable.
function buildReceipt(run, comments) {
  const users = new Set(comments.map(c => c.username));
  const replies = comments.filter(c => c.is_reply).length;

  return {
    postUrl: run.postUrl,
    platform: run.platform,
    postId: run.postId,
    startedAt: run.startedAt,
    finishedAt: Date.now(),
    durationMs: Date.now() - run.startedAt,
    requests: run.requests || 0,
    retries: run.retries || 0,
    reportedTotal: run.total || 0,
    collected: comments.length,
    topLevel: comments.length - replies,
    replies,
    uniqueUsers: users.size,
    threadsExpanded: run.repliesExpanded || 0,
    threadsFailed: run.repliesFailed || 0,
    postOwner: run.postOwner || null
  };
}

// ── Messaging ─────────────────────────────────────────────────

async function handle(message) {
  switch (message?.type) {
    case 'hello': {
      return {
        type: 'state',
        run: await getRun(),
        settings: await getSettings(),
        history: await getHistory(),
        post: await detectPost()
      };
    }
    case 'detect':
      return { type: 'detected', post: await detectPost() };
    case 'start': {
      const run = await startRun(message);
      return { type: 'state', run };
    }
    case 'cancel':
      return { type: 'state', run: await cancelRun() };

    case 'resume': {
      const run = await getRun();
      if (!run || run.status === 'running') return { type: 'state', run };
      const tab = await findTab(run);
      if (!tab) throw new Error('Reopen the post in a tab, then resume.');
      await patchRun({ tabId: tab.id, status: 'running', error: null });
      await chrome.alarms.create(WATCHDOG, { periodInMinutes: 0.5 });
      drive(await getRun()).catch(() => {});
      return { type: 'state', run: await getRun() };
    }
    case 'clear': {
      if (active) active.controller.abort();
      await clearRun();
      await chrome.alarms.clear(WATCHDOG);
      await paintBadge(null);
      return { type: 'state', run: null };
    }
    case 'entries': {
      const comments = await getComments();
      const from = message.since || 0;
      return { type: 'entries', comments: comments.slice(from), total: comments.length };
    }
    case 'download': {
      const run = await getRun();
      const comments = await getComments();
      if (!comments.length) throw new Error('Nothing collected yet');
      const name = filename(run?.platform, run?.postId);
      await download(toCSV(comments), name);
      return { type: 'downloaded', filename: name };
    }
    case 'settings':
      return { type: 'settings', settings: await setSettings(message.patch || {}) };

    default:
      throw new Error(`Unknown message: ${message?.type}`);
  }
}

function wire(port) {
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener(async message => {
    try {
      const reply = await handle(message);
      port.postMessage({ ...reply, replyTo: message.id });
    } catch (err) {
      port.postMessage({ type: 'error', message: err.message, replyTo: message.id });
    }
  });
  getRun().then(run => port.postMessage({ type: 'state', run }));
}

// The in-page pill connects here. A content-script port is also the sturdier of the
// two keepalive anchors, so this connection does double duty.
chrome.runtime.onConnect.addListener(wire);

// luckypick.win connects here, via externally_connectable.
chrome.runtime.onConnectExternal.addListener(wire);

// One-shot probe so the app can detect the extension without holding a port open.
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  handle(message).then(sendResponse).catch(err =>
    sendResponse({ type: 'error', message: err.message })
  );
  return true;
});

// ── Lifecycle ─────────────────────────────────────────────────

chrome.action.onClicked.addListener(async tab => {
  // Clicking the icon from a post is the common path, so carry that post over
  // rather than making the user paste the URL they were just looking at.
  const target = tab?.url ? parseTarget(tab.url) : null;
  if (target) {
    await chrome.storage.local.set({
      pendingPost: { url: tab.url.split('?')[0], tabId: tab.id, at: Date.now() }
    });
  }

  const [existing] = await chrome.tabs.query({ url: 'https://luckypick.win/*' });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
    // An already-open tab won't reload, so push the post over the port it holds.
    if (target) broadcast({ type: 'detected', post: await detectPost() });
  } else {
    await chrome.tabs.create({ url: 'https://luckypick.win/' });
  }
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === WATCHDOG) resumeIfStale();
});

// If the post tab goes away mid-run, say so instead of failing silently.
chrome.tabs.onRemoved.addListener(async tabId => {
  const run = await getRun();
  if (run?.status === 'running' && run.tabId === tabId) {
    if (active) active.controller.abort();
    await patchRun({ status: 'blocked', error: 'The post tab was closed. Reopen it to continue.' });
    await pushState();
  }
});

chrome.runtime.onStartup.addListener(resumeIfStale);
chrome.runtime.onInstalled.addListener(resumeIfStale);
