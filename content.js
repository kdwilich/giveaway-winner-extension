// Global flag to track if scraping should be cancelled (var allows re-declaration)
var shouldCancelScraping = false;

// Remove previous listener if script is re-injected
if (typeof window.__giveawayMessageListener !== 'undefined') {
  chrome.runtime.onMessage.removeListener(window.__giveawayMessageListener);
}

// Listen for messages from popup
window.__giveawayMessageListener = (request, sender, sendResponse) => {
  if (request.action === 'scrapeComments') {
    const delaySeconds = request.delaySeconds || 10; // Default 10 seconds
    const instagramUrl = request.instagramUrl; // Capture URL from sidepanel
    
    // Reset cancel flag when starting new scrape
    shouldCancelScraping = false;
    
    // Progress callback to send updates back to sidepanel
    // Fire-and-forget: never cancel the scrape due to messaging failures.
    // The sidepanel may not always be listening (e.g. during tab switches)
    // but scraping should continue regardless.
    const sendProgress = (progress) => {
      try {
        chrome.runtime.sendMessage({
          action: 'progress',
          data: progress
        }).catch(() => { /* sidepanel may not be listening — ignore */ });
      } catch (e) {
        // Extension context invalidated — ignore
      }
    };

    // Use GraphQL API to fetch comments with provided URL
    fetchCommentsViaGraphQL(sendProgress, delaySeconds, instagramUrl)
      .then(result => {
        if (!shouldCancelScraping) {
          try {
            sendResponse({ 
              success: true, 
              comments: result.comments,
              postOwner: result.postOwner 
            });
          } catch (error) {
            console.log('Could not send response, storing in storage for later:', error);
            // Store in chrome.storage for when popup reopens
            chrome.storage.local.set({
              completedFetch: {
                comments: result.comments,
                postOwner: result.postOwner,
                timestamp: Date.now()
              }
            });
          }
        }
      })
      .catch(error => {
        console.error('Error fetching comments:', error);
        if (!shouldCancelScraping) {
          try {
            sendResponse({ success: false, error: error.message });
          } catch (e) {
            console.log('Could not send error response:', e);
          }
        }
      })
      .finally(() => {
        // Cleanup
        shouldCancelScraping = false;
      });
    return true; // Keep message channel open for async response
  }
  
  if (request.action === 'ping') {
    sendResponse({ alive: true });
    return true;
  }

  if (request.action === 'cancelScrape') {
    shouldCancelScraping = true;
    console.log('Scraping cancelled by user');
    sendResponse({ cancelled: true });
    return true;
  }
  
  return false;
};
chrome.runtime.onMessage.addListener(window.__giveawayMessageListener);

// Extract shortcode from URL (use provided URL or current page)
function getShortcodeFromUrl(url = null) {
  const targetUrl = url || window.location.href;
  const match = targetUrl.match(/\/p\/([^\/]+)/);
  return match ? match[1] : null;
}

// Fetch comments using Instagram's GraphQL API
async function fetchCommentsViaGraphQL(sendProgress, delaySeconds = 10, instagramUrl = null) {
  const shortcode = getShortcodeFromUrl(instagramUrl);
  if (!shortcode) {
    throw new Error('Could not extract post shortcode from URL');
  }

  const allComments = [];
  let hasNextPage = true;
  let endCursor = '';
  let postOwner = null;
  let requestCount = 0;
  let totalCommentCount = 0;
  let stuckCounter = 0; // Track if we're stuck at same count
  let lastCommentCount = 0;
  const MAX_REQUESTS = 1000; // Safety limit (supports up to ~50,000 comments)
  const MAX_STUCK_ITERATIONS = 3; // If count doesn't change for 3 requests, stop
  let totalLatencyMs = 0;
  let latencyCount = 0;

  console.log(`Starting to fetch comments for post: ${shortcode}`);
  console.log(`Using ${delaySeconds} second delay between requests`);
  
  while (hasNextPage && requestCount < MAX_REQUESTS && !shouldCancelScraping) {
    requestCount++;
    
    try {
      // Check if cancelled before making request
      if (shouldCancelScraping) {
        console.log('Scraping cancelled, stopping...');
        break;
      }
      
      // Build GraphQL query
      const variables = {
        shortcode: shortcode,
        first: 50, // Fetch 50 comments per request
        after: endCursor
      };

      const url = `https://www.instagram.com/graphql/query/?query_hash=33ba35852cb50da46f5b5e889df7d159&variables=${encodeURIComponent(JSON.stringify(variables))}`;
      
      console.log(`Fetching batch ${requestCount} (after: ${endCursor || 'start'})`);

      const fetchStart = Date.now();
      const response = await fetch(url, {
        method: 'GET',
        credentials: 'include' // Include cookies for authentication
      });

      if (!response.ok) {
        throw new Error(`API request failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      const latencyMs = Date.now() - fetchStart;
      totalLatencyMs += latencyMs;
      latencyCount++;
      
      // Navigate to comments data
      const commentData = data?.data?.shortcode_media?.edge_media_to_comment 
        || data?.data?.shortcode_media?.edge_media_to_parent_comment;
      const edges = commentData?.edges || [];
      const pageInfo = commentData?.page_info;
      
      // Extract post owner and total count from first response
      if (!postOwner && data?.data?.shortcode_media?.owner?.username) {
        postOwner = data.data.shortcode_media.owner.username;
      }
      
      // Get total comment count from first response
      if (totalCommentCount === 0) {
        const countData = data?.data?.shortcode_media?.edge_media_to_comment 
          || data?.data?.shortcode_media?.edge_media_to_parent_comment;
        if (countData?.count) {
          totalCommentCount = countData.count;
          console.log(`Total comments to fetch: ${totalCommentCount}`);
        }
      }

      console.log(`Received ${edges.length} comments. Has next page: ${pageInfo?.has_next_page}`);
      
      // If we got 0 edges and API says there's a next page, we're likely stuck
      if (edges.length === 0 && pageInfo?.has_next_page) {
        console.log('Warning: API says more pages exist but returned 0 comments. Stopping.');
        break;
      }
      
      // Process comments
      for (const edge of edges) {
        const node = edge.node;
        
        // Add parent comment
        allComments.push({
          comment_id: node.id || '',
          username: node.owner?.username || 'unknown',
          user_id: node.owner?.id || '',
          comment_text: node.text || '',
          timestamp: node.created_at ? new Date(node.created_at * 1000).toISOString() : 'unknown',
          profile_pic_url: node.owner?.profile_pic_url || '',
          is_reply: false
        });

        // Add replies if any
        if (node.edge_threaded_comments?.edges) {
          for (const replyEdge of node.edge_threaded_comments.edges) {
            const reply = replyEdge.node;
            allComments.push({
              comment_id: reply.id || '',
              username: reply.owner?.username || 'unknown',
              user_id: reply.owner?.id || '',
              comment_text: reply.text || '',
              timestamp: reply.created_at ? new Date(reply.created_at * 1000).toISOString() : 'unknown',
              profile_pic_url: reply.owner?.profile_pic_url || '',
              is_reply: true
            });
          }
        }
      }

      // Check if we're stuck (count hasn't changed)
      if (allComments.length === lastCommentCount) {
        stuckCounter++;
        console.log(`Warning: Comment count hasn't changed (${allComments.length}). Stuck counter: ${stuckCounter}`);
        if (stuckCounter >= MAX_STUCK_ITERATIONS) {
          console.log('Stuck at same count for too long. Completing fetch with current comments.');
          break;
        }
      } else {
        stuckCounter = 0; // Reset if we made progress
        lastCommentCount = allComments.length;
      }

      // Send progress update (lightweight — no comments array)
      if (sendProgress) {
        sendProgress({
          current: allComments.length,
          total: Math.max(totalCommentCount, allComments.length),
          percent: totalCommentCount ? Math.min(100, Math.round((allComments.length / totalCommentCount) * 100)) : 0,
          comments: allComments,
          postOwner: postOwner,
          avgLatencyMs: latencyCount > 0 ? totalLatencyMs / latencyCount : null
        });
      }

      // Check if there are more pages
      hasNextPage = pageInfo?.has_next_page || false;
      endCursor = pageInfo?.end_cursor || '';
      
      // If we've fetched at least as many as the total count (with small margin), stop even if hasNextPage is true
      if (totalCommentCount > 0 && allComments.length >= totalCommentCount - 5) {
        console.log(`Fetched ${allComments.length} comments, close enough to reported total of ${totalCommentCount}. Stopping.`);
        break;
      }

      // Rate limiting: wait with countdown
      if (hasNextPage && !shouldCancelScraping) {
        console.log(`Waiting ${delaySeconds} seconds before next request...`);
        
        // Send countdown updates every second
        for (let i = delaySeconds; i > 0; i--) {
          // Check if cancelled during countdown (multiple times per second for responsiveness)
          if (shouldCancelScraping) {
            console.log('Scraping cancelled during countdown');
            break;
          }
          
          if (sendProgress) {
              // Only send lightweight countdown data (no comments array)
              sendProgress({
                current: allComments.length,
                total: Math.max(totalCommentCount, allComments.length),
                percent: totalCommentCount ? Math.min(100, Math.round((allComments.length / totalCommentCount) * 100)) : 0,
                countdown: i,
                avgLatencyMs: latencyCount > 0 ? totalLatencyMs / latencyCount : null
              });
          }
          
          // Wait 1 second but check cancellation every 100ms
          for (let j = 0; j < 10; j++) {
            if (shouldCancelScraping) break;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          
          if (shouldCancelScraping) break;
        }
      }

    } catch (error) {
      // Check if error is due to popup closing
      if (error.message && error.message.includes('Extension context invalidated')) {
        console.log('Extension context invalidated (popup closed), stopping...');
        shouldCancelScraping = true;
        break;
      }
      console.error(`Error in batch ${requestCount}:`, error);
      // Continue with what we have if there's an error
      break;
    }
  }

  if (requestCount >= MAX_REQUESTS) {
    console.warn(`Hit MAX_REQUESTS limit (${MAX_REQUESTS}). Fetched ${allComments.length} of ${totalCommentCount} comments.`);
  }
  console.log(`Finished fetching. Total comments: ${allComments.length} (${requestCount} requests)`);
  
  return {
    comments: allComments,
    postOwner: postOwner
  };
}
