// Popup script - handles UI interaction
document.addEventListener('DOMContentLoaded', () => {
  const scrapeBtn = document.getElementById('scrapeBtn');
  const cancelBtn = document.getElementById('cancelBtn');
  const statusDiv = document.getElementById('status');
  const progressBar = document.getElementById('progressBar');
  const progressBarFill = document.getElementById('progressBarFill');
  const delaySlider = document.getElementById('delaySlider');
  const delayValue = document.getElementById('delayValue');
  let isProcessing = false;
  let currentComments = []; // Store fetched comments
  let currentPostOwner = null;
  
  // Check if there's a completed fetch waiting
  chrome.storage.local.get(['completedFetch'], (result) => {
    if (result.completedFetch) {
      const data = result.completedFetch;
      showStatus(`✓ Fetch completed! ${data.comments.length} comments ready.`, 'success');
      
      // Auto-download
      const csv = convertToCSV(data.comments);
      const filename = `instagram_comments_${Date.now()}.csv`;
      
      try {
        downloadCSV(csv, filename);
      } catch (error) {
        console.log('Auto-download cancelled or failed:', error);
      }
      
      // Clear the stored data
      chrome.storage.local.remove(['completedFetch']);
    }
  });
  
  // Update delay display when slider changes
  delaySlider.addEventListener('input', (e) => {
    delayValue.textContent = `${e.target.value}s`;
  });
  
  // Load saved delay setting
  if (chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['delaySeconds'], (result) => {
      if (result.delaySeconds) {
        delaySlider.value = result.delaySeconds;
        delayValue.textContent = `${result.delaySeconds}s`;
      }
    });
    
    // Save delay setting when changed
    delaySlider.addEventListener('change', (e) => {
      chrome.storage.local.set({ delaySeconds: parseInt(e.target.value) });
    });
  } else {
    console.error('chrome.storage is not available. Make sure the extension has storage permission and is properly loaded.');
  }
  
  // Listen for progress updates from content script
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'progress') {
      const { current, total, percent, countdown, comments, postOwner } = request.data;
      
      // Store current comments for potential cancellation
      if (comments) {
        currentComments = comments;
        currentPostOwner = postOwner;
      }
      
      // Calculate estimated time remaining (more conservative estimate)
      const delaySeconds = parseInt(delaySlider.value);
      const remainingPercent = 100 - percent;
      // Assume we're making steady progress, estimate based on percentage
      const estimatedSecondsRemaining = Math.ceil((remainingPercent / 100) * (delaySeconds * 20)); // Rough estimate
      const estimatedMinutes = Math.floor(estimatedSecondsRemaining / 60);
      const estimatedSeconds = estimatedSecondsRemaining % 60;
      
      let timeRemainingText = '';
      if (percent < 100) {
        if (estimatedMinutes > 0) {
          timeRemainingText = estimatedSeconds > 0 
            ? ` • ~${estimatedMinutes}m ${estimatedSeconds}s remaining` 
            : ` • ~${estimatedMinutes}m remaining`;
        } else if (estimatedSeconds > 5) {
          timeRemainingText = ` • ~${estimatedSeconds}s remaining`;
        }
      }
      
      // Update status message with exact counts and time estimate
      showStatus(`Fetched ${current} of ${total} comments${timeRemainingText}`, 'info');
      
      // Update button text with countdown
      scrapeBtn.textContent = countdown !== undefined 
        ? `Fetching... ${percent}% (next in ${countdown}s)` 
        : `Fetching... ${percent}%`;
      
      // Update progress bar
      progressBar.classList.add('visible');
      progressBarFill.style.width = `${percent}%`;
      
      // Don't return anything - we're not sending a response
      return;
    }
  });
  
  scrapeBtn.addEventListener('click', async () => {
    scrapeBtn.disabled = true;
    isProcessing = true;
    currentComments = [];
    currentPostOwner = null;
    scrapeBtn.textContent = 'Fetching... 0%';
    showStatus('Initializing... Please keep this window open.', 'info');
    
    // Show cancel button and disable slider
    cancelBtn.style.display = 'block';
    delaySlider.disabled = true;
    
    // Get settings
    const excludePoster = document.getElementById('excludePoster').checked;
    const delaySeconds = parseInt(delaySlider.value);
    
    try {
      // Get the active tab
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      // Check if we're on an Instagram post
      if (!tab.url.includes('instagram.com/p/')) {
        showStatus('Error: Please navigate to an Instagram post first!', 'error');
        resetButton();
        return;
      }
      
      showStatus('Starting to fetch comments via Instagram API...', 'info');
      
      // Inject content script if not already loaded
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js']
        });
      } catch (err) {
        // Content script may already be loaded, ignore error
        console.error('Content script injection:', err.message);
      }
      
      // Wait a bit for content script to initialize
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Send message to content script to scrape comments
      chrome.tabs.sendMessage(tab.id, { 
        action: 'scrapeComments', 
        excludePoster,
        delaySeconds 
      }, (response) => {
        console.log('Received response from content script:', response);
        
        if (chrome.runtime.lastError) {
          console.error('Chrome runtime error:', chrome.runtime.lastError);
          showStatus(`Error: ${chrome.runtime.lastError.message}. Try refreshing the page and reopening the extension.`, 'error');
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
            showStatus('No comments found. Try: 1) Scroll down more 2) Click "View replies" 3) Wait for page to load fully', 'error');
            resetButton();
            return;
          }
          
          // Convert to CSV and download
          const csv = convertToCSV(comments);
          const filename = `instagram_comments_${Date.now()}.csv`;
          
          // Download - note this may fail if user cancels, but that's ok
          try {
            downloadCSV(csv, filename);
            showStatus(`✓ Successfully scraped ${comments.length} comments!`, 'success');
          } catch (error) {
            console.log('Download cancelled or failed:', error);
            showStatus(`✓ Scraped ${comments.length} comments (download cancelled)`, 'success');
          }
          
          // Keep success message visible longer
          setTimeout(() => {
            resetButton();
          }, 2000);
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
    
    // Get the active tab and send cancel message
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    chrome.tabs.sendMessage(tab.id, { action: 'cancelScrape' });
    
    // Wait a moment for cancellation to process
    await new Promise(resolve => setTimeout(resolve, 500));
    
    if (currentComments.length > 0) {
      // Offer to download partial results
      const excludePoster = document.getElementById('excludePoster').checked;
      let comments = currentComments;
      
      // Filter post owner if checkbox is checked
      if (excludePoster && currentPostOwner) {
        comments = comments.filter(c => c.username !== currentPostOwner);
      }
      
      // Convert to CSV and download
      const csv = convertToCSV(comments);
      downloadCSV(csv, `instagram_comments_partial_${Date.now()}.csv`);
      
      showStatus(`⚠️ Cancelled. Downloaded ${comments.length} partial comments.`, 'success');
    } else {
      showStatus('Cancelled. No comments fetched yet.', 'error');
    }
    
    resetButton();
  });
  
  function showStatus(message, type) {
    statusDiv.textContent = message;
    statusDiv.className = `status visible ${type}`;
  }
  
  function resetButton() {
    scrapeBtn.disabled = false;
    scrapeBtn.textContent = 'Fetch All Comments & Download CSV';
    isProcessing = false;
    progressBar.classList.remove('visible');
    progressBarFill.style.width = '0%';
    cancelBtn.style.display = 'none';
    cancelBtn.disabled = false;
    cancelBtn.textContent = 'Cancel Fetch';
    delaySlider.disabled = false;
    currentComments = [];
    currentPostOwner = null;
  }
  
  function convertToCSV(comments) {
    // CSV header
    const header = ['username', 'comment_text', 'timestamp', 'is_reply'];
    
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
      escapeCSV(comment.username),
      escapeCSV(comment.comment_text),
      escapeCSV(comment.timestamp),
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
