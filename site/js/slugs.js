// site/js/slugs.js — the ONE slug scheme for the whole site (fix round 1, LOW-8). Browser-native
// ES module, zero imports.
//
// Moved out of site/js/person-page.js (task 8's fix round): directory-page.js is the site's front
// door (site/index.html) and only ever needed this one tiny function from person-page.js — but
// importing it FROM person-page.js pulled in that page's entire module graph (mountProfile,
// vote-charts.js, receipts.js, summary-parse.js, profile-model.js, ...) just to slugify a name,
// bloating the front door's own import graph for code the directory never uses. person-page.js
// imports it from here too now — one implementation, not a re-export shim, not a third scheme
// (task-6-report.md flagged inventing a third slug scheme as the thing to avoid).
export function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'x';
}
