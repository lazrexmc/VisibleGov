// site/js/boot-directory.js — index.html's bootstrap, as an EXTERNAL module.
//
// Final-review fix wave (defense in depth alongside site/_headers): this was an inline
// `<script type="module">` block in index.html. A Content-Security-Policy of `script-src 'self'`
// blocks inline script, and the two ways to keep an inline block — 'unsafe-inline' (which
// re-opens the exact injected-script class the CSP exists to close) or a per-block sha256 hash
// (which silently breaks the page the first time anyone edits a character of it) — are both
// worse than a two-line file. Every page shell now loads its bootstrap this way.
import { bootstrapDirectoryPage } from './directory-page.js';

bootstrapDirectoryPage();
