// Executed inside the Instagram tab via chrome.scripting.executeScript.
// Must be fully self-contained — no closures allowed.
async function fetchCommentBatch(shortcode, endCursor) {
  const variables = { shortcode, first: 50, after: endCursor };
  const url = `https://www.instagram.com/graphql/query/?query_hash=33ba35852cb50da46f5b5e889df7d159&variables=${encodeURIComponent(JSON.stringify(variables))}`;
  const resp = await fetch(url, { method: 'GET', credentials: 'include' });
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
  return resp.json();
}

// Executed inside a YouTube tab to extract page data needed for comment fetching.
// Must be fully self-contained — no closures allowed.
function getYouTubePageData() {
  const log = [];
  let continuationToken = null;
  let channelOwner = null;
  let clientVersion = '2.20260101.00.00';
  let apiKey = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

  // Get client config from YouTube's global
  if (window.ytcfg && typeof window.ytcfg.get === 'function') {
    const cv = window.ytcfg.get('INNERTUBE_CLIENT_VERSION');
    if (cv) clientVersion = cv;
    const ak = window.ytcfg.get('INNERTUBE_API_KEY');
    if (ak) apiKey = ak;
    log.push(`ytcfg found: clientVersion=${cv}, apiKey=${ak ? 'yes' : 'no'}`);
  } else {
    log.push('ytcfg NOT found on window');
  }

  // Get channel owner from player response
  try {
    if (window.ytInitialPlayerResponse?.videoDetails) {
      channelOwner = window.ytInitialPlayerResponse.videoDetails.author || null;
      log.push(`channelOwner from ytInitialPlayerResponse: ${channelOwner}`);
    } else {
      log.push('ytInitialPlayerResponse.videoDetails not found');
    }
  } catch(e) { log.push('ytInitialPlayerResponse error: ' + e.message); }

  // Helper: extract continuation token from an itemSectionRenderer's contents
  const extractToken = (sectionContents) => {
    if (!sectionContents) return null;
    for (const content of sectionContents) {
      if (content.continuationItemRenderer) {
        return content.continuationItemRenderer
          .continuationEndpoint?.continuationCommand?.token
          || content.continuationItemRenderer.button?.buttonRenderer
            ?.command?.continuationCommand?.token
          || null;
      }
    }
    return null;
  };

  // Try to get ytInitialData from multiple sources
  let data = null;
  try { data = window.ytInitialData; } catch(e) {}
  log.push(`ytInitialData from window: ${data ? 'yes' : 'no'}`);

  // Fallback: parse from script tags if the global was cleared (SPA navigation)
  if (!data) {
    try {
      const scripts = document.querySelectorAll('script:not([src])');
      let foundTag = false;
      for (const script of scripts) {
        const text = script.textContent;
        if (text && text.includes('ytInitialData')) {
          foundTag = true;
          const match = text.match(/ytInitialData\s*=\s*(\{.+?\})\s*;/s);
          if (match) { data = JSON.parse(match[1]); log.push('ytInitialData parsed from script tag'); break; }
          else { log.push('ytInitialData script tag found but regex did not match'); }
        }
      }
      if (!foundTag) log.push('No script tag containing ytInitialData found');
    } catch(e) { log.push('Script tag parse error: ' + e.message); }
  }

  if (data) {
    const twoCol = data?.contents?.twoColumnWatchNextResults;
    log.push(`twoColumnWatchNextResults: ${twoCol ? 'yes' : 'no'}`);
    const contents = twoCol?.results?.results?.contents;
    log.push(`contents array: ${contents ? `yes (${contents.length} items)` : 'no'}`);

    if (contents && Array.isArray(contents)) {
      // Log all section types for debugging
      const sectionInfo = contents.map((item, i) => {
        const keys = Object.keys(item);
        const sec = item.itemSectionRenderer;
        return `[${i}] ${keys.join(',')} sectionId=${sec?.sectionIdentifier || 'none'} contentsLen=${sec?.contents?.length || 0}`;
      });
      log.push('Sections: ' + sectionInfo.join(' | '));

      // Strategy 1: target the comment section by sectionIdentifier
      for (const item of contents) {
        const section = item.itemSectionRenderer;
        if (section?.sectionIdentifier === 'comment-item-section') {
          log.push('Found comment-item-section');
          const token = extractToken(section.contents);
          if (token) { continuationToken = token; log.push('Token from Strategy 1'); break; }
          else { log.push('comment-item-section had no continuationItemRenderer'); }
        }
      }

      // Strategy 2: fallback — try any itemSectionRenderer with a continuationItemRenderer
      if (!continuationToken) {
        for (const item of contents) {
          const section = item.itemSectionRenderer;
          if (section?.contents) {
            const token = extractToken(section.contents);
            if (token) { continuationToken = token; log.push('Token from Strategy 2'); break; }
          }
        }
      }
    }

    // Strategy 3: search engagement panels
    if (!continuationToken && data?.engagementPanels) {
      log.push(`engagementPanels: ${data.engagementPanels.length} panels`);
      for (const panel of data.engagementPanels) {
        const panelId = panel.engagementPanelSectionListRenderer?.panelIdentifier || 'unknown';
        const sectionContents = panel.engagementPanelSectionListRenderer
          ?.content?.sectionListRenderer?.contents;
        if (sectionContents) {
          for (const section of sectionContents) {
            if (section.itemSectionRenderer?.contents) {
              const token = extractToken(section.itemSectionRenderer.contents);
              if (token) { continuationToken = token; log.push(`Token from engagement panel: ${panelId}`); break; }
            }
          }
        }
        if (continuationToken) break;
      }
    }
  }

  if (!continuationToken) log.push('NO continuation token found from any strategy');

  return { continuationToken, channelOwner, clientVersion, apiKey, log };
}

// Fallback: fetch YouTube page data via InnerTube API when ytInitialData is unavailable.
// Must be fully self-contained — no closures allowed.
async function fetchYouTubePageViaApi(videoId, clientVersion, apiKey) {
  const url = `https://www.youtube.com/youtubei/v1/next?key=${apiKey}&prettyPrint=false`;
  const resp = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      context: { client: { clientName: 'WEB', clientVersion } },
      videoId
    })
  });
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
  return resp.json();
}

// Executed inside a YouTube tab to fetch a batch of comments.
// Must be fully self-contained — no closures allowed.
async function fetchYouTubeCommentBatch(continuation, clientVersion, apiKey) {
  const url = `https://www.youtube.com/youtubei/v1/next?key=${apiKey}&prettyPrint=false`;
  const resp = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      context: { client: { clientName: 'WEB', clientVersion } },
      continuation
    })
  });
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
  return resp.json();
}

// Side panel script - handles UI interaction
document.addEventListener('DOMContentLoaded', () => {
  const scrapeBtn = document.getElementById('scrapeBtn');
  const cancelBtn = document.getElementById('cancelBtn');
  const redownloadBtn = document.getElementById('redownloadBtn');
  const statusDiv = document.getElementById('status');
  const progressPane = document.getElementById('progressPane');
  const progFill = document.getElementById('progFill');
  const progPct = document.getElementById('progPct');
  const statCount = document.getElementById('statCount');
  const statOf = document.getElementById('statOf');
  const statTime = document.getElementById('statTime');
  const progNext = document.getElementById('progNext');
  const progNextNum = document.getElementById('progNextNum');
  const delaySlider = document.getElementById('delaySlider');
  const delayValue = document.getElementById('delayValue');
  const instructionsToggle = document.getElementById('instructionsToggle');
  const instructionsContent = document.getElementById('instructionsContent');
  const postUrlInput = document.getElementById('postUrl');
  const urlError = document.getElementById('urlError');
  let isProcessing = false;
  let scrapingTabId = null; // Track which tab is running the scrape
  let currentComments = []; // Store fetched comments
  let currentPostOwner = null;
  let lastDownloadedComments = []; // Store last successful download for re-download
  let lastDownloadFilename = ''; // Store last filename
  let scrapeStartTime = null; // Track when scraping started
  let shouldCancelScraping = false;

  // ── Cross-tab state persistence ───────────────────────────────
  // Saves the current UI state to chrome.storage.session so that when
  // the user switches tabs and the sidepanel re-renders, it shows the
  // same thing.
  function saveState() {
    const state = {
      statusText: statusDiv.textContent,
      statusClass: statusDiv.className,
      isProcessing,
      instructionsCollapsed: instructionsContent.classList.contains('collapsed'),
      rateLimitCollapsed: document.getElementById('rateLimitContent').classList.contains('collapsed'),
      downloadReady: redownloadBtn.style.display === 'block',
      downloadLabel: redownloadBtn.textContent,
      downloadComments: lastDownloadedComments,
      downloadFilename: lastDownloadFilename,
      historyCollapsed: historyTable.classList.contains('collapsed'),
    };
    chrome.storage.session.set({ panelState: state }).catch(() => {});
  }

  async function restoreState() {
    try {
      const { panelState } = await chrome.storage.session.get('panelState');
      if (!panelState) return;

      // Status message
      if (panelState.statusText) {
        statusDiv.textContent = panelState.statusText;
        statusDiv.className = panelState.statusClass || 'status';
      }

      // Collapsible sections
      if (panelState.instructionsCollapsed) {
        instructionsToggle.classList.add('collapsed');
        instructionsContent.classList.add('collapsed');
      } else {
        instructionsToggle.classList.remove('collapsed');
        instructionsContent.classList.remove('collapsed');
      }
      if (panelState.rateLimitCollapsed) {
        document.getElementById('rateLimitToggle').classList.add('collapsed');
        document.getElementById('rateLimitContent').classList.add('collapsed');
      } else {
        document.getElementById('rateLimitToggle').classList.remove('collapsed');
        document.getElementById('rateLimitContent').classList.remove('collapsed');
      }

      // Download button
      if (panelState.downloadReady && panelState.downloadComments?.length > 0) {
        lastDownloadedComments = panelState.downloadComments;
        lastDownloadFilename = panelState.downloadFilename || `comments-${Date.now()}.csv`;
        redownloadBtn.textContent = panelState.downloadLabel || 'Download CSV File';
        redownloadBtn.style.display = 'block';
      }

      // History section
      if (panelState.historyCollapsed === false) {
        historyToggle.classList.remove('collapsed');
        historyTable.classList.remove('collapsed');
      } else {
        historyToggle.classList.add('collapsed');
        historyTable.classList.add('collapsed');
      }
    } catch (e) {
      console.log('Could not restore panel state:', e);
    }
  }

  // Restore on load
  restoreState();

  // Listen for storage changes (another tab saved state)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes.panelState && !isProcessing) {
      restoreState();
    }
  });
  
  // Toggle instructions section
  instructionsToggle.addEventListener('click', () => {
    instructionsToggle.classList.toggle('collapsed');
    instructionsContent.classList.toggle('collapsed');
    saveState();
  });

  // Toggle rate-limit section
  document.getElementById('rateLimitToggle').addEventListener('click', () => {
    document.getElementById('rateLimitToggle').classList.toggle('collapsed');
    document.getElementById('rateLimitContent').classList.toggle('collapsed');
    saveState();
  });

  // ── Run history ─────────────────────────────────────────────
  const historyToggle = document.getElementById('historyToggle');
  const historyTable = document.getElementById('historyTable');
  const historyBody = document.getElementById('historyBody');
  let runHistory = []; // { id, filename, csv, date, commentCount, shortcode, platform }

  // Toggle history section
  historyToggle.addEventListener('click', () => {
    historyToggle.classList.toggle('collapsed');
    historyTable.classList.toggle('collapsed');
    saveState();
  });

  async function loadHistory() {
    try {
      const { runHistory: stored } = await chrome.storage.local.get('runHistory');
      runHistory = stored || [];
    } catch (e) {
      runHistory = [];
    }
    renderHistory();
  }

  function persistHistory() {
    chrome.storage.local.set({ runHistory }).catch(() => {});
  }

  function addHistoryEntry(filename, csvContent, commentCount, postId, platform) {
    const entry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      filename,
      csv: csvContent,
      date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      commentCount,
      shortcode: postId || '',
      platform: platform || 'instagram'
    };
    runHistory.unshift(entry);
    // Keep last 50 entries to avoid storage bloat
    if (runHistory.length > 50) runHistory = runHistory.slice(0, 50);
    persistHistory();
    renderHistory();
  }

  function removeHistoryEntry(id) {
    runHistory = runHistory.filter(e => e.id !== id);
    persistHistory();
    renderHistory();
  }

  function renderHistory() {
    historyBody.innerHTML = '';
    if (runHistory.length === 0) {
      historyBody.innerHTML = '<tr><td colspan="5" class="history-empty">No runs yet</td></tr>';
      return;
    }

    for (const entry of runHistory) {
      const tr = document.createElement('tr');

      // Comments cell
      const tdComments = document.createElement('td');
      tdComments.className = 'history-td-comments';
      tdComments.textContent = entry.commentCount;
      tdComments.title = `${entry.commentCount} comments`;

      // Post cell
      const tdPost = document.createElement('td');
      tdPost.className = 'history-td-post';
      if (entry.shortcode) {
        const link = document.createElement('a');
        if (entry.platform === 'youtube') {
          link.href = `https://www.youtube.com/watch?v=${entry.shortcode}`;
          link.title = `Open video on YouTube`;
        } else {
          link.href = `https://www.instagram.com/p/${entry.shortcode}/`;
          link.title = `Open post ${entry.shortcode} on Instagram`;
        }
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = entry.shortcode;
        tdPost.appendChild(link);
      } else {
        tdPost.textContent = entry.filename;
        tdPost.title = entry.filename;
      }

      // Date cell
      const tdDate = document.createElement('td');
      tdDate.className = 'history-td-date';
      tdDate.textContent = entry.date;
      tdDate.title = entry.date;

      // Download button cell
      const tdDl = document.createElement('td');
      const dlBtn = document.createElement('button');
      dlBtn.className = 'history-download';
      dlBtn.innerHTML = '\u2B07';
      dlBtn.title = 'Download CSV';
      dlBtn.addEventListener('click', () => {
        downloadCSV(entry.csv, entry.filename);
      });
      tdDl.appendChild(dlBtn);

      // Delete button cell
      const tdDel = document.createElement('td');
      const delBtn = document.createElement('button');
      delBtn.className = 'history-delete';
      delBtn.title = 'Remove from history';
      delBtn.addEventListener('click', () => removeHistoryEntry(entry.id));
      tdDel.appendChild(delBtn);

      tr.append(tdComments, tdPost, tdDate, tdDl, tdDel);
      historyBody.appendChild(tr);
    }
  }

  // Load history on startup
  loadHistory();
  
  // Update slider progress fill
  const updateSliderProgress = () => {
    const value = ((delaySlider.value - delaySlider.min) / (delaySlider.max - delaySlider.min)) * 100;
    delaySlider.style.setProperty('--range-progress', `${value}%`);
  };
  
  // Initialize slider progress
  updateSliderProgress();
  
  // ── Platform detection helpers ────────────────────────────────
  function detectPlatform(url) {
    if (/instagram\.com\/(p|reel)\/[\w-]+/.test(url)) return 'instagram';
    if (/(?:youtube\.com\/(?:watch|shorts)|youtu\.be\/)/.test(url)) return 'youtube';
    return null;
  }

  function extractVideoId(url) {
    const match = url.match(/(?:youtube\.com\/watch\?.*v=|youtu\.be\/|youtube\.com\/shorts\/)([\w-]+)/);
    return match?.[1] || null;
  }

  // Auto-fill URL from current tab
  let userManuallyEdited = false; // True once user types/pastes in the input
  
  const currentPageBadge = document.getElementById('currentPageBadge');

  const setCurrentPageBadge = (visible) => {
    if (visible) currentPageBadge.classList.remove('hidden');
    else currentPageBadge.classList.add('hidden');
  };

  const autoFillUrl = async () => {
    if (isProcessing || userManuallyEdited) return;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.url) {
        if (tab.url.match(/instagram\.com\/(p|reel)\//)) {
          postUrlInput.value = tab.url.split('?')[0];
          validateUrl();
          setCurrentPageBadge(true);
        } else if (tab.url.match(/youtube\.com\/watch/)) {
          const vid = tab.url.match(/[?&]v=([\w-]+)/)?.[1];
          if (vid) {
            postUrlInput.value = `https://www.youtube.com/watch?v=${vid}`;
            validateUrl();
            setCurrentPageBadge(true);
          }
        } else if (tab.url.match(/youtube\.com\/shorts\//)) {
          postUrlInput.value = tab.url.split('?')[0];
          validateUrl();
          setCurrentPageBadge(true);
        } else {
          setCurrentPageBadge(false);
        }
      } else {
        setCurrentPageBadge(false);
      }
    } catch (e) {
      console.log('Could not auto-fill URL:', e);
    }
  };
  autoFillUrl();
  
  // Stop auto-filling once the user manually edits the input
  // If the user clears the input, resume auto-filling
  postUrlInput.addEventListener('input', () => {
    userManuallyEdited = postUrlInput.value.trim().length > 0;
    setCurrentPageBadge(false);
  });
  
  // Re-fill URL when tab changes
  chrome.tabs.onActivated.addListener(() => autoFillUrl());
  
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.url) autoFillUrl();
  });
  
  // URL validation
  function validateUrl() {
    const url = postUrlInput.value.trim();
    postUrlInput.classList.remove('valid', 'invalid');
    urlError.classList.remove('visible');
    urlError.textContent = '';
    
    if (!url) {
      return false;
    }
    
    const platform = detectPlatform(url);
    if (!platform) {
      postUrlInput.classList.add('invalid');
      urlError.textContent = 'Enter an Instagram post URL or YouTube video URL';
      urlError.classList.add('visible');
      return false;
    }
    
    return true;
  }
  
  postUrlInput.addEventListener('input', validateUrl);
  postUrlInput.addEventListener('blur', validateUrl);
  
  // Check if there's a completed fetch waiting (from previous session)
  chrome.storage.local.get(['completedFetch'], (result) => {
    if (result.completedFetch) {
      const data = result.completedFetch;
      showStatus(`✓ Done! ${data.comments.length} comments collected. Ready to download.`, 'success');
      
      // Store for manual download
      lastDownloadedComments = data.comments;
      const prefix = data.platform === 'youtube' ? 'youtube-comments' : 'instagram-comments';
      lastDownloadFilename = `${prefix}-${data.shortcode || Date.now()}.csv`;
      redownloadBtn.textContent = 'Download CSV File';
      redownloadBtn.style.display = 'block';
      
      // Clear the stored data
      chrome.storage.local.remove(['completedFetch']);
    }
  });
  
  // Update delay display when slider changes
  delaySlider.addEventListener('input', (e) => {
    delayValue.textContent = `${e.target.value}s`;
    updateSliderProgress();
  });
  
  // Load saved delay setting
  if (chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['delaySeconds'], (result) => {
      if (result.delaySeconds) {
        delaySlider.value = result.delaySeconds;
        delayValue.textContent = `${result.delaySeconds}s`;
        updateSliderProgress();
      }
    });
    
    // Save delay setting when changed
    delaySlider.addEventListener('change', (e) => {
      chrome.storage.local.set({ delaySeconds: parseInt(e.target.value) });
    });
  } else {
    console.error('chrome.storage is not available. Make sure the extension has storage permission and is properly loaded.');
  }
  
  // Timer state for smooth, continuously-ticking countdown display
  let timerInterval = null;
  let estimatedSecondsRemaining = 0;
  let displayCountdown = 0;
  let currentCollected = 0;
  let currentTotal = 0;
  let currentPercent = 0;
  let rollingLatencyMs = 500; // Initial estimate; refined by actual response times

  // Rebuild the progress pane from current state (driven by both the message handler and the interval)
  const rebuildStatus = () => {
    progFill.style.width = `${currentPercent}%`;
    progPct.textContent = `${currentPercent}%`;
    statCount.textContent = currentCollected.toLocaleString();
    statOf.textContent = currentTotal > 0 ? `of ${currentTotal.toLocaleString()}` : '';

    const secs = Math.round(estimatedSecondsRemaining);
    if (secs <= 1) {
      statTime.textContent = '—';
    } else {
      const mins = Math.floor(secs / 60);
      const rem = secs % 60;
      statTime.textContent = mins > 0
        ? (rem > 0 ? `~${mins}m ${rem}s` : `~${mins}m`)
        : `~${secs}s`;
    }

    // Update the number only; the label is static in HTML
    progNext.style.display = '';
    progNextNum.textContent = displayCountdown > 0 ? `${displayCountdown}s` : '…';
  };

  // ── Scrape loop — runs in sidepanel, executes each fetch inside the Instagram tab ──
  async function runScrape(tabId, shortcode, delaySeconds) {
    const allComments = [];
    let hasNextPage = true;
    let endCursor = '';
    let postOwner = null;
    let requestCount = 0;
    let totalCommentCount = 0;
    let stuckCounter = 0;
    let lastCommentCount = 0;
    const MAX_REQUESTS = 1000;
    const MAX_STUCK_ITERATIONS = 3;
    let totalLatencyMs = 0;
    let latencyCount = 0;

    while (hasNextPage && requestCount < MAX_REQUESTS && !shouldCancelScraping) {
      requestCount++;
      if (shouldCancelScraping) break;

      const fetchStart = Date.now();
      let data;
      try {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId },
          func: fetchCommentBatch,
          args: [shortcode, endCursor]
        });
        if (result.error) throw new Error(result.error.message || 'Script execution error');
        data = result.result;
      } catch (err) {
        console.error(`Batch ${requestCount} error:`, err);
        break;
      }

      const latencyMs = Date.now() - fetchStart;
      totalLatencyMs += latencyMs;
      latencyCount++;

      const media = data?.data?.shortcode_media;
      const etpcData = media?.edge_media_to_parent_comment;
      const etcData = media?.edge_media_to_comment;
      const commentData = etpcData || etcData;
      const edges = commentData?.edges || [];
      const pageInfo = commentData?.page_info;

      if (!postOwner && media?.owner?.username) postOwner = media.owner.username;

      if (totalCommentCount === 0) {
        totalCommentCount = Math.max(etcData?.count || 0, etpcData?.count || 0);
      }

      if (edges.length === 0 && pageInfo?.has_next_page) break;

      // Process comments
      for (const edge of edges) {
        const node = edge.node;
        allComments.push({
          comment_id: node.id || '',
          username: node.owner?.username || 'unknown',
          user_id: node.owner?.id || '',
          comment_text: node.text || '',
          timestamp: node.created_at ? new Date(node.created_at * 1000).toISOString() : 'unknown',
          profile_pic_url: node.owner?.profile_pic_url || '',
          is_reply: false
        });
        if (node.edge_threaded_comments?.edges) {
          for (const re of node.edge_threaded_comments.edges) {
            const r = re.node;
            allComments.push({
              comment_id: r.id || '',
              username: r.owner?.username || 'unknown',
              user_id: r.owner?.id || '',
              comment_text: r.text || '',
              timestamp: r.created_at ? new Date(r.created_at * 1000).toISOString() : 'unknown',
              profile_pic_url: r.owner?.profile_pic_url || '',
              is_reply: true
            });
          }
        }
      }

      // Stuck detection
      if (allComments.length === lastCommentCount) {
        if (++stuckCounter >= MAX_STUCK_ITERATIONS) break;
      } else {
        stuckCounter = 0;
        lastCommentCount = allComments.length;
      }

      // Update pagination
      hasNextPage = pageInfo?.has_next_page || false;
      endCursor = pageInfo?.end_cursor || '';

      // Update UI state
      currentCollected = allComments.length;
      currentTotal = Math.max(totalCommentCount, allComments.length);
      currentPercent = totalCommentCount
        ? Math.min(100, Math.round((allComments.length / totalCommentCount) * 100))
        : 0;
      currentComments = allComments;
      currentPostOwner = postOwner;

      // Recalculate time estimate
      const remaining = Math.max(0, currentTotal - currentCollected);
      if (remaining > 0) {
        rollingLatencyMs = rollingLatencyMs * 0.7 + (totalLatencyMs / latencyCount) * 0.3;
        estimatedSecondsRemaining = Math.ceil(remaining / 50) * (delaySeconds + rollingLatencyMs / 1000);
      } else {
        estimatedSecondsRemaining = 0;
      }
      rebuildStatus();

      // Early exit when close to total
      if (totalCommentCount > 0 && allComments.length >= totalCommentCount - 5) break;

      // Rate-limit countdown (delay between batches)
      if (hasNextPage && !shouldCancelScraping) {
        displayCountdown = delaySeconds;
        rebuildStatus();
        for (let i = 0; i < delaySeconds * 10; i++) {
          if (shouldCancelScraping) break;
          await new Promise(r => setTimeout(r, 100));
        }
        displayCountdown = 0;
      }
    }

    return { comments: allComments, postOwner };
  }

  // ── YouTube scrape loop — runs in sidepanel, executes each fetch inside the YouTube tab ──
  async function runYouTubeScrape(tabId, videoId, delaySeconds) {
    const allComments = [];
    let hasNextPage = true;
    let continuation = null;
    let postOwner = null;
    let requestCount = 0;
    let totalCommentCount = 0;
    let stuckCounter = 0;
    let lastCommentCount = 0;
    const MAX_REQUESTS = 2000; // YouTube returns ~20 per batch
    const MAX_STUCK_ITERATIONS = 3;
    let totalLatencyMs = 0;
    let latencyCount = 0;
    let clientVersion = '2.20260101.00.00';
    let apiKey = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

    // Step 1: Get client config (apiKey, clientVersion, channelOwner) from the injected page.
    // NOTE: window.ytInitialData is NOT reliable after SPA navigation — YouTube updates the DOM
    // dynamically but does not reassign the global. We still want the client config from ytcfg
    // (which IS updated), but we always derive the continuation token from the API call below.
    try {
      const [pageDataResult] = await chrome.scripting.executeScript({
        target: { tabId },
        func: getYouTubePageData
      });
      if (pageDataResult.error) throw new Error(pageDataResult.error.message);
      const pageData = pageDataResult.result;
      postOwner = pageData.channelOwner;
      clientVersion = pageData.clientVersion || clientVersion;
      apiKey = pageData.apiKey || apiKey;
      // Do NOT use pageData.continuationToken — ytInitialData can be stale after SPA navigation.
    } catch (err) { /* page config unavailable, defaults will be used */ }

    // Step 1b: Always fetch the initial continuation token via InnerTube API with the videoId.
    // This guarantees we are fetching comments for the correct current video regardless of
    // whether the user navigated via SPA (where ytInitialData stays stale).
    try {
      const [apiResult] = await chrome.scripting.executeScript({
        target: { tabId },
        func: fetchYouTubePageViaApi,
        args: [videoId, clientVersion, apiKey]
      });
      if (apiResult.error) throw new Error(apiResult.error.message);
      const apiData = apiResult.result;

      const contents = apiData?.contents?.twoColumnWatchNextResults?.results?.results?.contents;
      if (contents && Array.isArray(contents)) {
        // Try comment-item-section first, then any section with a continuationItemRenderer
        for (const item of contents) {
          const section = item.itemSectionRenderer;
          if (section?.sectionIdentifier === 'comment-item-section' && section?.contents) {
            for (const content of section.contents) {
              if (content.continuationItemRenderer) {
                continuation = content.continuationItemRenderer
                  .continuationEndpoint?.continuationCommand?.token || null;
                if (continuation) break;
              }
            }
          }
          if (continuation) break;
        }
        if (!continuation) {
          for (const item of contents) {
            const section = item.itemSectionRenderer;
            if (section?.contents) {
              for (const content of section.contents) {
                if (content.continuationItemRenderer) {
                  continuation = content.continuationItemRenderer
                    .continuationEndpoint?.continuationCommand?.token || null;
                  if (continuation) break;
                }
              }
            }
            if (continuation) break;
          }
        }

        // Grab channel owner from API response if not already found
        if (!postOwner) {
          for (const item of contents) {
            const owner = item.videoSecondaryInfoRenderer?.owner
              ?.videoOwnerRenderer?.title?.runs?.[0]?.text;
            if (owner) { postOwner = owner; break; }
          }
        }
      }
    } catch (err) { /* continuation token fetch failed */ }

    if (!continuation) {
      return { comments: [], postOwner: null };
    }

    // Step 2: Fetch comment batches
    while (hasNextPage && requestCount < MAX_REQUESTS && !shouldCancelScraping) {
      requestCount++;

      const fetchStart = Date.now();
      let data;
      try {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId },
          func: fetchYouTubeCommentBatch,
          args: [continuation, clientVersion, apiKey]
        });
        if (result.error) throw new Error(result.error.message || 'Script execution error');
        data = result.result;
      } catch (err) {
        break;
      }

      const latencyMs = Date.now() - fetchStart;
      totalLatencyMs += latencyMs;
      latencyCount++;

      // Parse response — comments are in onResponseReceivedEndpoints
      const endpoints = data?.onResponseReceivedEndpoints || [];
      let continuationItems = [];
      for (const ep of endpoints) {
        const items = ep.reloadContinuationItemsCommand?.continuationItems
          || ep.appendContinuationItemsAction?.continuationItems
          || [];
        continuationItems = continuationItems.concat(items);
      }

      // Build entity lookup from frameworkUpdates.entityBatchUpdate.mutations
      // (YouTube's new commentViewModel format stores data here)
      const entityMap = {};
      const mutations = data?.frameworkUpdates?.entityBatchUpdate?.mutations || [];
      for (const mutation of mutations) {
        if (mutation.payload?.commentEntityPayload) {
          const entity = mutation.payload.commentEntityPayload;
          entityMap[entity.properties?.commentId || mutation.entityKey] = entity;
        }
      }

      // Extract total count from header (first response only)
      if (totalCommentCount === 0) {
        for (const item of continuationItems) {
          const header = item.commentsHeaderRenderer;
          if (header) {
            const countText = header.countText?.runs?.[0]?.text
              || header.commentsCount?.simpleText || '';
            const num = parseInt(countText.replace(/[^0-9]/g, ''), 10);
            if (num > 0) totalCommentCount = num;
          }
        }
      }

      // Extract comments and next continuation
      let nextContinuation = null;
      for (const item of continuationItems) {
        if (item.commentThreadRenderer) {
          const thread = item.commentThreadRenderer;

          // ── New format: commentViewModel + entityBatchUpdate ──
          const viewModel = thread.commentViewModel?.commentViewModel;
          if (viewModel?.commentId) {
            const entity = entityMap[viewModel.commentId];
            if (entity) {
              allComments.push({
                comment_id: entity.properties?.commentId || viewModel.commentId,
                username: (entity.author?.displayName || 'unknown').replace(/^@/, ''),

                user_id: entity.author?.channelId || '',
                comment_text: entity.properties?.content?.content || '',
                timestamp: entity.properties?.publishedTime || 'unknown',
                profile_pic_url: entity.avatar?.image?.sources?.[0]?.url
                  || entity.author?.avatarThumbnailUrl || '',
                is_reply: false
              });
            }
          } else {
            // ── Legacy format: commentRenderer ──
            const renderer = thread.comment?.commentRenderer;
            if (renderer) {
              const commentText = (renderer.contentText?.runs || [])
                .map(r => r.text).join('');
              allComments.push({
                comment_id: renderer.commentId || '',
                username: (renderer.authorText?.simpleText || 'unknown').replace(/^@/, ''),
                user_id: renderer.authorEndpoint?.browseEndpoint?.browseId || '',
                comment_text: commentText,
                timestamp: renderer.publishedTimeText?.runs?.[0]?.text || 'unknown',
                profile_pic_url: renderer.authorThumbnail?.thumbnails?.slice(-1)[0]?.url || '',
                is_reply: false
              });
            }
          }
        }
        // Next page continuation
        if (item.continuationItemRenderer) {
          nextContinuation = item.continuationItemRenderer.continuationEndpoint
            ?.continuationCommand?.token
            || item.continuationItemRenderer.button?.buttonRenderer?.command
              ?.continuationCommand?.token
            || null;
        }
      }

      // Stuck detection
      if (allComments.length === lastCommentCount) {
        if (++stuckCounter >= MAX_STUCK_ITERATIONS) break;
      } else {
        stuckCounter = 0;
        lastCommentCount = allComments.length;
      }

      // Update pagination
      hasNextPage = !!nextContinuation;
      continuation = nextContinuation;

      // Update UI state
      currentCollected = allComments.length;
      currentTotal = Math.max(totalCommentCount, allComments.length);
      currentPercent = totalCommentCount
        ? Math.min(100, Math.round((allComments.length / totalCommentCount) * 100))
        : 0;
      currentComments = allComments;
      currentPostOwner = postOwner;

      // Recalculate time estimate (YouTube returns ~20 per batch)
      const remaining = Math.max(0, currentTotal - currentCollected);
      if (remaining > 0) {
        rollingLatencyMs = rollingLatencyMs * 0.7 + (totalLatencyMs / latencyCount) * 0.3;
        estimatedSecondsRemaining = Math.ceil(remaining / 20) * (delaySeconds + rollingLatencyMs / 1000);
      } else {
        estimatedSecondsRemaining = 0;
      }
      rebuildStatus();

      // Early exit when close to total
      if (totalCommentCount > 0 && allComments.length >= totalCommentCount - 5) break;

      // Rate-limit countdown
      if (hasNextPage && !shouldCancelScraping) {
        displayCountdown = delaySeconds;
        rebuildStatus();
        for (let i = 0; i < delaySeconds * 10; i++) {
          if (shouldCancelScraping) break;
          await new Promise(r => setTimeout(r, 100));
        }
        displayCountdown = 0;
      }
    }

    return { comments: allComments, postOwner };
  }

  scrapeBtn.addEventListener('click', async () => {
    // Collapse instructions section when fetch starts
    if (!instructionsContent.classList.contains('collapsed')) {
      instructionsToggle.classList.add('collapsed');
      instructionsContent.classList.add('collapsed');
    }
    
    scrapeBtn.style.display = 'none';
    isProcessing = true;
    scrapingTabId = null;
    currentComments = [];
    currentPostOwner = null;
    scrapeStartTime = Date.now();
    showStatus('Starting up…', 'info');
    
    // Validate URL input
    const postUrl = postUrlInput.value.trim();
    
    if (!postUrl) {
      postUrlInput.classList.add('invalid');
      urlError.textContent = 'Please enter an Instagram or YouTube URL';
      urlError.classList.add('visible');
      showStatus('Error: Please enter a post URL.', 'error');
      resetButton();
      postUrlInput.focus();
      return;
    }
    
    if (!validateUrl()) {
      showStatus('Error: Invalid post URL.', 'error');
      resetButton();
      postUrlInput.focus();
      return;
    }
    
    const platform = detectPlatform(postUrl);
    
    // Hide re-download button when starting new fetch
    redownloadBtn.style.display = 'none';
    
    // Show cancel button and disable slider, checkbox, and URL input
    cancelBtn.style.display = 'block';
    delaySlider.disabled = true;
    document.getElementById('excludePoster').disabled = true;
    postUrlInput.disabled = true;
    
    // Get settings
    const excludePoster = document.getElementById('excludePoster').checked;
    const delaySeconds = parseInt(delaySlider.value);
    
    try {
      // Helper: try to ping a tab's content script
      const ping = (tabId) => new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, { action: 'ping' }, (response) => {
          if (chrome.runtime.lastError || !response?.alive) resolve(false);
          else resolve(true);
        });
      });

      // Helper: try to inject content script into a tab and verify it's alive
      const tryTab = async (targetTab) => {
        if (!targetTab?.id) return false;
        const requiredDomain = platform === 'youtube' ? 'youtube.com' : 'instagram.com';
        if (!targetTab.url?.includes(requiredDomain)) return false;
        if (targetTab.status !== 'complete' && targetTab.status !== 'loading') return false;

        // Already alive?
        if (await ping(targetTab.id)) return true;

        // Try injecting
        try {
          await chrome.scripting.executeScript({ target: { tabId: targetTab.id }, files: ['content.js'] });
          await new Promise(resolve => setTimeout(resolve, 500));
          return await ping(targetTab.id);
        } catch (err) {
          return false;
        }
      };

      const platformLabel = platform === 'youtube' ? 'YouTube' : 'Instagram';
      showStatus(`Connecting to ${platformLabel}…`, 'info');

      // Strategy: try multiple tabs until one works
      let tab = null;

      if (platform === 'instagram') {
        // ── Instagram tab discovery ──
        const matchingTabs = await chrome.tabs.query({ url: '*://www.instagram.com/p/*' });
        const targetShortcode = postUrl.match(/\/(?:p|reel)\/([\w-]+)/)?.[1];

        const reelTabs = await chrome.tabs.query({ url: '*://www.instagram.com/reel/*' });
        const allCandidates = [...matchingTabs, ...reelTabs];

        if (targetShortcode) {
          const exactMatch = allCandidates.find(t => t.url.includes(`/p/${targetShortcode}`) || t.url.includes(`/reel/${targetShortcode}`));
          if (exactMatch && await tryTab(exactMatch)) tab = exactMatch;
        }

        if (!tab) {
          const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (activeTab?.url?.includes('instagram.com') && await tryTab(activeTab)) tab = activeTab;
        }

        if (!tab) {
          for (const candidate of allCandidates) {
            if (await tryTab(candidate)) { tab = candidate; break; }
          }
        }
      } else {
        // ── YouTube tab discovery ──
        const videoId = extractVideoId(postUrl);
        const watchTabs = await chrome.tabs.query({ url: '*://www.youtube.com/watch*' });
        const shortsTabs = await chrome.tabs.query({ url: '*://www.youtube.com/shorts/*' });
        const allCandidates = [...watchTabs, ...shortsTabs];

        if (videoId) {
          const exactMatch = allCandidates.find(t => t.url.includes(`v=${videoId}`) || t.url.includes(`/shorts/${videoId}`));
          if (exactMatch && await tryTab(exactMatch)) tab = exactMatch;
        }

        if (!tab) {
          const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (activeTab?.url?.includes('youtube.com') && await tryTab(activeTab)) tab = activeTab;
        }

        if (!tab) {
          for (const candidate of allCandidates) {
            if (await tryTab(candidate)) { tab = candidate; break; }
          }
        }
      }

      if (!tab) {
        showStatus(`⚠️ Could not connect to any ${platformLabel} tab. Please make sure you have the ${platform === 'youtube' ? 'YouTube video' : 'Instagram post'} open and refresh the page, then try again.`, 'error');
        resetButton();
        return;
      }

      // Run the scrape loop directly from sidepanel
      scrapingTabId = tab.id;
      shouldCancelScraping = false;
      progressPane.classList.add('active');
      statusDiv.className = 'status'; // clear "Connecting…"

      // Start smooth 1s ticker for time estimate & countdown display
      if (!timerInterval) {
        timerInterval = setInterval(() => {
          if (!isProcessing) { clearInterval(timerInterval); timerInterval = null; return; }
          estimatedSecondsRemaining = Math.max(0, estimatedSecondsRemaining - 1);
          if (displayCountdown > 0) displayCountdown = Math.max(0, displayCountdown - 1);
          rebuildStatus();
        }, 1000);
      }

      let result;
      let postIdentifier;
      if (platform === 'instagram') {
        postIdentifier = postUrl.match(/\/(?:p|reel)\/([\w-]+)/)?.[1] || '';
        result = await runScrape(tab.id, postIdentifier, delaySeconds);
      } else {
        postIdentifier = extractVideoId(postUrl) || '';
        result = await runYouTubeScrape(tab.id, postIdentifier, delaySeconds);
      }

      // Handle result
      let comments = result.comments;
      if (excludePoster && result.postOwner) {
        comments = comments.filter(c => c.username !== result.postOwner);
      }

      const filenamePrefix = platform === 'youtube' ? 'youtube-comments' : 'instagram-comments';

      if (shouldCancelScraping) {
        if (comments.length > 0) {
          lastDownloadedComments = comments;
          lastDownloadFilename = `${filenamePrefix}-${postIdentifier || Date.now()}.csv`;
          // Record partial run in history
          const csv = convertToCSV(comments);
          addHistoryEntry(lastDownloadFilename, csv, comments.length, postIdentifier, platform);
          showStatus(`⚠️ Stopped. ${comments.length} comments collected — ready to download.`, 'success');
          redownloadBtn.textContent = 'Download CSV File';
          redownloadBtn.style.display = 'block';
        } else {
          showStatus('Stopped. No comments collected yet.', 'error');
        }
        resetButton();
        saveState();
        return;
      }

      if (comments.length === 0) {
        showStatus(`No comments found on this ${platform === 'youtube' ? 'video' : 'post'}. Try refreshing the page.`, 'error');
        resetButton();
        saveState();
        return;
      }

      lastDownloadedComments = comments;
      lastDownloadFilename = `${filenamePrefix}-${postIdentifier || Date.now()}.csv`;

      // Record completed run in history
      const csv = convertToCSV(comments);
      addHistoryEntry(lastDownloadFilename, csv, comments.length, postIdentifier, platform);

      let durationText = '';
      if (scrapeStartTime) {
        const elapsed = Math.round((Date.now() - scrapeStartTime) / 1000);
        const mins = Math.floor(elapsed / 60);
        const secs = elapsed % 60;
        durationText = mins > 0 ? ` (took ${mins}m ${secs}s)` : ` (took ${secs}s)`;
      }
      showStatus(`✓ Done! ${comments.length} comments collected${durationText}.`, 'success');
      redownloadBtn.textContent = 'Download CSV File';
      redownloadBtn.style.display = 'block';
      resetButton();
      // Persist completed state so other tabs see it
      saveState();

    } catch (error) {
      showStatus(`Error: ${error.message}`, 'error');
      resetButton();
      saveState();
    }
  });
  
  cancelBtn.addEventListener('click', () => {
    if (!isProcessing) return;
    shouldCancelScraping = true;
    cancelBtn.disabled = true;
    cancelBtn.textContent = 'Cancelling...';
    // runScrape will see the flag, exit, and the click handler will show partial results.
  });
  
  // Re-download button handler
  redownloadBtn.addEventListener('click', () => {
    if (lastDownloadedComments.length > 0) {
      const csv = convertToCSV(lastDownloadedComments);
      downloadCSV(csv, lastDownloadFilename);
      showStatus(`✓ Downloaded ${lastDownloadedComments.length} comments.`, 'success');
      saveState();
    }
  });
  
  function showStatus(message, type) {
    if (type === 'success' || type === 'error') {
      progressPane.classList.remove('active');
      progNext.style.display = 'none';
    }
    statusDiv.textContent = message;
    statusDiv.className = `status visible ${type}`;
  }
  
  function resetButton() {
    shouldCancelScraping = false;
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    estimatedSecondsRemaining = 0;
    displayCountdown = 0;
    currentCollected = 0;
    currentTotal = 0;
    currentPercent = 0;
    progNext.style.display = 'none';
    progNextNum.textContent = '…';
    scrapeBtn.style.display = '';
    scrapeBtn.disabled = false;
    scrapeBtn.textContent = 'Collect Comments';
    isProcessing = false;
    scrapingTabId = null;
    cancelBtn.style.display = 'none';
    cancelBtn.disabled = false;
    cancelBtn.textContent = 'Cancel';
    delaySlider.disabled = false;
    document.getElementById('excludePoster').disabled = false;
    postUrlInput.disabled = false;
    // Don't clear currentComments/currentPostOwner — they feed the download button
  }
  
  function convertToCSV(comments) {
    // CSV header
    const header = ['comment_id', 'username', 'user_id', 'comment_text', 'timestamp', 'profile_pic_url', 'is_reply'];
    
    // Escape CSV fields
    const escapeCSV = (field) => {
      if (field === null || field === undefined) return '';
      const str = String(field);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };
    
    // Build CSV rows
    const rows = comments.map(comment => [
      escapeCSV(comment.comment_id),
      escapeCSV(comment.username),
      escapeCSV(comment.user_id),
      escapeCSV(comment.comment_text),
      escapeCSV(comment.timestamp),
      escapeCSV(comment.profile_pic_url),
      escapeCSV(comment.is_reply)
    ].join(','));
    
    // Combine header and rows
    return [header.join(','), ...rows].join('\n');
  }
  
  function downloadCSV(csvContent, filename) {
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    
    chrome.downloads.download({
      url: url,
      filename: filename,
      saveAs: false
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error('Download error:', chrome.runtime.lastError);
      }
    });
  }
});
