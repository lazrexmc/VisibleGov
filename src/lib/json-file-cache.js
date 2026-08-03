// src/lib/json-file-cache.js — the generic "read/write one JSON file by key in a directory,
// treating a missing or corrupt file as no-cache-yet" mechanism promoted out of
// src/cli/ingest-mo-senate.js's own private readCache/writeCache (senior engineering audit,
// 2026-08-03, finding 17). ingest-mo-house.js's readCachedBillList/writeCachedBillList used the
// SAME mechanism under a bill-list-specific shape and name — genuinely different callers with
// genuinely different cached-payload shapes (a single-purpose bill-list cache vs. senate's several
// different roster/index caches keyed generically), so only THIS shared low-level mechanism moves
// here; each CLI's own higher-level, shape-specific wrapper stays where it is.

import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';

function jsonCachePath(dir, key) {
  return `${dir}/${key}.json`;
}

// A corrupt/partial cache file must never crash a driver — treated as "no cache yet," the same
// recovery an operator gets by deleting the file by hand.
export function readJsonCache(dir, key) {
  const p = jsonCachePath(dir, key);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function writeJsonCache(dir, key, payload) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(jsonCachePath(dir, key), JSON.stringify({ fetched_at: new Date().toISOString(), ...payload }, null, 2));
}
