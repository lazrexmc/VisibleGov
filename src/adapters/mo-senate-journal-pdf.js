import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

// Task 4: MO Senate whole-day journal PDF -> multiple recorded votes in one document (unlike
// mo-rollcall-pdf.js's mo-house-xml.js sibling, which parses ONE roll call per PDF). Architecture
// (pdfjs-dist legacy-build extraction, RollCallParseError-shaped error class, reconcile-or-throw
// integrity gate, fail-loud resolution) is ported from mo-rollcall-pdf.js; the parsing grammar
// itself (multi-vote-block scanning, category headers, bill-ref extraction) is new - the Senate
// journal is flowing justified prose describing a whole legislative day, not a single roll-call
// grid. See task-4-brief.md and its appended CONTROLLER RULINGS for the governing spec.

export class JournalParseError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'JournalParseError';
    Object.assign(this, meta);
  }
}

// ---- text extraction ----
//
// Same Uint8Array-conversion / sequential-pages pattern as mo-rollcall-pdf.js's
// extractRollCallText (see that file's own comment for why: pdfjs-dist's LEGACY build is the
// Node-safe one, and Buffer must be rebuilt as a plain Uint8Array because pdfjs-dist rejects a
// Node Buffer even though Buffer IS-A Uint8Array).
//
// REAL-PDF FINDING (CONTROLLER RULING 4, verified against BOTH real fixtures -
// tests/fixtures/research/mo-senate/2018-day37-journal-onder-era.pdf and
// .../2026-day39-journal.pdf): unlike mo-rollcall-pdf.js's 4-column grid PDF (where plain
// stream-order concatenation happened to already match coordinate-based row reconstruction),
// these journal PDFs' own text-item stream order is NOT reading order. Empirical test: searching
// for the vote-block anchor phrase "by the following vote:" (tolerant of an internal line-wrap)
// finds all 13 blocks in Day 37 and all 11 in Day 39 when text is reconstructed by row (grouping
// items into rows by descending y, sorting each row left-to-right by x - exactly
// reconstructPageText below) - but plain stream-order concatenation of the SAME items finds only
// 9 of 13 in Day 37 and 9 of 11 in Day 39 (the underlying content stream interleaves some items
// out of visual order, splitting "following" and "vote" across unrelated intervening text so the
// literal phrase never appears contiguously). Coordinate-based reconstruction is therefore
// REQUIRED for this document type, not a defensive redundancy - confirmed by running both
// extraction strategies against both real fixtures and counting anchor matches before writing any
// parsing logic (see task-4-report.md for the exact counts).
const ROW_Y_EPSILON = 2; // pt tolerance for "same printed row" - same value/rationale as
// mo-rollcall-pdf.js's reconstructPageText (font-metric rounding on a shared visual line stays
// well under this, distinct printed rows are ~13pt apart).

function reconstructPageText(items) {
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

// REAL-PDF FINDING (task-4-report.md): every page of both real fixtures carries running chrome -
// a bare page-number line (e.g. '587'), a 'Journal of the Senate <N>' header/footer (with the
// number sometimes glued directly on with no space: '588Journal of the Senate'), and a
// '<Ordinal> Day<dash><Weekday>, <Month> <D>, <Year>' running header (em-dash-tight in the 2018
// fixture, 'THIRTY-SEVENTH DAY—THURSDAY, MARCH 8, 2018'; hyphen-with-spaces in the 2026 fixture,
// '773 Thirty-Ninth Day - Wednesday, March 25, 2026'). This is invisible almost everywhere - EXCEPT
// when a vote block's own name-list wraps across a page boundary (real, confirmed: Day 37 block 4's
// YEAS list splits mid-run, and the reconstructed text for that page break literally reads
// '...Riddle Rizzo\n\nThirty-Seventh Day—Thursday, March 8, 2018 591\nRomine Rowden...') - the
// interstitial chrome then gets tokenized as 4 bogus surnames (Thirty-Seventh/Day/Thursday/March),
// breaking the reconcile gate (35 parsed vs 31 printed - this was caught only by running the real
// parser against the real fixture, not asserted a priori). Stripped once here, globally, so
// parseJournalVotes never has to reason about page boundaries at all.
const PAGE_NUMBER_ONLY_RE = /^\d+$/;
const JOURNAL_HEADER_RE = /Journal of the Senate/i;
const DAY_HEADER_RE = /\b[A-Za-z-]+\s+Day[—-]\s*[A-Za-z]+,\s+[A-Za-z]+\s+\d{1,2},\s*\d{4}\b/i;

function stripPageChrome(text) {
  return text
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (trimmed === '') return true; // blank lines are page/paragraph separators, not chrome
      if (PAGE_NUMBER_ONLY_RE.test(trimmed)) return false;
      if (JOURNAL_HEADER_RE.test(trimmed)) return false;
      if (DAY_HEADER_RE.test(trimmed)) return false;
      return true;
    })
    .join('\n');
}

// pdfBuffer: a Buffer/Uint8Array/ArrayBuffer of raw PDF bytes (never a file path - see
// mo-rollcall-pdf.js's identical parameter comment). Multi-page (these journals run 20-25+ pages
// for a busy day) joined page-by-page in document order, sequential (not Promise.all) so pages
// stay in reading order.
export async function extractJournalText(pdfBuffer) {
  const data = new Uint8Array(pdfBuffer);
  const doc = await getDocument({ data }).promise;
  const pageTexts = [];
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum += 1) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();
    pageTexts.push(reconstructPageText(content.items));
  }
  return stripPageChrome(pageTexts.join('\n\n'));
}

// ---- parsing: vote-block anchors ----
//
// CONTROLLER RULING 1: the anchor phrase can wrap across a line break in extracted text
// ('passed by the following\nvote:' OR 'passed by the\nfollowing vote:' - both observed in the
// real fixtures, at different wrap points). '\s' already matches '\n' in JS regexes with no 's'
// flag needed, so replacing the literal spaces in the printed phrase with '\s+' is sufficient -
// no special-case newline handling required. Motion-phrase variants beyond "...was read the 3rd
// time and passed by the following vote:" are real (verified: Day 39 block 9 is "The emergency
// clause was adopted by the following vote:", no bill reference in that sentence at all) - the
// anchor only requires the "by the following vote:" tail, deliberately NOT anchored to "passed"
// or "read the 3rd time", so it captures every variant without needing to enumerate them.
const ANCHOR_RE = /by\s+the\s+following\s+vote\s*:/gi;

// The sentence immediately preceding a vote's anchor is always the motion sentence (verified
// against every block in both real fixtures: 'Was taken up[ by Senator X].' or '...bill passed.'
// always immediately precedes 'On motion of Senator X, ...' or 'The emergency clause was...').
// Sentence boundary = the nearest '.' before the anchor; internal periods (bill-description prose
// earlier in the same paragraph, e.g. 'RSMo.') are never closer to the anchor than that boundary
// because the motion sentence is always the FIRST thing after the previous sentence's period.
function extractMotionSentence(text, anchorStart, anchorEnd) {
  const periodIdx = text.lastIndexOf('.', anchorStart - 1);
  const start = periodIdx === -1 ? 0 : periodIdx + 1;
  return text.slice(start, anchorEnd).replace(/\s+/g, ' ').trim();
}

// ---- parsing: bill references ----
//
// Substitute prefixes (SS/SCS/HS/HCS/CCS "for") are matched (so they don't block the scan from
// reaching the real bill token) but never captured into the identifier - task-4-brief.md is
// explicit that they are not part of the bill's identity, only kept verbatim in `motion` for
// traceability. The real fixtures use BOTH '&' and 'and' (with or without an Oxford comma) as
// list separators for a combined vehicle - e.g. 'SBs 894 and 921' (Day 37), 'SBs 907, 1154, and
// 1272' (Day 39) - so the separator between numbers accepts an optional comma AND/OR an optional
// 'and'/'&' token (both parts independently optional, since real separators mix them:
// ', ' / ' & ' / ', and ' / ' and ').
const BILL_TYPES = 'SB|HB|SJR|HJR|SCR|HCR';
const BILL_TOKEN_RE = new RegExp(
  `(?:(?:SS|SCS|HS|HCS|CCS)\\s+for\\s+)*(${BILL_TYPES})s?\\s+(\\d+(?:(?:\\s*,)?(?:\\s*(?:and|&))?\\s*\\d+)*)`,
  'g',
);

export function extractBillRefs(motion) {
  const refs = [];
  const re = new RegExp(BILL_TOKEN_RE);
  let m;
  while ((m = re.exec(motion))) {
    const type = m[1];
    const numbers = m[2].match(/\d+/g) || [];
    for (const n of numbers) refs.push(`${type} ${n}`);
  }
  return refs;
}

// ---- parsing: category name-lists ----
//
// CONTROLLER RULING 2: surname collisions print a district suffix ('Brown (16)' vs 'Brown (26)')
// in both vote lists and attendance rolls - the token grammar accepts an optional ' (NN)' suffix,
// carried as { surname, district } (mirrors mo-rollcall-pdf.js's splitSurnameDistrict output
// shape, not a bare string) so resolveMoSenator below can do district-aware matching per-token.
// Surnames may be hyphenated (Chappelle-Nadal, real in the 2018 fixture) - the character class
// includes '-' so a hyphenated surname stays one token; it never collides with the trailing
// em-dash+count terminator because that terminator requires a DIGIT immediately after the dash,
// which never follows a hyphen inside a surname.
const NAME_TOKEN_RE = /([A-Za-z][A-Za-z'-]*)(?:\s*\((\d+)\))?/g;

function extractNameTokens(raw) {
  const tokens = [];
  const re = new RegExp(NAME_TOKEN_RE);
  let m;
  while ((m = re.exec(raw))) {
    tokens.push({ surname: m[1], district: m[2] ?? null });
  }
  return tokens;
}

// A category prints one of three shapes (verified against every category in both fixtures):
//   - zero:    '<Label>—Senators—None'
//   - one:     '<Label>—Senator <Surname>—<N>'   (singular "Senator", no line break)
//   - two+:    '<Label>—Senators\n<surname list, possibly wrapped>—<N>'
// Dash: CONTROLLER RULING / task-4-brief.md instructs checking both the em-dash the extraction
// ACTUALLY contains and a plain hyphen defensively. Empirically (task-4-report.md), every
// category separator and count-terminator in BOTH real fixtures is U+2014 (em dash) - a plain
// hyphen is matched too ([—-]) since nothing guarantees a future capture reproduces the exact
// glyph, same defensive posture as mo-senate-web.js's PDF_ENTRY_RE for the same reason.
function extractCategory(blockText, cursor, label) {
  const escapedLabel = label.replace(/\s+/g, '\\s+');
  const re = new RegExp(
    `${escapedLabel}\\s*[\\u2014-]\\s*Senators?(?:\\s*[\\u2014-]\\s*(None)|\\s+([\\s\\S]*?)[\\u2014-]\\s*(\\d+))`,
  );
  const slice = blockText.slice(cursor);
  const m = slice.match(re);
  if (!m) return null;
  const matchEnd = cursor + m.index + m[0].length;
  if (m[1]) return { names: [], count: 0, matchEnd };
  return { names: extractNameTokens(m[2]), count: Number(m[3]), matchEnd };
}

const CATEGORY_LABELS = {
  yeas: 'YEAS',
  nays: 'NAYS',
  absent: 'Absent',
  absentWithLeave: 'Absent with leave',
};

// Reconcile gate per category (task-4-brief.md, non-negotiable): parsed surname count MUST equal
// the printed —<count> or this throws JournalParseError naming the block ordinal and category.
// Searches only within THIS block's own bounded slice (blockText - see parseJournalVotes, which
// bounds every block between its own anchor and the NEXT block's anchor) so a missing/corrupted
// category can never silently resolve to a LATER block's matching header instead of failing loud.
function requireCategory(blockText, cursor, key, ordinal) {
  const label = CATEGORY_LABELS[key];
  const result = extractCategory(blockText, cursor, label);
  if (!result) {
    throw new JournalParseError(
      `block ${ordinal}: could not find the "${label}" category header - cannot safely parse this vote`,
      { ordinal, category: key, blockPreview: blockText.slice(cursor, cursor + 200) },
    );
  }
  if (result.names.length !== result.count) {
    throw new JournalParseError(
      `block ${ordinal}: parsed ${key} count (${result.names.length}) does not reconcile with the printed count (${result.count})`,
      {
        ordinal, category: key, parsed: result.names.length, printed: result.count,
      },
    );
  }
  return result;
}

// Vacancies is a seat count, never a name list (same precedent as mo-rollcall-pdf.js's Vacancies
// handling) - nothing to reconcile it AGAINST (there is no vacant-seat name list to count), so
// this only needs to parse the printed number (or 0 for '—None') without failing loud on a
// missing line, since a missing Vacancies line means the block itself is malformed.
function extractVacancies(blockText, cursor, ordinal) {
  const slice = blockText.slice(cursor);
  const m = slice.match(/Vacancies\s*[—-]\s*(None|\d+)/);
  if (!m) {
    throw new JournalParseError(
      `block ${ordinal}: could not find the "Vacancies" line - cannot safely close out this vote block`,
      { ordinal, category: 'vacancies', blockPreview: slice.slice(0, 200) },
    );
  }
  return m[1] === 'None' ? 0 : Number(m[1]);
}

function parseVoteBlock(blockText, ordinal, motion) {
  const yeas = requireCategory(blockText, 0, 'yeas', ordinal);
  const nays = requireCategory(blockText, yeas.matchEnd, 'nays', ordinal);
  const absent = requireCategory(blockText, nays.matchEnd, 'absent', ordinal);
  const absentWithLeave = requireCategory(blockText, absent.matchEnd, 'absentWithLeave', ordinal);
  const vacancies = extractVacancies(blockText, absentWithLeave.matchEnd, ordinal);
  return {
    ordinal,
    motion,
    bill_refs: extractBillRefs(motion),
    yeas: yeas.names,
    nays: nays.names,
    absent: absent.names,
    absentWithLeave: absentWithLeave.names,
    vacancies,
    tallies: { yeas: yeas.count, nays: nays.count, absent: absent.count },
  };
}

// parseJournalVotes(text) -> { votes, failures }. CONTROLLER RULING 5 / task-4-brief.md: unlike
// mo-rollcall-pdf.js's parseMoRollCall (one roll call per PDF, throws on failure), one journal PDF
// covers a WHOLE DAY of independent votes - a single corrupted block must not discard the other
// 12. Each anchor match opens a block bounded by the NEXT anchor's start (or end of document for
// the last block), so category lookups can never wander into a different block's headers. Ordinal
// is 1-based, assigned by anchor-match order in the (immutable) PDF - stable across re-parses.
export function parseJournalVotes(text) {
  const votes = [];
  const failures = [];
  const anchors = [...text.matchAll(ANCHOR_RE)];
  for (let i = 0; i < anchors.length; i += 1) {
    const ordinal = i + 1;
    const anchor = anchors[i];
    const anchorEnd = anchor.index + anchor[0].length;
    const blockEnd = i + 1 < anchors.length ? anchors[i + 1].index : text.length;
    const blockText = text.slice(anchorEnd, blockEnd);
    const motion = extractMotionSentence(text, anchor.index, anchorEnd);
    try {
      votes.push(parseVoteBlock(blockText, ordinal, motion));
    } catch (err) {
      if (err instanceof JournalParseError) failures.push(err);
      else throw err;
    }
  }
  return { votes, failures };
}

// ---- resolution ----
//
// CONTROLLER RULING 2/3: roster rows come from Task 3's parsers - { legislator_id, surname,
// mo_senate_id } (mo_senate_id = district AS TEXT). Deviation from task-4-brief.md's ASCII sketch
// `resolveMoSenator(surname, roster)`, noted explicitly (see task-4-report.md "concerns"): the
// controller ruling requires the House's two-branch district-aware logic, which needs BOTH
// surname and district per call - exactly mirroring mo-rollcall-pdf.js's resolveMoRep(cast,
// roster), whose first argument is the whole cast, not a bare surname string either. The first
// argument here is the { surname, district } token produced by extractNameTokens (i.e. one
// element of a vote's yeas/nays/absent/absentWithLeave array) - "surname" in the brief's sketch is
// this token, not a plain string. Same fail-loud convention as resolveMoRep: 0 or >1 matches ->
// null, NEVER guessed. No district disambiguation exists in journal text without the printed
// suffix - that absence is exactly WHY an un-suffixed collision (e.g. two 'Brown' roster rows,
// bare 'Brown' cast) must fail loud rather than guess.
export function resolveMoSenator(nameToken, roster) {
  const surname = String(nameToken?.surname ?? '').trim().toLowerCase();
  if (nameToken?.district) {
    const district = String(nameToken.district).trim();
    const matches = roster.filter((r) => (
      String(r.surname ?? '').trim().toLowerCase() === surname
      && String(r.mo_senate_id ?? '').trim() === district
    ));
    return matches.length === 1 ? matches[0].legislator_id : null;
  }
  const matches = roster.filter((r) => String(r.surname ?? '').trim().toLowerCase() === surname);
  return matches.length === 1 ? matches[0].legislator_id : null;
}
