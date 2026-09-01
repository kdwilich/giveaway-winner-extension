# Chrome Web Store listing

Published at
<https://chromewebstore.google.com/detail/lucky-pick-giveaway-comme/mdbbnaihbbejghdacehmepeanmmfennb>.

Copy for the developer dashboard. Plain text fields, no markdown rendering in the store,
so bullets are literal `•` characters.

---

## Name (max 45)

```
Lucky Pick - Giveaway Comment Collector
```

## Short description (max 132)

```
Collects every comment and reply on an Instagram or YouTube post and streams them into Lucky Pick to draw a giveaway winner.
```

## Category

Social & Communication (alternate: Workflow & Planning)

## Language

English (United States)

---

## Detailed description

```
Lucky Pick collects the comments on an Instagram post or YouTube video, replies included, and streams them into luckypick.win so you can draw a random winner.

The extension has no interface of its own. Click the icon and it opens Lucky Pick with your post already filled in. The app is where you set the rules and watch entries arrive.


WHY THIS ONE

Most giveaway pickers quietly miss entries. Tools built on Instagram's official API can only read posts you own, and they can't reach nested replies at all. Tools that need no login are complete but cap the free tier around 100 to 150 comments.

This one reads the post with your own logged in session, in your own browser, so it sees every comment you can see. No entry limit, no account, nothing to pay.


WHAT IT COLLECTS

• Instagram posts and Reels, YouTube videos and Shorts
• Full reply threads, not just the handful shown inline. On a tag-a-friend giveaway the replies are the entries.
• Username, user ID, comment text, timestamp, profile picture, and whether it's a reply


HOW IT BEHAVES ON A BIG POST

• Keeps running after you close the Lucky Pick tab, and reconnects mid run when you reopen it
• Resumes from the last checkpoint if Chrome shuts the extension down
• Spaces out requests and backs off on its own if the platform pushes back
• Re-run a post later and it picks up from the stored cursor, so topping up at the end of a giveaway only fetches what's new
• Progress shows in three places: the app, the toolbar badge, and a notification when the run ends


IT TELLS YOU WHAT IT MISSED

Every run ends with a receipt: how many comments came in against the platform's own reported total, how many were replies, how many unique people, how many requests it took, and how many had to be retried.

When those numbers disagree, it says so instead of rounding down. A gap is usually deleted accounts, private or blocked users, or spam-filtered comments, which count toward the post total but can't be read back.


PRIVACY

Nothing is uploaded. Comments are held in local storage on your machine and sent only to the luckypick.win tab you have open. No analytics, no external servers, no account.

The source is public: https://github.com/kdwilich/lucky-pick-extension


HOW TO USE IT

1. Open the post or video in a tab, signed in
2. Click the extension icon, which opens Lucky Pick with the post filled in
3. Hit Collect, then set your rules while it runs

If you close the post tab mid run, collection pauses and says so. Reopen it and resume.


A NOTE ON SPEED

A large post takes real time. Requests are deliberately spaced so a run reads like a person scrolling rather than a scraper. Anything promising ten thousand comments instantly is either serving a cached copy or not collecting all of them.

Not affiliated with Instagram, Meta, YouTube, or Google.
```

---

## Single purpose

```
Collect the comments on an Instagram or YouTube post the user opens, and send them to luckypick.win so the user can draw a giveaway winner from them.
```

## Permission justifications

**host_permissions: instagram.com, youtube.com**
```
The extension's only function is reading the comments on a post the user has open on these two sites. It fetches the comment list from the page's own comment endpoints, using the user's existing session, and needs host access to those origins to do it. It touches no other site.
```

**scripting**
```
Comment requests are executed inside the user's already-open Instagram or YouTube tab via chrome.scripting.executeScript, so they carry that tab's own session and origin. Fetching from the service worker instead would require sending the session cookie cross-origin, which those sites reject and which would be worse for the user's privacy.
```

**storage / unlimitedStorage**
```
Collected comments and the run's progress cursor are kept in chrome.storage.local so a collection survives the service worker being shut down and can resume from where it stopped. A large giveaway post can exceed the default 10MB storage quota, which is why unlimitedStorage is requested. Nothing is sent off the machine.
```

**alarms**
```
A watchdog alarm restarts an in-progress collection after Chrome terminates the service worker, which happens routinely on runs that take several minutes. Without it, a long collection would silently stall.
```

**notifications**
```
One notification when a collection finishes or stops, so the user doesn't have to keep the tab open and watch it.
```

**downloads**
```
Exporting the collected comments as a CSV file, at the user's request.
```

**Remote code**
```
No. All logic ships in the package. The extension makes network requests to Instagram and YouTube to read comment data, but does not load or execute any remote script.
```

## Data usage disclosures

- Personally identifiable information: **No** (usernames and comment text stay on the device and are never transmitted to the developer)
- Health, financial, authentication, personal communications, location, web history, user activity: **No**
- Website content: **Yes**, comment text from the post the user chooses. Not sold, not transferred, not used for anything except the user's own draw. Stays on device.
- Certify: not being sold to third parties, not used for unrelated purposes, not used for creditworthiness.

## Privacy policy URL

```
https://luckypick.win/privacy
```

---

## Assets checklist

- Icon 128x128 (have it: `icon128.png`)
- Screenshots 1280x800, up to 5. Suggested order:
  1. The app mid collection, entries streaming in, badge visible
  2. The collection receipt with collected vs reported total
  3. The rules panel (require tag, entry caps)
  4. Winners drawn, with the published seed
  5. The verifier replaying a draw record
- Small promo tile 440x280 (optional but improves placement)
