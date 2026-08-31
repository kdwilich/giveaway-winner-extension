# Comment Collector

Collects every comment on an Instagram post or YouTube video — **including replies** — and
streams them straight into [Lucky Pick](https://luckypick.win/) for the draw.

The extension has no interface of its own. It is a data pipe: the app is where you set
everything up and watch the results arrive.

## Why an extension at all

A web page can't do this. Instagram sends no `Access-Control-Allow-Origin` for
`luckypick.win`, so the browser makes the request and then refuses to let the page read the
response; and Safari and Firefox won't attach the session cookie to a cross-site request in
the first place. An extension's `host_permissions` is the mechanism that exempts from both.

Doing it server-side would mean handing a server your `sessionid` — a full account-takeover
token — and then replaying your residential session from a datacenter IP, which is the
loudest bot signature there is. So the fetching happens here, in your browser, on your
connection, and nothing is transmitted anywhere.

## Install

1. `git clone https://github.com/kdwilich/giveaway-winner-extension`
2. Open `chrome://extensions`, turn on **Developer mode**
3. **Load unpacked**, select the folder
4. Copy the extension ID that appears

Unpacked builds get a random ID, so for local development tell the app which one to talk to:

```js
localStorage.setItem('collectorExtensionId', 'PASTE_THE_ID_HERE')
```

In production the ID goes in `NEXT_PUBLIC_EXTENSION_ID` on the app.

> `externally_connectable` requires a real second-level domain, so `localhost` will not
> work. For local app development, add `127.0.0.1 dev.luckypick.win` to `/etc/hosts`, add
> `"http://dev.luckypick.win/*"` to the `externally_connectable.matches` array, and serve
> the app there.

## Use

1. Open the post or video in a tab and make sure you're logged in
2. Click the extension icon — it opens [luckypick.win](https://luckypick.win/) with that
   post already filled in
3. Hit **Collect**

The URL box fills itself from whichever post you have open, so you shouldn't have to paste
anything. If it's empty, use "Check again" — that usually means no post tab is open.

Progress shows in three places, so you don't have to babysit any of them:

| Where | What it shows |
|---|---|
| The app tab | Live counts, retries, and entries streaming in as they arrive |
| The toolbar badge | Percent complete, visible from any tab |
| A notification | Fires when the run finishes or stops |

Close the app tab and collection keeps going. Reopen it and it reconnects mid-run. If the
worker is torn down, a watchdog alarm resumes it from the last checkpoint.

If you close the **post** tab, the run pauses and says so — reopen it and hit resume.

## What it collects

Instagram inlines only the first few replies per thread, and YouTube doesn't include replies
at all unless you ask. Both are expanded here, because on a tag-a-friend giveaway the replies
*are* the entries.

CSV columns: `comment_id`, `username`, `user_id`, `comment_text`, `timestamp`,
`profile_pic_url`, `is_reply`, `parent_id`.

## Completeness

Every run ends with a receipt: collected vs. the platform's own reported total, top-level vs.
replies, unique people, requests made, how many were retried, and how long it took.

When the numbers disagree the app says so rather than rounding down. A gap is usually deleted
accounts, private or blocked users, or spam-filtered comments — all counted in the post total
but not readable back. If a reply thread couldn't be expanded, that's reported too.

## Pacing

Requests start about 2.5 seconds apart with jitter, back off exponentially on a 429, and
drift back toward the base rate once things are clean. A fixed interval is a cleaner machine
signature than a varied one, so there's deliberately no "delay" slider any more.

Re-running a post you've already collected resumes from the stored cursor, so topping up at
the end of a giveaway only fetches what's new.

## Layout

```
manifest.json      permissions, externally_connectable, content script
background.js      the engine: lifecycle, ports, badge, notifications, watchdog
content.js         the in-page progress pill (closed shadow root, read-only overlay)
lib/store.js       chrome.storage state — the single source of truth
lib/pace.js        jitter, adaptive backoff, retry
lib/instagram.js   GraphQL pagination + reply thread expansion
lib/youtube.js     InnerTube pagination + reply continuations
lib/csv.js         RFC 4180 export
```

## Known risk

Instagram's comment endpoint is undocumented and moves. If the query hash goes stale the run
fails loudly with "the query hash is probably stale" rather than quietly reporting zero
comments — but it will still need a new hash. Current guidance is that Instagram is migrating
to `POST /graphql/query` with a `doc_id`; that fallback isn't implemented yet.

## Privacy

No data collection, no external servers, no analytics. Comments are held in
`chrome.storage.local` on your machine and sent only to the luckypick.win tab you have open.
