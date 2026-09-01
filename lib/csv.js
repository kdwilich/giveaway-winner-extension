// CSV export. Comment text routinely contains commas, quotes and newlines, so every
// field is quoted defensively rather than conditionally — cheaper to reason about,
// and it keeps naive line-splitting parsers from tearing rows apart.

import { platformInfo } from './platform.js';

const COLUMNS = [
  'comment_id',
  'username',
  'user_id',
  'comment_text',
  'timestamp',
  'profile_pic_url',
  'is_reply',
  'parent_id'
];

function escape(value) {
  if (value === null || value === undefined) return '""';
  return `"${String(value).replace(/"/g, '""')}"`;
}

export function toCSV(comments) {
  const rows = comments.map(c => COLUMNS.map(col => escape(c[col])).join(','));
  // CRLF is what RFC 4180 specifies and what spreadsheet apps expect.
  return [COLUMNS.join(','), ...rows].join('\r\n');
}

export function filename(platform, postId) {
  return `${platformInfo(platform).csvPrefix}-${postId || Date.now()}.csv`;
}

export async function download(csv, name) {
  const url = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  return chrome.downloads.download({ url, filename: name, saveAs: false });
}
