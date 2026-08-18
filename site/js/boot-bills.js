// site/js/boot-bills.js — bills.html's bootstrap, as an EXTERNAL module (same CSP rationale as
// boot-directory.js: `script-src 'self'` forbids inline module blocks).
import { bootstrapBillsPage } from './bills-page.js';

bootstrapBillsPage();
