
// Global flag to track if scraping should be cancelled
let shouldCancelScraping = false;

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'scrapeComments') {
    const delaySeconds = request.delaySeconds || 10; // Default 10 seconds
    
    // Reset cancel flag when starting new scrape
    shouldCancelScraping = false;
    
    // Progress callback to send updates back to popup
    const sendProgress = (progress) => {
      try {
        chrome.runtime.sendMessage({
          action: 'progress',
          data: progress
        });
      } catch (error) {
        // Popup was closed, cancel the scraping
        console.log('Popup closed, cancelling scrape...');
        shouldCancelScraping = true;
      }
    };

    // Use GraphQL API to fetch comments
    fetchCommentsViaGraphQL(sendProgress, delaySeconds)
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
  
  if (request.action === 'cancelScrape') {
    shouldCancelScraping = true;
    console.log('Scraping cancelled by user');
    sendResponse({ cancelled: true });
    return true;
  }
  
  return false;
});

// Extract shortcode from current URL
function getShortcodeFromUrl() {
  const match = window.location.pathname.match(/\/p\/([^\/]+)/);
  return match ? match[1] : null;
}

// Fetch comments using Instagram's GraphQL API
async function fetchCommentsViaGraphQL(sendProgress, delaySeconds = 10) {
  const shortcode = getShortcodeFromUrl();
  if (!shortcode) {
    throw new Error('Could not extract post shortcode from URL');
  }

  const allComments = [];
  let hasNextPage = true;
  let endCursor = '';
  let postOwner = null;
  let requestCount = 0;
  let totalCommentCount = 0;
  const MAX_REQUESTS = 100; // Safety limit

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

      const url = `https://www.instagram.com/graphql/query/?query_hash=bc3296d1ce80a24b1b6e40b1e72903f5&variables=${encodeURIComponent(JSON.stringify(variables))}`;
      
      console.log(`Fetching batch ${requestCount} (after: ${endCursor || 'start'})`);

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'x-ig-app-id': '936619743392459', // Instagram web app ID
          'x-requested-with': 'XMLHttpRequest'
        },
        credentials: 'include' // Include cookies for authentication
      });

      if (!response.ok) {
        throw new Error(`API request failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      
      // Navigate to comments data
      const edges = data?.data?.shortcode_media?.edge_media_to_parent_comment?.edges || [];
      const pageInfo = data?.data?.shortcode_media?.edge_media_to_parent_comment?.page_info;
      
      // Extract post owner and total count from first response
      if (!postOwner && data?.data?.shortcode_media?.owner?.username) {
        postOwner = data.data.shortcode_media.owner.username;
      }
      
      // Get total comment count from first response
      if (totalCommentCount === 0 && data?.data?.shortcode_media?.edge_media_to_parent_comment?.count) {
        totalCommentCount = data.data.shortcode_media.edge_media_to_parent_comment.count;
        console.log(`Total comments to fetch: ${totalCommentCount}`);
      }

      console.log(`Received ${edges.length} comments. Has next page: ${pageInfo?.has_next_page}`);

      // Process comments
      for (const edge of edges) {
        const node = edge.node;
        
        // Add parent comment
        allComments.push({
          username: node.owner?.username || 'unknown',
          comment_text: node.text || '',
          timestamp: node.created_at ? new Date(node.created_at * 1000).toISOString() : 'unknown',
          is_reply: false
        });

        // Add replies if any
        if (node.edge_threaded_comments?.edges) {
          for (const replyEdge of node.edge_threaded_comments.edges) {
            const reply = replyEdge.node;
            allComments.push({
              username: reply.owner?.username || 'unknown',
              comment_text: reply.text || '',
              timestamp: reply.created_at ? new Date(reply.created_at * 1000).toISOString() : 'unknown',
              is_reply: true
            });
          }
        }
      }

      // Send progress update
      if (sendProgress) {
        try {
          const progress = {
            current: allComments.length,
            total: totalCommentCount || allComments.length,
            percent: totalCommentCount ? Math.round((allComments.length / totalCommentCount) * 100) : 0,
            comments: allComments, // Include current comments for cancellation
            postOwner: postOwner
          };
          sendProgress(progress);
        } catch (error) {
          // Popup closed, cancel scraping
          console.log('Progress update failed (popup closed), cancelling...');
          shouldCancelScraping = true;
          break;
        }
      }

      // Check if there are more pages
      hasNextPage = pageInfo?.has_next_page || false;
      endCursor = pageInfo?.end_cursor || '';

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
            try {
              sendProgress({
                current: allComments.length,
                total: totalCommentCount || allComments.length,
                percent: totalCommentCount ? Math.round((allComments.length / totalCommentCount) * 100) : 0,
                countdown: i,
                comments: allComments,
                postOwner: postOwner
              });
            } catch (error) {
              // Popup closed, cancel scraping
              console.log('Countdown update failed (popup closed), cancelling...');
              shouldCancelScraping = true;
              break;
            }
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

  console.log(`Finished fetching. Total comments: ${allComments.length}`);

  return {
    comments: allComments,
    postOwner: postOwner
  };
}
