// Instagram collection.
//
// Fetches run inside the Instagram tab via chrome.scripting.executeScript so they
// carry the user's own session on the user's own IP. The injected functions must be
// FULLY SELF-CONTAINED — they are serialized across the boundary, so they can close
// over nothing, not even module constants.

import { withRetry, sleep, FatalError, AbortError } from './pace.js';

export const IG_APP_ID = '936619743392459';
export const COMMENTS_QUERY_HASH = '33ba35852cb50da46f5b5e889df7d159';
export const PAGE_SIZE = 50;

// ── Injected: one page of top-level comments ──────────────────
// Returns a structured result rather than throwing — exceptions serialize poorly
// across executeScript, arriving as a bare "An unexpected error occurred".
function fetchCommentPage(shortcode, after, queryHash, appId) {
  const variables = { shortcode, first: 50 };
  if (after) variables.after = after;
  const url = 'https://www.instagram.com/graphql/query/?query_hash=' + queryHash +
    '&variables=' + encodeURIComponent(JSON.stringify(variables));

  return fetch(url, {
    method: 'GET',
    credentials: 'include',
    headers: { 'X-IG-App-ID': appId }
  }).then(function (resp) {
    return resp.text().then(function (body) {
      if (!resp.ok) return { ok: false, status: resp.status, body: body.slice(0, 300) };
      try {
        return { ok: true, status: resp.status, data: JSON.parse(body) };
      } catch (e) {
        return { ok: false, status: resp.status, body: body.slice(0, 300) };
      }
    });
  }).catch(function (e) {
    return { ok: false, status: 0, body: String(e && e.message || e) };
  });
}

// ── Injected: one page of replies under a single comment ──────
// The GraphQL page only ever inlines the first few replies per thread; the rest live
// behind the same endpoint Instagram's own "View replies" button calls.
function fetchReplyPage(mediaId, commentId, maxId, appId) {
  const url = 'https://www.instagram.com/api/v1/media/' + mediaId + '/comments/' +
    commentId + '/child_comments/?max_id=' + encodeURIComponent(maxId || '');

  return fetch(url, {
    method: 'GET',
    credentials: 'include',
    headers: { 'X-IG-App-ID': appId }
  }).then(function (resp) {
    return resp.text().then(function (body) {
      if (!resp.ok) return { ok: false, status: resp.status, body: body.slice(0, 300) };
      try {
        return { ok: true, status: resp.status, data: JSON.parse(body) };
      } catch (e) {
        return { ok: false, status: resp.status, body: body.slice(0, 300) };
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
    // The tab was closed or navigated away mid-run.
    throw new FatalError(`Lost the Instagram tab: ${err.message}`, 'notab');
  }
  const result = frames?.[0]?.result;
  if (!result) throw new Error('No response from the Instagram tab');
  if (!result.ok) {
    if (result.status === 401 || result.status === 403) {
      throw new FatalError('Instagram rejected the session — log in and retry.', 'auth');
    }
    if (result.status === 404) {
      throw new FatalError('Instagram returned 404 for this post.', 'notfound');
    }
    // 429 and 5xx are worth retrying.
    const err = new Error(`Instagram returned ${result.status}`);
    err.status = result.status;
    throw err;
  }
  return result.data;
}

// ── Parsing ───────────────────────────────────────────────────

function mapComment(node, isReply) {
  return {
    comment_id: String(node.id || node.pk || ''),
    username: node.owner?.username || node.user?.username || 'unknown',
    user_id: String(node.owner?.id || node.user?.pk || ''),
    comment_text: node.text || '',
    timestamp: node.created_at ? new Date(node.created_at * 1000).toISOString() : '',
    profile_pic_url: node.owner?.profile_pic_url || node.user?.profile_pic_url || '',
    is_reply: !!isReply,
    parent_id: isReply ? String(node.parent_comment_id || '') : ''
  };
}

// ── Replies ───────────────────────────────────────────────────

// Expands one thread past the handful Instagram inlines. Reply expansion is the
// single biggest source of lost entries on tag-a-friend giveaways, but it is also
// the least stable endpoint — so a failure here is counted and surfaced, never
// allowed to kill the run or pass silently.
async function expandThread({ tabId, mediaId, parentId, pacer, signal }) {
  const replies = [];
  let maxId = '';
  let guard = 0;

  while (guard++ < 200) {
    if (signal?.aborted) throw new AbortError();

    const data = await withRetry(
      () => runInTab(tabId, fetchReplyPage, [mediaId, parentId, maxId, IG_APP_ID]),
      { attempts: 3, signal }
    );

    for (const child of data?.child_comments || []) {
      replies.push(mapComment({ ...child, parent_comment_id: parentId }, true));
    }

    if (!data?.has_more_tail_child_comments || !data?.next_max_id) break;
    maxId = data.next_max_id;
    await sleep(pacer.delay, signal);
  }

  return replies;
}

// ── Main loop ─────────────────────────────────────────────────

export async function* collectInstagram({
  tabId, shortcode, startCursor, pacer, signal, collectReplies = true
}) {
  let cursor = startCursor || null;
  let mediaId = null;
  let postOwner = null;
  let total = 0;
  let requests = 0;
  let retries = 0;
  let repliesExpanded = 0;
  let repliesFailed = 0;
  let emptyStreak = 0;

  while (true) {
    if (signal?.aborted) throw new AbortError();

    const data = await withRetry(
      () => runInTab(tabId, fetchCommentPage, [shortcode, cursor, COMMENTS_QUERY_HASH, IG_APP_ID]),
      {
        attempts: 5,
        signal,
        onRetry: () => { retries++; pacer.slowDown(); }
      }
    );
    requests++;

    const media = data?.data?.shortcode_media;
    if (!media) {
      throw new FatalError(
        'Instagram returned an unexpected shape — the query hash is probably stale.',
        'shape'
      );
    }

    mediaId = mediaId || media.id;
    postOwner = postOwner || media.owner?.username || null;

    const parentEdge = media.edge_media_to_parent_comment;
    const allEdge = media.edge_media_to_comment;
    const block = parentEdge || allEdge;
    const edges = block?.edges || [];
    const pageInfo = block?.page_info;

    if (!total) total = Math.max(allEdge?.count || 0, parentEdge?.count || 0);

    // An empty page with more pages behind it is a transient hiccup, not the end of
    // the list. The old build treated it as a stop condition.
    if (edges.length === 0 && pageInfo?.has_next_page) {
      if (++emptyStreak >= 3) {
        throw new Error('Instagram kept returning empty pages with more to come');
      }
      pacer.slowDown();
      await sleep(pacer.delay, signal);
      continue;
    }
    emptyStreak = 0;

    const batch = [];
    for (const edge of edges) {
      const node = edge.node;
      batch.push(mapComment(node, false));

      const thread = node.edge_threaded_comments;
      const inlined = thread?.edges || [];
      for (const replyEdge of inlined) {
        batch.push(mapComment({ ...replyEdge.node, parent_comment_id: node.id }, true));
      }

      // Only pay for a thread expansion when Instagram says there is more behind it.
      const hasMore = thread?.page_info?.has_next_page ||
        (thread?.count || 0) > inlined.length;

      if (collectReplies && hasMore && mediaId) {
        try {
          await sleep(pacer.delay, signal);
          const rest = await expandThread({
            tabId, mediaId, parentId: node.id, pacer, signal
          });
          batch.push(...rest);
          repliesExpanded++;
        } catch (err) {
          if (err instanceof AbortError) throw err;
          // Counted, surfaced in the receipt, and the run continues.
          repliesFailed++;
        }
      }
    }

    pacer.speedUp();
    cursor = pageInfo?.end_cursor || null;
    const done = !pageInfo?.has_next_page || !cursor;

    const wait = pacer.delay;
    yield {
      batch, cursor, total, postOwner, mediaId,
      requests, retries, repliesExpanded, repliesFailed, done,
      nextWaitMs: done ? 0 : wait
    };

    if (done) return;
    await sleep(wait, signal);
  }
}
