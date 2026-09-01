// What the collector knows about each site it reads comments from.
//
// Everything platform-shaped lives here: how a URL names a post, how to rebuild a
// clean URL for one, which open tabs might be showing it, and the words the rest of
// the extension uses when it talks about the site. Adding a third platform should
// mean adding an entry to this table, not grepping the tree for "Instagram".

const PLATFORMS = {
  instagram: {
    id: 'instagram',
    name: 'Instagram',
    // What a post is called there, for sentences like "Open the post in a tab".
    post: 'post',
    csvPrefix: 'instagram-comments',
    tabPatterns: ['*://www.instagram.com/p/*', '*://www.instagram.com/reel/*'],
    // The kind is carried alongside the id because /p/ and /reel/ are not
    // interchangeable in a URL, and neither are /watch and /shorts.
    patterns: [
      { kind: 'p', re: /instagram\.com\/p\/([\w-]+)/ },
      { kind: 'reel', re: /instagram\.com\/reel\/([\w-]+)/ }
    ],
    canonical: (postId, kind) =>
      `https://www.instagram.com/${kind === 'reel' ? 'reel' : 'p'}/${postId}/`
  },
  youtube: {
    id: 'youtube',
    name: 'YouTube',
    post: 'video',
    csvPrefix: 'youtube-comments',
    tabPatterns: ['*://www.youtube.com/watch*', '*://www.youtube.com/shorts/*'],
    patterns: [
      { kind: 'watch', re: /youtube\.com\/watch\?(?:.*&)?v=([\w-]+)/ },
      { kind: 'watch', re: /youtu\.be\/([\w-]+)/ },
      { kind: 'shorts', re: /youtube\.com\/shorts\/([\w-]+)/ }
    ],
    canonical: (postId, kind) => kind === 'shorts'
      ? `https://www.youtube.com/shorts/${postId}`
      : `https://www.youtube.com/watch?v=${postId}`
  }
};

// Stands in when a run predates a platform or carries an id we no longer know, so
// callers can read .name and .post without guarding every use.
const UNKNOWN = {
  id: 'unknown',
  name: 'The source',
  post: 'post',
  csvPrefix: 'comments',
  tabPatterns: [],
  patterns: [],
  canonical: () => ''
};

/** The site, post id and URL shape a link points at, or null if it points at neither. */
export function parseTarget(url) {
  const text = String(url || '');
  for (const platform of Object.values(PLATFORMS)) {
    for (const { kind, re } of platform.patterns) {
      const match = text.match(re);
      if (match) return { platform: platform.id, postId: match[1], kind };
    }
  }
  return null;
}

/**
 * The URL for a post, rebuilt from what identifies it.
 *
 * A tab's URL carries things that are no part of the post's identity — YouTube's
 * playlist and start-time params, Instagram's img_index — and one thing that IS the
 * identity: YouTube's ?v=. Stripping the query wholesale loses the video; passing
 * the tab URL through hands the app a link full of noise. Rebuilding avoids both.
 */
export function canonicalUrl(target) {
  if (!target) return '';
  const platform = PLATFORMS[target.platform];
  return platform ? platform.canonical(target.postId, target.kind) : '';
}

/** Never null, so callers can read .name and .post without a guard. */
export function platformInfo(id) {
  return PLATFORMS[id] || UNKNOWN;
}

/** Tab query patterns for one platform, or for every platform when id is omitted. */
export function tabPatterns(id) {
  if (id === undefined) {
    return Object.values(PLATFORMS).flatMap(platform => platform.tabPatterns);
  }
  return platformInfo(id).tabPatterns;
}

/** "Instagram or YouTube" — for saying what a link was expected to be. */
export function supportedNames() {
  const names = Object.values(PLATFORMS).map(platform => platform.name);
  return names.length > 1
    ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`
    : names[0] || '';
}
