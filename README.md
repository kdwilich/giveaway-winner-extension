# Instagram Comment Scraper Chrome Extension

Export Instagram comments to CSV for use with the [Giveaway Picker](https://giveaway-winner.vercel.app/).

> **📢 Coming Soon to Chrome Web Store!**  
> We're currently working on publishing this extension to the Chrome Web Store. In the meantime, you can install it locally by following the instructions below.

## ✨ Features

- 🚀 **Fast & Reliable** - Uses Instagram's official GraphQL API
- 📊 **Complete Data** - Fetches ALL comments including nested replies
- ⚡ **Progress Tracking** - Real-time progress bar with countdown timer
- ⚙️ **Customizable Rate Limiting** - Adjust delay between requests (5-30 seconds)
- 📥 **CSV Export** - One-click download with proper formatting
- 🔒 **Privacy First** - All processing happens locally in your browser

## 📦 Installation

### Local Installation (Until Chrome Web Store Listing is Live)

1. **Download the extension files**
   - Clone this repository: `git clone https://github.com/kdwilich/giveaway-app-extension.git`
   - Or download the ZIP and extract it

2. **Open Chrome Extensions page**
   - Navigate to `chrome://extensions/`
   - Or click the three dots menu → More Tools → Extensions

3. **Enable Developer Mode**
   - Toggle the switch in the top-right corner

4. **Load the extension**
   - Click "Load unpacked"
   - Navigate to and select the repository folder (or the extracted folder)

5. **Verify installation**
   - The "Instagram Comment Scraper" icon should appear in your Chrome toolbar
   - If you don't see it, click the puzzle icon and pin it

## 🎯 How to Use

1. **Navigate to any Instagram post** (e.g., `https://www.instagram.com/p/ABC123xyz/`)
2. **Make sure you're logged into Instagram**
3. **Click the extension icon** in your Chrome toolbar
4. **Adjust settings** (optional):
   - ✅ Exclude post owner's comments
   - ⏱️ Set delay between requests (1-20 seconds, default: 10s)
5. **Click "Fetch All Comments & Download CSV"**
6. **Keep the popup window open** while fetching
7. **CSV file downloads automatically** when complete

## ⚙️ Settings

### Rate Limiting
- **Default:** 10 seconds between requests
- **Range:** 1-20 seconds
- **Recommendation:** Keep at 10s to avoid Instagram rate limiting
- Lower values = faster but riskier

### Exclude Post Owner
- Automatically filters out comments from the post creator
- Useful for giveaways where the host shouldn't win

## 📋 CSV Format

| Column | Description |
|--------|-------------|
| `username` | Instagram username of commenter |
| `comment_text` | Full text of the comment |
| `timestamp` | ISO 8601 timestamp |
| `is_reply` | Boolean indicating if it's a nested reply |

## 🔧 Technical Details

- **API:** Instagram GraphQL API (`query_hash: bc3296d1ce80a24b1b6e40b1e72903f5`)
- **Batch Size:** 50 comments per request
- **Authentication:** Uses your Instagram session cookies

## 🚨 Troubleshooting

### "Error: Could not extract post shortcode from URL"
- Make sure you're on an Instagram post page (`/p/SHORTCODE`)

### "Instagram API returned 401"
- You're not logged into Instagram
- Refresh the page and log in

### Extension icon is greyed out
- Only works on `instagram.com/p/*` pages
- Refresh the page

## 📄 Privacy

- ✅ No data collection
- ✅ All processing is local
- ✅ No external servers

## 🔗 Related

- [Giveaway Picker](https://giveaway-winner.vercel.app/)
- [GitHub Repo](https://github.com/kdwilich/giveaway-winner)
