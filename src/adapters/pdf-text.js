import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

// Shared pdfjs-dist extraction core for every MO PDF consumer in this codebase. Extracted here
// (Task: MO bill-text fetcher, .superpowers/sdd/2026-07-31-mo-bill-texts/brief.md) because, before
// this refactor, mo-rollcall-pdf.js's extractRollCallText and mo-senate-journal-pdf.js's
// extractJournalText each carried their OWN byte-identical copy of both reconstructPageText and the
// getDocument/page-loop wiring — and the bill-text fetcher needed the exact same thing a third
// time. A third hand-copy of this exact pdfjs-dist setup is a review-rejectable defect per that
// brief; both existing files now import from here instead. This module owns ONLY the row-
// reconstruction algorithm and the pdfjs plumbing — nothing document-type-specific (no chrome-
// stripping, no vote-grammar parsing, no roll-call tally reconciliation — those stay in their own
// files, layered on top of this).

// pt tolerance for "same printed row" — same value/rationale both prior copies used: font-metric
// rounding on a shared visual line stays well under this; distinct printed rows are ~13pt apart in
// every real MO House/Senate PDF examined so far (roll-call grids, Senate journals).
const ROW_Y_EPSILON = 2;

// REAL-PDF FINDING (verified independently by both prior copies, against their own real fixtures):
// pdfjs-dist's own text-item STREAM order is not guaranteed to be reading order for every MO
// document type (the Senate journal's content stream interleaves some items out of visual order;
// the House roll-call grid's stream order happens to already be correct, but that is a property of
// how that PDF's generator wrote it, not a pdfjs-dist guarantee). Coordinate-based reconstruction —
// group items into rows by descending y (PDF y grows upward), sort each row left-to-right by x — is
// therefore required unconditionally, not a defensive redundancy.
export function reconstructPageText(items) {
  const visible = items.filter((it) => it.str !== '');
  const sorted = [...visible].sort((a, b) => b.transform[5] - a.transform[5]);
  const rows = [];
  for (const item of sorted) {
    const y = item.transform[5];
    const current = rows[rows.length - 1];
    if (current && Math.abs(current.y - y) <= ROW_Y_EPSILON) current.items.push(item);
    else rows.push({ y, items: [item] });
  }
  return rows
    .map((row) => row.items.slice().sort((a, b) => a.transform[4] - b.transform[4]).map((it) => it.str).join(''))
    .join('\n');
}

// pdfBuffer: a Buffer/Uint8Array/ArrayBuffer of raw PDF bytes (never a file path — callers decide
// whether that came from a local fixture read or a live fetch). Multi-page, joined page-by-page in
// document order, sequential (not Promise.all) so pages stay in reading order — same convention
// both prior copies used.
//
// Always rebuilt as a plain Uint8Array (never passed through as-is): pdfjs-dist explicitly rejects
// a Node Buffer ("Please provide binary data as Uint8Array, rather than Buffer") even though Buffer
// IS-A Uint8Array — new Uint8Array(x) is also the correct, safe conversion when x is already an
// ArrayBuffer (fetchWithLimit's `as: 'arrayBuffer'` return shape).
export async function extractPdfText(pdfBuffer) {
  const data = new Uint8Array(pdfBuffer);
  const doc = await getDocument({ data }).promise;
  const pageTexts = [];
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum += 1) {
    // eslint-disable-next-line no-await-in-loop -- sequential is deliberate; pages must stay in
    // document order, same precedent both prior copies of this loop used.
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();
    pageTexts.push(reconstructPageText(content.items));
  }
  return pageTexts.join('\n\n');
}
