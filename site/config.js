// site/config.js — Supabase project config for the public site.
//
// LANCE GATE (task-3 brief, .superpowers/sdd/2026-07-30-public-site/task-3-brief.md, Step 5):
// Lance pastes the real project URL and the anon (publishable) key here — the same anon key that
// scripts/probe-public-surface.js already verified against migration 0016's public read surface.
// The anon key is PUBLIC BY DESIGN once pasted (design spec §1: "Anon Supabase key + RLS is the
// entire security wall") — RLS policies are what actually protect the data, not secrecy of this
// value. Until Lance pastes real values, these stay empty strings on purpose: site/js/rest.js
// fails loud with a typed ConfigError on an empty config rather than silently sending an empty
// apikey header and getting back a 401 that would look identical to "the anon policy denies this."
export const SUPABASE_URL = '';
export const SUPABASE_ANON_KEY = '';
