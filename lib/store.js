// Single source of truth for run state.
//
// Every surface (app tab, in-page pill, toolbar badge) renders from here, and the
// engine checkpoints after every batch — so a terminated service worker resumes
// instead of losing the run. Never keep run state in module globals: MV3 tears the
// worker down after ~30s idle and globals go with it.

const RUN_KEY = 'run';
const COMMENTS_KEY = 'comments';
const HISTORY_KEY = 'history';
const SETTINGS_KEY = 'settings';

// Persisting the whole comment array on every batch is O(n^2) over a long run, so
// the array is only flushed every few batches. `safeCursor` marks the cursor that
// blob corresponds to; a resume rewinds there and dedupes the overlap by id.
const COMMENT_FLUSH_EVERY = 5;

export const DEFAULT_SETTINGS = {
  baseDelayMs: 2500,
  excludePoster: true,
  collectReplies: true
};

export async function getSettings() {
  const { [SETTINGS_KEY]: s } = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(s || {}) };
}

export async function setSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export async function getRun() {
  const { [RUN_KEY]: run } = await chrome.storage.local.get(RUN_KEY);
  return run || null;
}

export async function patchRun(patch) {
  const current = (await getRun()) || {};
  const run = { ...current, ...patch, updatedAt: Date.now() };
  await chrome.storage.local.set({ [RUN_KEY]: run });
  return run;
}

export async function clearRun() {
  await chrome.storage.local.remove([RUN_KEY, COMMENTS_KEY]);
}

export function newRun({ platform, postId, postUrl, tabId, delayMs }) {
  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    platform,
    postId,
    postUrl,
    tabId,
    delayMs,
    status: 'running',
    cursor: null,
    safeCursor: null,
    collected: 0,
    total: 0,
    requests: 0,
    retries: 0,
    repliesExpanded: 0,
    repliesFailed: 0,
    postOwner: null,
    error: null,
    startedAt: Date.now(),
    updatedAt: Date.now()
  };
}

export async function getComments() {
  const { [COMMENTS_KEY]: c } = await chrome.storage.local.get(COMMENTS_KEY);
  return c || [];
}

export async function saveComments(comments) {
  await chrome.storage.local.set({ [COMMENTS_KEY]: comments });
}

export function shouldFlush(batchNumber) {
  return batchNumber % COMMENT_FLUSH_EVERY === 0;
}

// Comments arrive from overlapping sources — a rewound cursor, a retried batch, a
// reply thread already partly seen inline. Identity is the platform comment id.
export function mergeComments(existing, incoming) {
  const seen = new Set(existing.map(c => c.comment_id));
  const merged = existing.slice();
  for (const c of incoming) {
    if (c.comment_id && seen.has(c.comment_id)) continue;
    if (c.comment_id) seen.add(c.comment_id);
    merged.push(c);
  }
  return merged;
}

// ── Run history ───────────────────────────────────────────────

export async function getHistory() {
  const { [HISTORY_KEY]: h } = await chrome.storage.local.get(HISTORY_KEY);
  return h || [];
}

export async function addHistory(entry) {
  const history = await getHistory();
  history.unshift(entry);
  await chrome.storage.local.set({ [HISTORY_KEY]: history.slice(0, 25) });
}
