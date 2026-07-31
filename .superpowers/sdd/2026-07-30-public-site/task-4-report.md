# Task 4 report — summary-parse: one shared parser, one-liner extraction

**Status:** done

**Commit:** 18712287a8a39f9cf147601eed5bf9a90e8b1c1d

**Tests:** full suite green, 1292/1292 passing (1284 baseline + 8 new in tests/summary-parse.test.js), 0 failures.

**Concerns:** none. `parseBullets` moved verbatim (function + its load-bearing "LAST ' (' split" comment block) to `site/js/summary-parse.js`; `src/cli/verify.js` now does `import { parseBullets } from '../../site/js/summary-parse.js'; export { parseBullets };` and is otherwise unchanged (`countRawBulletLines`, `checkBulletCoverage`, etc. stayed put). `site/js/summary-parse.js` is browser-clean (pure functions, zero imports, no Node APIs). `extractOneLiner` is not yet wired into any HTML page — that's out of this task's scope per the brief (files list is parser + verify.js + test only).
