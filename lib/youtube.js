// YouTube collection via InnerTube.
//
// Same rules as instagram.js: injected functions run in the YouTube tab and must be
// fully self-contained. The old build collected only top-level comments and hardcoded
// is_reply: false, so every reply on every video was missing.

import { withRetry, sleep, FatalError, AbortError } from './pace.js';

const FALLBACK_CLIENT_VERSION = '2.20260101.00.00';
const FALLBACK_API_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

// ── Injected: read client config out of the page ──────────────
function readPageConfig() {
  let clientVersion = null;
  let apiKey = null;
  let channelOwner = null;

  if (window.ytcfg && typeof window.ytcfg.get === 'function') {
    clientVersion = window.ytcfg.get('INNERTUBE_CLIENT_VERSION') || null;
    apiKey = window.ytcfg.get('INNERTUBE_API_KEY') || null;
  }
  try {
    channelOwner = window.ytInitialPlayerResponse?.videoDetails?.author || null;
  } catch (e) { /* not available */ }

  return { ok: true, data: { clientVersion, apiKey, channelOwner } };
}

// ── Injected: one InnerTube /next call ────────────────────────
// Used for both the initial video lookup (videoId) and every pagination step
// (continuation) — the endpoint is the same, only the payload key differs.
function fetchNext(payload, clientVersion, apiKey) {
  const url = 'https://www.youtube.com/youtubei/v1/next?key=' + apiKey + '&prettyPrint=false';
  const body = Object.assign(
    { context: { client: { clientName: 'WEB', clientVersion: clientVersion } } },
    payload
  );

  return fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(function (resp) {
    return resp.text().then(function (text) {
      if (!resp.ok) return { ok: false, status: resp.status, body: text.slice(0, 300) };
      try {
        return { ok: true, status: resp.status, data: JSON.parse(text) };
      } catch (e) {
        return { ok: false, status: resp.status, body: text.slice(0, 300) };
      }
    });
  }).catch(function (e) {
    return { ok: false, status: 0, body: String(e && e.message || e) };
  });
}

// ── Transport ─────────────────────────────────────────────────

async function runInTab(tabId, func, args) {
  let frames;
  try {
    frames = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  } catch (err) {
    throw new FatalError(`Lost the YouTube tab: ${err.message}`, 'notab');
  }
  const result = frames?.[0]?.result;
  if (!result) throw new Error('No response from the YouTube tab');
  if (!result.ok) {
    if (result.status === 401 || result.status === 403) {
      throw new FatalError('YouTube rejected the request.', 'auth');
    }
    const err = new Error(`YouTube returned ${result.status}`);
    err.status = result.status;
    throw err;
  }
  return result.data;
}

// ── Parsing ───────────────────────────────────────────────────

// YouTube's newer format keeps comment bodies in a flat entity table keyed by id,
// with the render tree only holding references.
function buildEntityMap(data) {
  const map = {};
  for (const mutation of data?.frameworkUpdates?.entityBatchUpdate?.mutations || []) {
    const entity = mutation.payload?.commentEntityPayload;
    if (entity) map[entity.properties?.commentId || mutation.entityKey] = entity;
  }
  return map;
}

function flattenItems(data) {
  const items = [];
  for (const ep of data?.onResponseReceivedEndpoints || []) {
    const batch = ep.reloadContinuationItemsCommand?.continuationItems
      || ep.appendContinuationItemsAction?.continuationItems
      || [];
    items.push(...batch);
  }
  return items;
}

function mapFromEntity(entity, isReply, parentId) {
  return {
    comment_id: entity.properties?.commentId || '',
    username: (entity.author?.displayName || 'unknown').replace(/^@/, ''),
    user_id: entity.author?.channelId || '',
    comment_text: entity.properties?.content?.content || '',
    timestamp: entity.properties?.publishedTime || '',
    profile_pic_url: entity.avatar?.image?.sources?.[0]?.url
      || entity.author?.avatarThumbnailUrl || '',
    is_reply: !!isReply,
    parent_id: parentId || ''
  };
}

function mapFromRenderer(renderer, isReply, parentId) {
  return {
    comment_id: renderer.commentId || '',
    username: (renderer.authorText?.simpleText || 'unknown').replace(/^@/, ''),
    user_id: renderer.authorEndpoint?.browseEndpoint?.browseId || '',
    comment_text: (renderer.contentText?.runs || []).map(r => r.text).join(''),
    timestamp: renderer.publishedTimeText?.runs?.[0]?.text || '',
    profile_pic_url: renderer.authorThumbnail?.thumbnails?.slice(-1)[0]?.url || '',
    is_reply: !!isReply,
    parent_id: parentId || ''
  };
}

function readComment(item, entityMap, isReply, parentId) {
  const viewModel = item.commentViewModel?.commentViewModel || item.commentViewModel;
  if (viewModel?.commentId) {
    const entity = entityMap[viewModel.commentId];
    if (entity) return mapFromEntity(entity, isReply, parentId);
  }
  const renderer = item.comment?.commentRenderer || item.commentRenderer;
  if (renderer) return mapFromRenderer(renderer, isReply, parentId);
  return null;
}

function tokenFrom(item) {
  const r = item?.continuationItemRenderer;
  if (!r) return null;
  return r.continuationEndpoint?.continuationCommand?.token
    || r.button?.buttonRenderer?.command?.continuationCommand?.token
    || null;
}

// ── Replies ───────────────────────────────────────────────────

async function expandThread({ tabId, token, clientVersion, apiKey, parentId, pacer, signal }) {
  const replies = [];
  let continuation = token;
  let guard = 0;

  while (continuation && guard++ < 200) {
    if (signal?.aborted) throw new AbortError();

    const data = await withRetry(
      () => runInTab(tabId, fetchNext, [{ continuation }, clientVersion, apiKey]),
      { attempts: 3, signal }
    );

    const entityMap = buildEntityMap(data);
    let next = null;
    for (const item of flattenItems(data)) {
      const moreToken = tokenFrom(item);
      if (moreToken) { next = moreToken; continue; }
      const comment = readComment(item, entityMap, true, parentId);
      if (comment) replies.push(comment);
    }

    continuation = next;
    if (continuation) await sleep(pacer.delay, signal);
  }

  return replies;
}

// ── Bootstrap ─────────────────────────────────────────────────

// ytInitialData goes stale after SPA navigation — it is not reassigned when YouTube
// swaps videos client-side — so the continuation token is always derived from a live
// /next call keyed by videoId, never read off the page.
async function bootstrap({ tabId, videoId, signal }) {
  let clientVersion = FALLBACK_CLIENT_VERSION;
  let apiKey = FALLBACK_API_KEY;
  let channelOwner = null;

  try {
    const cfg = await runInTab(tabId, readPageConfig, []);
    clientVersion = cfg.clientVersion || clientVersion;
    apiKey = cfg.apiKey || apiKey;
    channelOwner = cfg.channelOwner;
  } catch (err) {
    if (err instanceof FatalError) throw err;
    // Fall through on the defaults.
  }

  const data = await withRetry(
    () => runInTab(tabId, fetchNext, [{ videoId }, clientVersion, apiKey]),
    { attempts: 4, signal }
  );

  const contents = data?.contents?.twoColumnWatchNextResults?.results?.results?.contents || [];
  let continuation = null;

  for (const item of contents) {
    const section = item.itemSectionRenderer;
    if (section?.sectionIdentifier !== 'comment-item-section') continue;
    for (const entry of section.contents || []) {
      const token = tokenFrom(entry);
      if (token) { continuation = token; break; }
    }
    if (continuation) break;
  }

  if (!continuation) {
    for (const item of contents) {
      for (const entry of item.itemSectionRenderer?.contents || []) {
        const token = tokenFrom(entry);
        if (token) { continuation = token; break; }
      }
      if (continuation) break;
    }
  }

  if (!channelOwner) {
    for (const item of contents) {
      const owner = item.videoSecondaryInfoRenderer?.owner?.videoOwnerRenderer
        ?.title?.runs?.[0]?.text;
      if (owner) { channelOwner = owner; break; }
    }
  }

  if (!continuation) {
    throw new FatalError('Could not find the comment section — comments may be disabled.', 'shape');
  }

  return { continuation, clientVersion, apiKey, channelOwner };
}

// ── Main loop ─────────────────────────────────────────────────

export async function* collectYouTube({
  tabId, videoId, startCursor, pacer, signal, collectReplies = true
}) {
  const boot = await bootstrap({ tabId, videoId, signal });
  const { clientVersion, apiKey } = boot;
  const postOwner = boot.channelOwner;

  let continuation = startCursor || boot.continuation;
  let total = 0;
  let requests = 0;
  let retries = 0;
  let repliesExpanded = 0;
  let repliesFailed = 0;

  while (continuation) {
    if (signal?.aborted) throw new AbortError();

    const data = await withRetry(
      () => runInTab(tabId, fetchNext, [{ continuation }, clientVersion, apiKey]),
      {
        attempts: 5,
        signal,
        onRetry: () => { retries++; pacer.slowDown(); }
      }
    );
    requests++;

    const entityMap = buildEntityMap(data);
    const items = flattenItems(data);
    const batch = [];
    let next = null;

    for (const item of items) {
      if (!total) {
        const header = item.commentsHeaderRenderer;
        const countText = header?.countText?.runs?.[0]?.text
          || header?.commentsCount?.simpleText || '';
        const parsed = parseInt(countText.replace(/[^0-9]/g, ''), 10);
        if (parsed > 0) total = parsed;
      }

      // A bare continuation item at this level is the next page of top-level threads.
      const pageToken = tokenFrom(item);
      if (pageToken) { next = pageToken; continue; }

      const thread = item.commentThreadRenderer;
      if (!thread) continue;

      const comment = readComment(thread, entityMap, false, '');
      if (!comment) continue;
      batch.push(comment);

      const replyToken = tokenFrom(
        thread.replies?.commentRepliesRenderer?.contents?.[0]
      );

      if (collectReplies && replyToken) {
        try {
          await sleep(pacer.delay, signal);
          const rest = await expandThread({
            tabId, token: replyToken, clientVersion, apiKey,
            parentId: comment.comment_id, pacer, signal
          });
          batch.push(...rest);
          repliesExpanded++;
        } catch (err) {
          if (err instanceof AbortError) throw err;
          repliesFailed++;
        }
      }
    }

    pacer.speedUp();
    continuation = next;

    yield {
      batch, cursor: continuation, total, postOwner,
      requests, retries, repliesExpanded, repliesFailed,
      done: !continuation
    };

    if (continuation) await sleep(pacer.delay, signal);
  }
}
