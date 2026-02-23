// Side panel script - handles UI interaction
document.addEventListener('DOMContentLoaded', () => {
  const scrapeBtn = document.getElementById('scrapeBtn');
  const cancelBtn = document.getElementById('cancelBtn');
  const redownloadBtn = document.getElementById('redownloadBtn');
  const statusDiv = document.getElementById('status');
  const progressBar = document.getElementById('progressBar');
  const progressBarFill = document.getElementById('progressBarFill');
  const delaySlider = document.getElementById('delaySlider');
  const delayValue = document.getElementById('delayValue');
  const instructionsToggle = document.getElementById('instructionsToggle');
  const instructionsContent = document.getElementById('instructionsContent');
  const instagramUrlInput = document.getElementById('instagramUrl');
  const urlError = document.getElementById('urlError');
  let isProcessing = false;
  let scrapingTabId = null; // Track which tab is running the scrape
  let currentComments = []; // Store fetched comments
  let currentPostOwner = null;
  let lastDownloadedComments = []; // Store last successful download for re-download
  let lastDownloadFilename = ''; // Store last filename
  let scrapeStartTime = null; // Track when scraping started
  
  // Toggle instructions section
  instructionsToggle.addEventListener('click', () => {
    instructionsToggle.classList.toggle('collapsed');
    instructionsContent.classList.toggle('collapsed');
  });
  
  // Update slider progress fill
  const updateSliderProgress = () => {
    const value = ((delaySlider.value - delaySlider.min) / (delaySlider.max - delaySlider.min)) * 100;
    delaySlider.style.setProperty('--range-progress', `${value}%`);
  };
  
  // Initialize slider progress
  updateSliderProgress();
  
  // Auto-fill URL from current tab
  let userManuallyEdited = false; // True once user types/pastes in the input
  
  const autoFillUrl = async () => {
    if (isProcessing || userManuallyEdited) return;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.url && tab.url.match(/instagram\.com\/p\//)) {
        instagramUrlInput.value = tab.url.split('?')[0]; // Strip query params
        validateUrl();
      }
    } catch (e) {
      console.log('Could not auto-fill URL:', e);
    }
  };
  autoFillUrl();
  
  // Stop auto-filling once the user manually edits the input
  // If the user clears the input, resume auto-filling
  instagramUrlInput.addEventListener('input', () => {
    userManuallyEdited = instagramUrlInput.value.trim().length > 0;
  });
  
  // Re-fill URL when tab changes
  chrome.tabs.onActivated.addListener(() => autoFillUrl());
  
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.url) autoFillUrl();
  });
  
  // URL validation
  function validateUrl() {
    const url = instagramUrlInput.value.trim();
    instagramUrlInput.classList.remove('valid', 'invalid');
    urlError.classList.remove('visible');
    urlError.textContent = '';
    
    if (!url) {
      return false;
    }
    
    if (!url.match(/instagram\.com\/p\/[\w-]+/)) {
      instagramUrlInput.classList.add('invalid');
      urlError.textContent = 'Must be an Instagram post URL (e.g. instagram.com/p/ABC123)';
      urlError.classList.add('visible');
      return false;
    }
    
    return true;
  }
  
  instagramUrlInput.addEventListener('input', validateUrl);
  instagramUrlInput.addEventListener('blur', validateUrl);
  
  // Check if there's a completed fetch waiting (from previous session)
  chrome.storage.local.get(['completedFetch'], (result) => {
    if (result.completedFetch) {
      const data = result.completedFetch;
      showStatus(`✓ Fetch completed! ${data.comments.length} comments ready to download.`, 'success');
      
      // Store for manual download
      lastDownloadedComments = data.comments;
      lastDownloadFilename = `instagram_comments_${Date.now()}.csv`;
      redownloadBtn.textContent = 'Download CSV';
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
  let statusMainLine = '';
  let rollingLatencyMs = 500; // Initial estimate; refined by actual response times

  // Rebuild the status display from stored state (called by both the interval and progress handler)
  const rebuildStatus = () => {
    let lines = statusMainLine;
    if (displayCountdown > 0) {
      lines += `\n\u2022 Next request in ${displayCountdown}s`;
    }
    const secs = Math.round(estimatedSecondsRemaining);
    if (secs > 1) {
      const mins = Math.floor(secs / 60);
      const rem = secs % 60;
      if (mins > 0) {
        lines += rem > 0 ? `\n\u2022 ~${mins}m ${rem}s remaining` : `\n\u2022 ~${mins}m remaining`;
      } else {
        lines += `\n\u2022 ~${rem}s remaining`;
      }
    }
    showStatus(lines, 'info');
  };

  // Listen for progress updates from content script
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'progress') {
      const { current, total, percent, countdown, comments, postOwner, avgLatencyMs } = request.data;
      
      // Ensure UI is in processing state (handles tab switches)
      if (!isProcessing) {
        isProcessing = true;
        scrapeBtn.style.display = 'none';
        cancelBtn.style.display = 'block';
        cancelBtn.disabled = false;
        cancelBtn.textContent = 'Cancel Fetch';
        delaySlider.disabled = true;
        document.getElementById('excludePoster').disabled = true;
        redownloadBtn.style.display = 'none';
        progressBar.classList.add('visible');
        // Track the tab that sent this progress
        if (sender?.tab?.id) {
          scrapingTabId = sender.tab.id;
        }
      }
      
      // Store current comments for potential cancellation
      if (comments) {
        currentComments = comments;
        currentPostOwner = postOwner;
      }

      // Update rolling latency estimate (exponential moving average)
      if (avgLatencyMs != null) {
        rollingLatencyMs = rollingLatencyMs * 0.7 + avgLatencyMs * 0.3;
      }
      const delaySeconds = parseInt(delaySlider.value);
      const commentsPerRequest = 50;
      const remainingComments = Math.max(0, total - current);
      const remainingRequests = Math.ceil(remainingComments / commentsPerRequest);
      const latencySeconds = rollingLatencyMs / 1000;

      // Update shared state used by the interval ticker
      statusMainLine = `Fetched ${current} of ${total} comments (${percent}%)`;
      if (countdown !== undefined && percent < 100) {
        displayCountdown = countdown;
        // Time = this countdown + latency for the upcoming fetch + remaining full cycles after that
        estimatedSecondsRemaining = countdown + latencySeconds
          + Math.max(0, remainingRequests - 1) * (delaySeconds + latencySeconds);
      } else {
        displayCountdown = 0;
        estimatedSecondsRemaining = remainingRequests * (delaySeconds + latencySeconds);
      }

      // Start the interval once; it ticks every second independently of message arrival
      if (!timerInterval && isProcessing) {
        timerInterval = setInterval(() => {
          if (!isProcessing) {
            clearInterval(timerInterval);
            timerInterval = null;
            return;
          }
          estimatedSecondsRemaining = Math.max(0, estimatedSecondsRemaining - 1);
          if (displayCountdown > 0) displayCountdown = Math.max(0, displayCountdown - 1);
          rebuildStatus();
        }, 1000);
      }

      rebuildStatus();

      // Update progress bar
      progressBar.classList.add('visible');
      progressBarFill.style.width = `${percent}%`;
    }
  });
  
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
    showStatus('Initializing...', 'info');
    
    // Validate URL input
    const instagramUrl = instagramUrlInput.value.trim();
    
    if (!instagramUrl) {
      instagramUrlInput.classList.add('invalid');
      urlError.textContent = 'Please enter an Instagram post URL';
      urlError.classList.add('visible');
      showStatus('Error: Please enter an Instagram post URL.', 'error');
      resetButton();
      instagramUrlInput.focus();
      return;
    }
    
    if (!validateUrl()) {
      showStatus('Error: Invalid Instagram post URL.', 'error');
      resetButton();
      instagramUrlInput.focus();
      return;
    }
    
    // Hide re-download button when starting new fetch
    redownloadBtn.style.display = 'none';
    
    // Show cancel button and disable slider, checkbox, and URL input
    cancelBtn.style.display = 'block';
    delaySlider.disabled = true;
    document.getElementById('excludePoster').disabled = true;
    instagramUrlInput.disabled = true;
    
    // Get settings
    const excludePoster = document.getElementById('excludePoster').checked;
    const delaySeconds = parseInt(delaySlider.value);
    
    try {
      // Find the Instagram tab to run the content script on
      // Helper: try to ping a tab's content script
      const ping = (tabId) => new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, { action: 'ping' }, (response) => {
          if (chrome.runtime.lastError || !response?.alive) resolve(false);
          else resolve(true);
        });
      });

      // Helper: try to inject content script into a tab and verify it's alive
      const tryTab = async (targetTab) => {
        if (!targetTab?.id || !targetTab.url?.includes('instagram.com')) return false;
        // Skip tabs showing error pages
        if (targetTab.status !== 'complete' && targetTab.status !== 'loading') return false;

        // Already alive?
        if (await ping(targetTab.id)) return true;

        // Try injecting
        try {
          await chrome.scripting.executeScript({ target: { tabId: targetTab.id }, files: ['content.js'] });
          await new Promise(resolve => setTimeout(resolve, 500));
          return await ping(targetTab.id);
        } catch (err) {
          console.log(`Injection failed on tab ${targetTab.id} (${targetTab.url}):`, err.message);
          return false;
        }
      };

      showStatus('Starting to fetch comments via Instagram API...', 'info');

      // Strategy: try multiple tabs until one works
      let tab = null;

      // 1. Try to find a tab matching the exact shortcode
      const matchingTabs = await chrome.tabs.query({ url: '*://www.instagram.com/p/*' });
      const targetShortcode = instagramUrl.match(/\/p\/([\w-]+)/)?.[1];

      if (targetShortcode) {
        const exactMatch = matchingTabs.find(t => t.url.includes(`/p/${targetShortcode}`));
        if (exactMatch && await tryTab(exactMatch)) {
          tab = exactMatch;
        }
      }

      // 2. Fallback: try the active tab (user might have the post open there)
      if (!tab) {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTab?.url?.includes('instagram.com') && await tryTab(activeTab)) {
          tab = activeTab;
        }
      }

      // 3. Fallback: try ANY open Instagram post tab
      if (!tab) {
        for (const candidate of matchingTabs) {
          if (await tryTab(candidate)) {
            tab = candidate;
            break;
          }
        }
      }

      if (!tab) {
        showStatus('⚠️ Could not connect to any Instagram tab. Please make sure you have the Instagram post open and refresh the page, then try again.', 'error');
        resetButton();
        return;
      }

      // Content script is confirmed alive — send the scrape request
      scrapingTabId = tab.id;
      chrome.tabs.sendMessage(tab.id, {
        action: 'scrapeComments',
        excludePoster,
        delaySeconds,
        instagramUrl
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.error('Chrome runtime error:', chrome.runtime.lastError);
          showStatus('⚠️ Lost connection to Instagram tab. Please refresh the Instagram page and try again.', 'error');
          resetButton();
          return;
        }
        
        if (response && response.success) {
          console.log('Success! Processing', response.comments.length, 'comments');
          let comments = response.comments;
          
          // Filter post owner if checkbox is checked
          if (excludePoster && response.postOwner) {
            comments = comments.filter(c => c.username !== response.postOwner);
          }
          
          if (comments.length === 0) {
            showStatus('No comments found. Try refreshing the Instagram page.', 'error');
            resetButton();
            return;
          }
          
          // Convert to CSV and download
          const csv = convertToCSV(comments);
          const filename = `instagram_comments_${Date.now()}.csv`;
          
          // Store for re-download
          lastDownloadedComments = comments;
          lastDownloadFilename = filename;
          
          // Calculate and display duration
          let durationText = '';
          if (scrapeStartTime) {
            const elapsed = Math.round((Date.now() - scrapeStartTime) / 1000);
            const mins = Math.floor(elapsed / 60);
            const secs = elapsed % 60;
            durationText = mins > 0 
              ? ` (took ${mins}m ${secs}s)` 
              : ` (took ${secs}s)`;
          }
          showStatus(`✓ Successfully scraped ${comments.length} comments!${durationText}`, 'success');
          
          // Show re-download button
          redownloadBtn.textContent = 'Download CSV';
          redownloadBtn.style.display = 'block';
          
          // Keep success message visible longer
          setTimeout(() => {
            resetButton();
          }, 3000);
        } else {
          showStatus(`Error: ${response?.error || 'Unknown error'}`, 'error');
          resetButton();
        }
        });
    } catch (error) {
      showStatus(`Error: ${error.message}`, 'error');
      resetButton();
    }
  });
  
  cancelBtn.addEventListener('click', async () => {
    if (!isProcessing) return;
    
    cancelBtn.disabled = true;
    cancelBtn.textContent = 'Cancelling...';
    
    // Send cancel to the tab that's actually running the scrape
    const tabId = scrapingTabId;
    if (tabId) {
      chrome.tabs.sendMessage(tabId, { action: 'cancelScrape' });
    } else {
      // Fallback: try active tab
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      chrome.tabs.sendMessage(tab.id, { action: 'cancelScrape' });
    }
    
    // Wait a moment for cancellation to process
    await new Promise(resolve => setTimeout(resolve, 500));
    
    if (currentComments.length > 0) {
      // Store partial results but don't download yet
      const excludePoster = document.getElementById('excludePoster').checked;
      let comments = currentComments;
      
      // Filter post owner if checkbox is checked
      if (excludePoster && currentPostOwner) {
        comments = comments.filter(c => c.username !== currentPostOwner);
      }
      
      // Store for download on button press
      lastDownloadedComments = comments;
      lastDownloadFilename = `instagram_comments_partial_${Date.now()}.csv`;
      
      showStatus(`⚠️ Cancelled. ${comments.length} partial comments ready to download.`, 'success');
      
      // Show download button
      redownloadBtn.textContent = 'Download CSV';
      redownloadBtn.style.display = 'block';
    } else {
      showStatus('Cancelled. No comments fetched yet.', 'error');
    }
    
    resetButton();
  });
  
  // Re-download button handler
  redownloadBtn.addEventListener('click', () => {
    if (lastDownloadedComments.length > 0) {
      const csv = convertToCSV(lastDownloadedComments);
      downloadCSV(csv, lastDownloadFilename);
      showStatus(`✓ Re-downloaded ${lastDownloadedComments.length} comments!`, 'success');
    }
  });
  
  function showStatus(message, type) {
    statusDiv.textContent = message;
    statusDiv.className = `status visible ${type}`;
  }
  
  function resetButton() {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    estimatedSecondsRemaining = 0;
    displayCountdown = 0;
    statusMainLine = '';
    scrapeBtn.style.display = '';
    scrapeBtn.disabled = false;
    scrapeBtn.textContent = 'Fetch Comments';
    isProcessing = false;
    scrapingTabId = null;
    progressBar.classList.remove('visible');
    progressBarFill.style.width = '0%';
    cancelBtn.style.display = 'none';
    cancelBtn.disabled = false;
    cancelBtn.textContent = 'Cancel Fetch';
    delaySlider.disabled = false;
    document.getElementById('excludePoster').disabled = false;
    instagramUrlInput.disabled = false;
    currentComments = [];
    currentPostOwner = null;
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
      saveAs: true
    }, () => {
      if (chrome.runtime.lastError) {
        console.error('Download error:', chrome.runtime.lastError);
      }
    });
  }
});
