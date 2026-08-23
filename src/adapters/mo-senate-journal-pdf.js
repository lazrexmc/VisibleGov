import { extractPdfText } from './pdf-text.js';

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
// Shared pdfjs plumbing + row-reconstruction now lives in pdf-text.js's extractPdfText/
// reconstructPageText (extracted from here and from mo-rollcall-pdf.js, which used to each carry
// their own byte-identical copy - see that module's own header for why). This file layers its own
// chrome-stripping and vote-block parsing grammar on top.
//
// REAL-PDF FINDING (CONTROLLER RULING 4, verified against BOTH real fixtures -
// tests/fixtures/research/mo-senate/2018-day37-journal-onder-era.pdf and
// .../2026-day39-journal.pdf): unlike mo-rollcall-pdf.js's 4-column grid PDF (where plain
// stream-order concatenation happened to already match coordinate-based row reconstruction),
// these journal PDFs' own text-item stream order is NOT reading order. Empirical test: searching
// for the vote-block anchor phrase "by the following vote:" (tolerant of an internal line-wrap)
// finds all 13 blocks in Day 37 and all 11 in Day 39 when text is reconstructed by row (grouping
// items into rows by descending y, sorting each row left-to-right by x - exactly
// pdf-text.js's reconstructPageText) - but plain stream-order concatenation of the SAME items finds
// only 9 of 13 in Day 37 and 9 of 11 in Day 39 (the underlying content stream interleaves some
// items out of visual order, splitting "following" and "vote" across unrelated intervening text so
// the literal phrase never appears contiguously). Coordinate-based reconstruction is therefore
// REQUIRED for this document type, not a defensive redundancy - confirmed by running both
// extraction strategies against both real fixtures and counting anchor matches before writing any
// parsing logic (see task-4-report.md for the exact counts).

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
// BUG FOUND WHILE ADDING THE FIX-ROUND-1 FINDING-1 TESTS: the 2026 fixture's day-header style puts
// a SPACE before the hyphen ('Thirty-Ninth Day - Wednesday, March 25, 2026'), unlike the 2018
// fixture's em-dash-tight style ('THIRTY-SEVENTH DAY—THURSDAY, MARCH 8, 2018'). The original
// pattern required the dash immediately after 'Day' with no space, so it silently failed to match
// the 2026 style at all - never caught earlier because no vote block in either real fixture
// happens to page-break next to a 2026-style header. Caught only once a synthetic test exercised
// that exact shape directly. Fixed with 'Day\s*[—-]' (optional whitespace before the dash).
const DAY_HEADER_RE = /\b[A-Za-z-]+\s+Day\s*[—-]\s*[A-Za-z]+,\s+[A-Za-z]+\s+\d{1,2},\s*\d{4}\b/i;

// INVARIANT (code review fix round 1, finding 1): chrome stripping must be PROVABLY UNABLE to
// match vote content. JOURNAL_HEADER_RE and DAY_HEADER_RE are safe unconditionally - their literal
// text ('Journal of the Senate', the '<Ordinal> Day<dash><Weekday>, <Month> <D>, <Year>' shape)
// never appears in a category name-list or tally. PAGE_NUMBER_ONLY_RE is NOT safe unconditionally:
// a bare digits-only line is exactly the shape a category's own printed count would take if a page
// break ever isolated it onto its own reconstructed row (the same failure class already fixed for
// name lists in Day 37 block 4 - not observed for a COUNT digit in either real fixture, but the
// risk is structurally identical and undetectable by the reconcile gate if it silently overshoot to
// a LATER em-dash+digit instead). So a bare digits-only line is stripped ONLY when its nearest
// non-blank neighbor (checked on BOTH sides, skipping blank page-join lines) is itself a
// JOURNAL_HEADER_RE or DAY_HEADER_RE match - i.e. only when it is provably page-footer/header
// chrome, never a lone digit sitting between ordinary content. Verified empirically: the only two
// bare-digit-only lines across both real fixtures ('587' in Day 37, '772' in Day 39) each have
// exactly this adjacency (a 'Journal of the Senate' / day-header line as their next non-blank
// neighbor) - see task-4-report.md "Fix round 1" for the exact context dump. An isolated digit
// found WITHOUT that adjacency is left in place; if it truly is unrecognized chrome, the reconcile
// gate below will fail loud on it (a wrong parsed count) rather than this function silently
// deciding it was safe to discard.
function nearestNonBlankIndex(lines, start, step) {
  let i = start + step;
  while (i >= 0 && i < lines.length) {
    if (lines[i].trim() !== '') return i;
    i += step;
  }
  return -1;
}

function isKnownChromeHeaderLine(line) {
  const trimmed = line.trim();
  return JOURNAL_HEADER_RE.test(trimmed) || DAY_HEADER_RE.test(trimmed);
}

// Exported (beyond Task 4's original interface list, same "strictly additive, low-risk export"
// justification as extractBillRefs) so its adjacency behavior is directly unit-testable without
// needing a real PDF to synthesize the page-boundary shapes under test.
export function stripPageChrome(text) {
  const lines = text.split('\n');
  return lines
    .filter((line, i) => {
      const trimmed = line.trim();
      if (trimmed === '') return true; // blank lines are page/paragraph separators, not chrome
      if (isKnownChromeHeaderLine(line)) return false;
      if (PAGE_NUMBER_ONLY_RE.test(trimmed)) {
        const prevIdx = nearestNonBlankIndex(lines, i, -1);
        const nextIdx = nearestNonBlankIndex(lines, i, 1);
        const prevIsChrome = prevIdx !== -1 && isKnownChromeHeaderLine(lines[prevIdx]);
        const nextIsChrome = nextIdx !== -1 && isKnownChromeHeaderLine(lines[nextIdx]);
        return !(prevIsChrome || nextIsChrome);
      }
      return true;
    })
    .join('\n');
}

// pdfBuffer: a Buffer/Uint8Array/ArrayBuffer of raw PDF bytes (never a file path - see
// mo-rollcall-pdf.js's identical parameter comment). Multi-page (these journals run 20-25+ pages
// for a busy day) joined page-by-page in document order, sequential (not Promise.all) so pages
// stay in reading order.
export async function extractJournalText(pdfBuffer) {
  return stripPageChrome(await extractPdfText(pdfBuffer));
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
// Sentence boundary = the nearest '.' before the anchor.
//
// CODE REVIEW FIX ROUND 1 (finding 2): this boundary has no gate against an internal period
// WITHIN the true motion sentence (e.g. an abbreviated title before a name) truncating `motion` to
// start later than it should. Checked empirically for a real risk pattern first: bill-description
// prose in both real fixtures spells out 'RSMo,' with a COMMA, never a period ('RSMo.') - an
// earlier draft of this comment claimed otherwise and was wrong; corrected here. No real dotted
// token was found immediately preceding any of the 24 real motion sentences (13 + 11 across both
// fixtures), so there is nothing concrete to special-case defensively without guessing at a
// pattern that doesn't exist in evidence. The actual protection is downstream, not here: a
// truncated/mis-bounded motion is only dangerous if it produces WRONG bill_refs, and the
// zero-bill-refs gate in parseVoteBlock below converts "no bill reference extracted" (whether from
// truncation or a genuinely bill-less sentence) into a typed failure for human review rather than
// a silently-stored vote - see that gate's comment for why this, not a speculative regex here, is
// the load-bearing fix. (Tested: a synthetic internal period BEFORE a bill reference still yields
// the correct bill_refs, because truncation only drops the SENTENCE PREFIX - see
// tests/mo-senate-journal-pdf.test.js.)
//
// ATTRIBUTION FIX (2026-08-23, the quarantine class — see tests/mo-senate-journal-attribution.test.js):
// the bare single-period lookback had two defects the real 2026 journals exposed. (1) A period
// inside an abbreviation is not a sentence boundary: 'SS No. 2 for SCS for SB 1012' truncated
// every numbered-substitute motion to '2 for SCS for SB 1012 ...', and 'John B. Hurst' truncated an
// appointment roll call to 'Hurst was adopted ...'. Only the two forms actually observed are
// exempted ('No.'/'Nos.' and a single capital initial) — nothing speculative. (2) The lookback had
// no LOWER bound: a block whose preceding narrative contains no period at all (the previous block's
// vote lists end 'Vacancies—None' with no period, then 'On motion of Senator X, HCS for SB 1572 was
// read...') swallowed the entire previous block — lists and all — into `motion`, storing it as the
// vote's question text and emitting duplicate bill_refs. The motion now starts no earlier than the
// end of the previous block's printed categories (`lowerBound`, computed by narrativeStartBefore).
// 'No.'/'Nos.' in both the Title Case and ALL-CAPS forms the spelled-out bill grammar accepts (a
// motion quoting an uppercase heading would otherwise still be cut at 'NO.'). The single-initial
// exemption is kept SEPARATE because it is the one that can overshoot: 'Exhibit A.' / 'Article X.'
// have the same shape as 'John B.' — so the attribution path (resolveBillAttribution) also
// computes the motion WITHOUT it and refuses to attribute a bill that is reachable only across an
// exempted initial (review finding, 2026-08-23).
const ABBREVIATION_NO_RE = /\b(?:No|NO|Nos|NOS)$/;
const SINGLE_INITIAL_RE = /(?:^|[\s(])[A-Z]$/;

function findSentenceStart(text, beforeIndex, lowerBound, { exemptInitial = true } = {}) {
  let searchEnd = beforeIndex - 1;
  while (searchEnd >= lowerBound) {
    const periodIdx = text.lastIndexOf('.', searchEnd);
    if (periodIdx < lowerBound) break;
    const prefix = text.slice(Math.max(lowerBound, periodIdx - 4), periodIdx);
    if (ABBREVIATION_NO_RE.test(prefix) || (exemptInitial && SINGLE_INITIAL_RE.test(prefix))) { searchEnd = periodIdx - 1; continue; }
    return periodIdx + 1;
  }
  return lowerBound;
}

function extractMotionSentence(text, anchorStart, anchorEnd, lowerBound = 0, opts = {}) {
  const start = findSentenceStart(text, anchorStart, lowerBound, opts);
  return text.slice(start, anchorEnd).replace(/\s+/g, ' ').trim();
}

// The end of the last printed vote-list tail before `anchorStart` (searching from `searchFrom`):
// 'Vacancies—None' / 'Vacancies—N', optionally followed by the rarer 'Excused from voting—Senator
// X—1' line (real in the 2026-05-06 journal). Everything before that belongs to the previous block
// (or the day-opening attendance roll, which prints the same tail); everything after it is THIS
// block's own narrative. Used as the motion lookback's floor and as the attribution window's start.
// (The Excused name run excludes only the em-dash, not '-': a hyphenated surname — Chappelle-Nadal
// is real — must not end the run early and drop the whole optional group.)
const BLOCK_TAIL_RE = /Vacancies\s*[—-]\s*(?:None|\d+)(?:\s*Excused\s+from\s+voting\s*[—-]\s*Senators?\b[^—]*?[—-]\s*\d+)?/g;

function narrativeStartBefore(text, anchorStart, searchFrom) {
  const re = new RegExp(BLOCK_TAIL_RE);
  re.lastIndex = searchFrom;
  let end = searchFrom;
  let m;
  while ((m = re.exec(text))) {
    if (m.index >= anchorStart) break;
    end = m.index + m[0].length;
  }
  return end;
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
//
// ATTRIBUTION FIX (2026-08-23): the journal prints the SAME bill identity in two grammars, and the
// places that carry it for the quarantined motion families are all in the second one — conference
// committee report headings ('CONFERENCE COMMITTEE REPORT ON ... HOUSE BILL NO. 2002', 'SENATE BILLS
// NOS. 835 and 1111'), title blocks ('... SENATE JOINT RESOLUTION NO. 87'), amendment instructions
// ('Amend Senate Substitute for Senate Bill No. 1233, Page 1'), and reconsideration motions
// ('Senate Committee Substitute for House Committee Substitute for House Bill No. 2474'). The
// spelled-out grammar is anchored on Bill / Joint Resolution / Concurrent Resolution so that
// 'SENATE AMENDMENT NO. 2' (an amendment designator heading) and 'Senate Resolution No. 1137' (a
// one-chamber simple resolution, not a bill) can never yield a bogus 'SB 2' / 'SB 1137' — both are
// real trap strings in the quarantined days. Numbered substitutes ('SS No. 2 for SCS for SB 1012')
// are consumed as a prefix like the unnumbered ones.
const BILL_TYPES = 'SB|HB|SJR|HJR|SCR|HCR';
// A list needs an EXPLICIT separator between numbers (', ' / ' & ' / ', and ' / ' and ' — the four
// real forms); bare whitespace never joins two numbers, so prose or an ordinal after a bill number
// in a heading or title block cannot be swallowed into the identity.
const NUMBER_LIST = '\\d+(?:\\s*(?:,\\s*(?:and|&)?|and|&)\\s*\\d+)*';
const BILL_TOKEN_RE = new RegExp(
  `(?:(?:SS|SCS|HS|HCS|CCS)(?:\\s+No\\.\\s*\\d+)?\\s+for\\s+)*\\b(${BILL_TYPES})s?\\s+(${NUMBER_LIST})`,
  'g',
);
// Case-SENSITIVE on purpose (Title Case or ALL CAPS only): the journal capitalizes a bill when it
// names the vehicle ('House Bill No. 2474', 'HOUSE BILLS NOS. 2637 and 3155') and lowercases it
// when an "An Act ..." title cites enactment history ('as enacted by senate substitute no. 3 for
// senate bill number 888 ... house committee substitute for senate bill no. 982' — real, in the
// 2026-04-29 HBs 2637 & 3155 title block). Those history citations are not the vehicle, and a
// case-insensitive grammar turned that title block into a three-bill ambiguity.
const SPELLED_TOKEN_RE = new RegExp(
  `\\b(Senate|SENATE|House|HOUSE)\\s+(Bills?|BILLS?|Joint\\s+Resolutions?|JOINT\\s+RESOLUTIONS?|Concurrent\\s+Resolutions?|CONCURRENT\\s+RESOLUTIONS?)\\s+(?:No|NO|Nos|NOS)\\.\\s*(${NUMBER_LIST})`,
  'g',
);

function spelledType(chamber, kind) {
  const c = /^s/i.test(chamber) ? 'S' : 'H';
  if (/joint/i.test(kind)) return `${c}JR`;
  if (/concurrent/i.test(kind)) return `${c}CR`;
  return `${c}B`;
}

// Every bill token in text[start, end), in document order: [{ index, refs }]. A single token can
// itself be a combined vehicle ('SBs 894 and 921' -> refs ['SB 894', 'SB 921']).
function findBillTokens(text, start = 0, end = text.length) {
  const slice = text.slice(start, end);
  const tokens = [];
  let m;
  const abbrev = new RegExp(BILL_TOKEN_RE);
  while ((m = abbrev.exec(slice))) {
    tokens.push({ index: start + m.index, refs: (m[2].match(/\d+/g) || []).map((n) => `${m[1]} ${n}`) });
  }
  const spelled = new RegExp(SPELLED_TOKEN_RE);
  while ((m = spelled.exec(slice))) {
    const type = spelledType(m[1], m[2]);
    tokens.push({ index: start + m.index, refs: (m[3].match(/\d+/g) || []).map((n) => `${type} ${n}`) });
  }
  tokens.sort((a, b) => a.index - b.index);
  return tokens;
}

export function extractBillRefs(motion) {
  return findBillTokens(motion).flatMap((t) => t.refs);
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
//
// KNOWN GAP (carried forward from mo-rollcall-pdf.js's CAST_RE comment, minor code-review note):
// a genuine two-WORD surname printed with a plain space (no hyphen) - e.g. that file's real
// FOUNTAIN HENDERS / WALSH MOORE - would tokenize here as two separate single-word names, same as
// the House parser's documented gap. Not observed in either MO Senate fixture (every Senate
// surname in both Day 37 and Day 39 is one word, optionally hyphenated or district-suffixed), but
// not mechanically distinguishable from "two consecutive ordinary surnames" without a name
// dictionary this codebase deliberately doesn't have - if a future Senate journal prints one, it
// would silently miscount that category by one extra token and fail the reconcile gate loudly
// (never silently succeed), consistent with this file's fail-loud posture elsewhere.
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
  // Three printed shapes: '<Label>—Senators—None'; '<Label>—Senators <names>—<N>' (also the
  // singular '<Label>—Senator <name>—1'); and — real exactly once across 22 journal days, the
  // 2026-02-12 block that quarantined that day — the count on the header line with the names on
  // the following line(s): '<Label>—Senators—2\nNicola Moon'. The third alternative's name run is
  // bounded by the next category label so it can never swallow a later category; the reconcile
  // gate in requireCategory still applies to it.
  const re = new RegExp(
    `${escapedLabel}\\s*[\\u2014-]\\s*Senators?(?:\\s*[\\u2014-]\\s*(None)|\\s+([\\s\\S]*?)[\\u2014-]\\s*(\\d+)|\\s*[\\u2014-]\\s*(\\d+)\\s*\\n\\s*([\\s\\S]*?)(?=\\s*(?:YEAS|NAYS|Absent|Vacancies|Excused)\\b))`,
  );
  const slice = blockText.slice(cursor);
  const m = slice.match(re);
  if (!m) return null;
  const matchEnd = cursor + m.index + m[0].length;
  if (m[1]) return { names: [], count: 0, matchEnd };
  if (m[4] !== undefined) return { names: extractNameTokens(m[5]), count: Number(m[4]), matchEnd };
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

// ---- parsing: bill attribution. Originally two outcomes (the motion names the bill, or — an
// emergency-clause continuation — the preceding "taken up" line); since 2026-08-23 the families
// the journal actually prints, see the ATTRIBUTION FIX section below resolveEmergencyClause ----
//
// CODE REVIEW FIX ROUND 1 (finding 2, load-bearing): bill_refs is what ties a parsed vote to the
// actual bill - it must never be silently wrong or silently absent, because nothing downstream can
// recover the correct bill from a vote_casts row alone.
//
// CODE REVIEW FIX ROUND 2 (controller ruling): round 1 diverted EVERY zero-bill-ref motion to
// `failures`, including Day 39's real emergency-clause-adoption block - but an emergency-clause
// vote is a genuine recorded vote (every EC bill gets one), and a day containing one would then
// NEVER complete under Task 5's planned day-completeness rule. The journal DOES print the
// attribution mechanically for this case, just not inside the EC motion sentence itself - reading
// it is not a guess, it just isn't in the same sentence.
//
// Verified against real bytes in BOTH fixtures before implementing (the ruling's own example
// phrasing, 'SB 1421, with SCS, was taken up by Senator X', does NOT appear in either real
// fixture - every real "taken up" sentence in both is bare: 'Was taken up.', 'Was taken up by
// Senator Dixon.', 'Was called from the Consent Calendar and taken up.' - never names the bill
// itself). The bill name lives in an EARLIER, separate sentence:
// '<bill ref>[, introduced by Senator X][, with SCS], entitled:' followed by the bill's title
// block and its own period-terminated 'An Act ...' description - i.e. TWO real sentences separate
// 'taken up' from the bill name, not one (an earlier draft of this fix assumed one and was wrong -
// extractMotionSentence's single-period lookback lands on 'Was taken up.' alone, which never names
// a bill; caught only by running this against the real Day 39 fixture, not asserted a priori). So
// the actual mechanism is NOT "the sentence containing taken up" but "the nearest bill token
// printed anywhere before the taken-up phrase" - found by scanning BILL_TOKEN_RE backward from the
// taken-up occurrence, bounded below by the start of the PRECEDING vote block's own motion-preamble
// region (two anchors back) so a stale, unrelated bill from much earlier in the day can never be
// picked up by accident.
//
// This fallback applies only to a motion matching /emergency\s+clause/i. (Until 2026-08-23 every
// OTHER zero-ref motion failed loud; the other families now have their own explicit-statement
// rules — see resolveBillAttribution — and an unknown zero-ref motion still fails loud for human
// review.)
//
// CODE REVIEW FIX ROUND 3 (controller ruling): the cross-check against the immediately preceding
// vote block is not optional corroboration - it is REQUIRED, not "used when available." Round 2
// only cross-checked `if (precedingVote)`, which left a real gap: an EC block whose own preceding
// block FAILED (so there is no successful vote at ordinal-1 to verify against), or an EC appearing
// as the day's first or second block (no real preceding vote exists at all - the backward-scan
// window would collapse to document start, an incidental rather than deliberate bound), could
// silently accept a single unverified backward scan as truth. "Never a guess" means never trusting
// one unconfirmed source for this fallback - so a missing/failed precedingVote now fails the EC
// block outright, before the scan even runs, rather than trying anyway with a wide-open window.
const TAKEN_UP_RE = /taken up/gi;

function lastTakenUpIndexBefore(text, beforeIndex) {
  const re = new RegExp(TAKEN_UP_RE);
  let match;
  let lastIdx = -1;
  while ((match = re.exec(text))) {
    if (match.index >= beforeIndex) break;
    lastIdx = match.index;
  }
  return lastIdx;
}

// The nearest bill token (by BILL_TOKEN_RE, same grammar extractBillRefs uses) whose match starts
// strictly before `beforeIndex` and at or after `lowerBound` - i.e. "the last bill mentioned in
// this window," not a sentence-scoped search. Returns the SAME ['TYPE N', ...] shape as
// extractBillRefs (a single token can itself be a combined vehicle, e.g. 'SBs 894 and 921').
function nearestBillRefBefore(text, beforeIndex, lowerBound) {
  const re = new RegExp(BILL_TOKEN_RE);
  let match;
  let best = null;
  while ((match = re.exec(text))) {
    if (match.index >= beforeIndex) break;
    if (match.index >= lowerBound) best = match;
  }
  if (!best) return [];
  const numbers = best[2].match(/\d+/g) || [];
  return numbers.map((n) => `${best[1]} ${n}`);
}

// ---- ATTRIBUTION FIX (2026-08-23): the motion families the journal prints WITHOUT the bill in
// the motion sentence, and the non-bill roll calls that share the anchor ----
//
// Evidence: 18 of the 20 quarantined journal days (14 in the 2026 session, 6 in 2018) failed on
// exactly these shapes — ground-truthed block by block by a classifier + adversarial-verifier agent
// pair per day (72 findings, 0 disagreements, 0 misattributions among the blocks that did parse).
// The old gate's assumption ("the sentence before the anchor always names the bill") held for the
// two original fixtures and is simply false for the 2026 session's floor work:
//   * conference-committee-report adoption: 'Senator X moved that the above conference committee
//     report be adopted' — the bill is named only in the 'on behalf of the conference committee ...
//     on SS for SCS for HCS for HB 2002, moved that the following conference committee report be
//     taken up' sentence and in the 'CONFERENCE COMMITTEE REPORT ON ... HOUSE BILL NO. 2002' heading
//     (19 blocks; 12 CCR pairs on the FY2027 appropriations day alone);
//   * third reading after a printed title block: 'On motion of Senator X, CCS for ... HB 2002,
//     entitled: <TITLE> An Act ... . Was read the 3rd time and passed' — the title's own period
//     makes the motion sentence the bare 'Was read the 3rd time and passed' (19 blocks);
//   * floor-amendment roll calls: 'SA 2, as amended, was adopted' / 'SA 3 failed of adoption' —
//     the bill is named only in the amendment's own instruction line 'Amend Senate Substitute for
//     Senate Bill No. 1233, Page 1, ...' (10 blocks);
//   * procedural reconsideration: 'moved that the vote by which the motion to postpone debate was
//     defeated be reconsidered' — the bill sits in the immediately preceding sentences (1 block);
//   * and NON-BILL roll calls that legitimately have no bill: mid-debate quorum calls ('A quorum
//     was established by the following vote:' with Present/Absent categories), adoption of a simple
//     Senate resolution ('SR 640 was adopted'), amendments to a simple resolution (Senate rules),
//     an amendment to the Senate JOURNAL itself, and advice-and-consent votes on gubernatorial
//     appointments. Four whole days had ONLY such roll calls and were quarantined for nothing.
//
// Design, unchanged in spirit from rounds 1-3 ("never a guess", fail loud for human review):
//   * every attribution comes from an explicit printed statement of the bill — a heading, an
//     instruction line, the 'entitled:' sentence, a '(pending)' recall sentence — with ONE
//     exception, the procedural-reconsideration family, which borrows its bill from the block's
//     own floor-action sentences (never from a committee report, referral or House message)
//     and only when they all name the same bill — labelled 'narrative_window' so the provenance
//     is distinguishable from a printed statement;
//   * the bill-action families resolve through ONE mechanism, resolveFromWindow: every bill token
//     (abbreviated or spelled out) inside the family's own bounded narrative window must name the
//     same identity, otherwise the block fails loud naming every candidate. The window never reaches
//     into the previous block (lowerBound = end of its printed categories), and for CCRs it starts at
//     the report's own taken-up sentence, so House messages listing other bills earlier in the
//     block can never collide. This is strictly stronger than a single cross-check: a CCR whose
//     taken-up sentence and heading disagree fails, as does a title block naming a second bill;
//   * amendment roll calls resolve from the nearest preceding 'Amend <vehicle>, Page ...' line
//     (the instruction printed when the amendment was offered — the amendment under vote or its
//     sub-amendment, which targets the same vehicle); an instruction that targets the Senate
//     Journal or a simple resolution classifies the block as non-bill instead;
//   * non-bill roll calls are recognised only by their own explicit shapes (the word 'quorum', an
//     SR/HR token, an instruction targeting the Journal or a Resolution, a committee-report motion
//     in a window that names the Committee on Gubernatorial Appointments) and are REPORTED as
//     `nonBillVotes` — never attributed and, for now, never stored as votes (votes.bill_id is
//     nullable and site/js/person-page.js already renders a bill-less vote as "procedural vote,
//     no associated bill", so storing them is feasible — it is a captured product decision, not
//     a technical block), and never a failure, so a day made only of them can complete;
//   * anything else bill-less still fails loud exactly as before (the round-1 gate), including a
//     third reading whose window names two bills — the agents' wrong-pick traps (SB 888 quoted
//     inside a journal amendment, SB 579 in a referrals line, SB 546 around a quorum call) are all
//     pinned by tests.
// An amendment designator as a motion prints it ('SA 3', 'SA 2, as amended', 'SSA 1 for SA 2') and
// as its heading prints it ('SENATE AMENDMENT NO. 3', 'SENATE SUBSTITUTE AMENDMENT NO. 1 FOR SENATE
// AMENDMENT NO. 2', 'SENATE AMENDMENT NO. 1 TO SENATE AMENDMENT NO. 2'), both normalised to the
// same canonical string so the motion can be tied to ITS OWN heading + instruction — never to
// whichever 'Amend ...' line happens to be nearest (review finding, 2026-08-23: a pending amendment
// recalled from the Informal Calendar reprints no instruction, so "nearest" was another bill's).
const AMENDMENT_DESIGNATOR_RE = /\b(SSA|SA|HSA|HA)\s+(\d+)(?:\s+(?:to|for)\s+(SSA|SA|HSA|HA)\s+(\d+))?\b/;
const AMENDMENT_HEADING_RE = /\b(SENATE|HOUSE)\s+(SUBSTITUTE\s+)?AMENDMENT\s+NO\.\s*(\d+)(?:\s+(?:TO|FOR)\s+(SENATE|HOUSE)\s+(SUBSTITUTE\s+)?AMENDMENT\s+NO\.\s*(\d+))?/g;
const SIMPLE_RESOLUTION_TOKEN_RE = /\b(?:SR|HR)\s+\d+\b/;
const SIMPLE_RESOLUTION_SPELLED_RE = /\b(?:Senate|House)\s+Resolutions?\s+Nos?\./i;
const CCR_HEADING_RE = /CONFERENCE COMMITTEE REPORT(?:\s+NO\.\s*\d+)?\s+ON\b/g; // the uppercase heading only
const CCR_TAKEN_UP_RE = /moved\s+that\s+the\s+following\s+conference\s+committee\s+report\s+be\s+taken\s+up/gi;
// The instruction line printed under an amendment heading: 'Amend <vehicle>, Page 1, Section …' /
// ', In the Title, Line 5' / ', Sections 326.256 and 326.277' — the vehicle ends at the first such
// locator (singular and plural forms).
const AMEND_INSTRUCTION_RE = /\bAmend\s+((?:Senate|House)[\s\S]{0,300}?)(?=,\s*(?:Pages?|In\s+the\s+Title|Sections?|Lines?)\b)/g;
const THIRD_READING_RE = /read\s+the\s+(?:3rd|third)\s+time|\bfinally\s+passed\b/i;
const RECONSIDER_RE = /\breconsider/i;
// A sentence that is a FLOOR ACTION on a question (the only kind a bill-less reconsideration may
// borrow its bill from) vs. one that merely mentions a bill in passing (a committee report, a
// referral, a House message).
const FLOOR_ACTION_RE = /\b(?:taken\s+up|moved\s+that|read\s+the\s+(?:3rd|third)\s+time|3rd\s+read|be\s+adopted|was\s+adopted|be\s+passed|was\s+passed|be\s+postponed)\b/i;
const NOT_FLOOR_ACTION_RE = /\b(?:referred|Committee\s+on|REPORTS\s+OF\s+STANDING\s+COMMITTEES|MESSAGES\s+FROM\s+THE\s+HOUSE|begs\s+leave\s+to\s+report|Madam\s+President|Mr\.\s+President)\b/;

function canonicalDesignator(kindA, numA, kindB, numB) {
  return `${kindA} ${numA}${kindB ? ` to ${kindB} ${numB}` : ''}`;
}
function designatorFromMotion(motion) {
  const m = AMENDMENT_DESIGNATOR_RE.exec(motion);
  return m ? canonicalDesignator(m[1], m[2], m[3], m[4]) : null;
}
function designatorFromHeading(m) {
  const kind = (chamber, substitute) => `${chamber[0] === 'S' ? 'S' : 'H'}${substitute ? 'SA' : 'A'}`;
  return canonicalDesignator(kind(m[1], m[2]), m[3], m[4] ? kind(m[4], m[5]) : null, m[6]);
}

// The last match of `re` whose index lies in [lowerBound, beforeIndex), or null.
function lastMatchBefore(re, text, lowerBound, beforeIndex) {
  const scanner = new RegExp(re);
  scanner.lastIndex = lowerBound;
  let best = null;
  let m;
  while ((m = scanner.exec(text))) {
    if (m.index >= beforeIndex) break;
    best = m;
  }
  return best;
}

function noBillReferenceError(ordinal, motion) {
  return new JournalParseError(
    `block ${ordinal}: no bill reference found in motion - needs human review`,
    {
      ordinal, category: 'bill_refs', reason: 'no bill reference found in motion - needs human review', motion,
    },
  );
}

function resolveFromWindow(text, windowStart, anchorStart, ordinal, motion, attribution) {
  const tokens = findBillTokens(text, windowStart, anchorStart);
  if (tokens.length === 0) throw noBillReferenceError(ordinal, motion);
  const identities = [...new Set(tokens.map((t) => t.refs.join(' & ')))];
  if (identities.length !== 1) {
    throw new JournalParseError(
      `block ${ordinal}: the motion names no bill and its own narrative names more than one (${identities.join('; ')}) - needs human review`,
      {
        ordinal, category: 'bill_refs', reason: 'ambiguous narrative window - more than one bill named', candidates: identities, motion,
      },
    );
  }
  return { bill_refs: tokens[0].refs, attribution };
}

function resolveConferenceReport(text, lowerBound, anchorStart, ordinal, motion) {
  const heading = lastMatchBefore(CCR_HEADING_RE, text, lowerBound, anchorStart);
  if (!heading) {
    throw new JournalParseError(
      `block ${ordinal}: conference-committee-report adoption motion with no CONFERENCE COMMITTEE REPORT heading in its narrative - needs human review`,
      {
        ordinal, category: 'bill_refs', reason: 'no conference committee report heading found in the block narrative', motion,
      },
    );
  }
  const takenUp = lastMatchBefore(CCR_TAKEN_UP_RE, text, lowerBound, heading.index);
  const windowStart = takenUp ? findSentenceStart(text, takenUp.index, lowerBound) : heading.index;
  return resolveFromWindow(text, windowStart, anchorStart, ordinal, motion, 'conference_committee_report');
}

// A bill-less reconsideration borrows its bill only from a FLOOR-ACTION sentence in its narrative
// (never from a committee report / referral / House message that merely mentions a bill), and
// only if every such sentence names the same bill.
function resolveFromFloorActions(text, windowStart, anchorStart, ordinal, motion, attribution) {
  const tokens = findBillTokens(text, windowStart, anchorStart).filter((t) => {
    const start = findSentenceStart(text, t.index, windowStart, { exemptInitial: false });
    const periodIdx = text.indexOf('.', t.index);
    const end = periodIdx === -1 || periodIdx > anchorStart ? anchorStart : periodIdx + 1;
    const sentence = text.slice(start, end);
    return FLOOR_ACTION_RE.test(sentence) && !NOT_FLOOR_ACTION_RE.test(sentence);
  });
  if (tokens.length === 0) throw noBillReferenceError(ordinal, motion);
  const identities = [...new Set(tokens.map((t) => t.refs.join(' & ')))];
  if (identities.length !== 1) {
    throw new JournalParseError(
      `block ${ordinal}: the motion names no bill and its narrative's floor actions name more than one (${identities.join('; ')}) - needs human review`,
      {
        ordinal, category: 'bill_refs', reason: 'ambiguous narrative window - more than one bill named', candidates: identities, motion,
      },
    );
  }
  return { bill_refs: tokens[0].refs, attribution };
}

function resolveAmendmentVote(text, lowerBound, anchorStart, ordinal, motion) {
  const designator = designatorFromMotion(motion);
  // 1. The amendment's OWN heading in this block's narrative, and the instruction printed directly
  //    under it — the explicit statement of what the amendment amends.
  let heading = null;
  const scanner = new RegExp(AMENDMENT_HEADING_RE);
  scanner.lastIndex = lowerBound;
  let m;
  while ((m = scanner.exec(text))) {
    if (m.index >= anchorStart) break;
    if (designatorFromHeading(m) === designator) heading = m;
  }
  if (heading) {
    const headingEnd = heading.index + heading[0].length;
    const instructionScanner = new RegExp(AMEND_INSTRUCTION_RE);
    instructionScanner.lastIndex = headingEnd;
    const instruction = instructionScanner.exec(text);
    const nextHeading = lastMatchBefore(AMENDMENT_HEADING_RE, text, headingEnd, anchorStart);
    const instructionLimit = Math.min(anchorStart, headingEnd + 400, nextHeading ? nextHeading.index : anchorStart);
    if (!instruction || instruction.index >= instructionLimit) {
      throw new JournalParseError(
        `block ${ordinal}: amendment ${designator} has a heading but no "Amend ..." instruction under it - needs human review`,
        {
          ordinal, category: 'bill_refs', reason: 'amendment heading without an instruction line', motion, designator,
        },
      );
    }
    const vehicle = instruction[1];
    if (/\b(?:Senate|House)\s+Journal\b/i.test(vehicle)) return { nonBill: 'journal_amendment' };
    if (SIMPLE_RESOLUTION_SPELLED_RE.test(vehicle)) return { nonBill: 'simple_resolution' };
    const identities = [...new Set(findBillTokens(vehicle).map((t) => t.refs.join(' & ')))];
    if (identities.length === 0) {
      throw new JournalParseError(
        `block ${ordinal}: the amendment instruction names no bill ("Amend ${vehicle.replace(/\s+/g, ' ').slice(0, 80)}") - needs human review`,
        {
          ordinal, category: 'bill_refs', reason: 'amendment instruction names no bill', motion, vehicle,
        },
      );
    }
    if (identities.length > 1) {
      throw new JournalParseError(
        `block ${ordinal}: the amendment instruction names more than one bill (${identities.join('; ')}) - needs human review`,
        {
          ordinal, category: 'bill_refs', reason: 'ambiguous amendment instruction - more than one bill named', candidates: identities, motion,
        },
      );
    }
    // Corroboration: every bill token from the corroboration window through the anchor must agree
    // with the instruction. The window starts at the amendment's '(pending)' RECALL sentence when
    // one follows the heading (a recalled amendment's heading can be separated from its roll call
    // by other bills' business, which legitimately names other bills), otherwise at the heading
    // (the instruction, any sub-amendment's instruction, the amendment body's own Title Case
    // references).
    const recallAfterHeading = lastMatchBefore(new RegExp(`\\b${designator.replace(/\s+/g, '\\s+')}\\s*\\(pending\\)`, 'g'), text, headingEnd, anchorStart);
    const windowStart = recallAfterHeading ? findSentenceStart(text, recallAfterHeading.index, lowerBound, { exemptInitial: false }) : heading.index;
    const corroborated = resolveFromWindow(text, windowStart, anchorStart, ordinal, motion, 'amendment_instruction');
    if (corroborated.bill_refs.join(' & ') !== identities[0]) {
      throw new JournalParseError(
        `block ${ordinal}: amendment ${designator}'s instruction names ${identities[0]} but its narrative names ${corroborated.bill_refs.join(' & ')} - needs human review`,
        {
          ordinal, category: 'bill_refs', reason: 'amendment instruction and narrative disagree', candidates: [identities[0], corroborated.bill_refs.join(' & ')], motion,
        },
      );
    }
    return corroborated;
  }
  // 2. No heading in this block: the pending-amendment RECALL shape — '<bill>, with SS and SA 3
  //    (pending), be called from the Informal Calendar and again taken up' — names both the bill
  //    and the designator in one sentence; the window from that sentence must name one bill.
  const recall = lastMatchBefore(new RegExp(`\\b${designator.replace(/\s+/g, '\\s+')}\\s*\\(pending\\)`, 'g'), text, lowerBound, anchorStart);
  if (recall) {
    const sentenceStart = findSentenceStart(text, recall.index, lowerBound, { exemptInitial: false });
    return resolveFromWindow(text, sentenceStart, anchorStart, ordinal, motion, 'pending_amendment_recall');
  }
  throw new JournalParseError(
    `block ${ordinal}: amendment ${designator} roll call with neither its own heading and "Amend ..." instruction nor a "(pending)" recall sentence in its narrative - needs human review`,
    {
      ordinal, category: 'bill_refs', reason: 'no amendment instruction or recall sentence found in the block narrative', motion, designator,
    },
  );
}

// `motion` is the sentence with the single-initial period exemption; `strictMotion` the same
// sentence without it (they differ only when an initial was crossed). The bill must be reachable
// in the STRICT sentence — a reference that only appears across an exempted initial ('... per
// Exhibit A. The motion was adopted') is the previous sentence's, not this motion's.
function resolveBillAttribution(text, anchorStart, ordinal, motion, precedingVote, precedingWindowStart, lowerBound = 0, precedingWindow = null, strictMotion = motion) {
  const motionTokens = findBillTokens(strictMotion);
  if (motionTokens.length > 0) {
    const identities = [...new Set(motionTokens.map((t) => t.refs.join(' & ')))];
    if (identities.length !== 1) {
      throw new JournalParseError(
        `block ${ordinal}: the motion names more than one bill (${identities.join('; ')}) - needs human review`,
        {
          ordinal, category: 'bill_refs', reason: 'ambiguous motion - more than one bill named', candidates: identities, motion,
        },
      );
    }
    return { bill_refs: motionTokens[0].refs, attribution: 'motion' };
  }
  if (strictMotion !== motion && findBillTokens(motion).length > 0) {
    throw new JournalParseError(
      `block ${ordinal}: the only bill reference near the motion lies across a single-initial period ("${motion.slice(0, 80)}") - needs human review`,
      {
        ordinal, category: 'bill_refs', reason: 'bill reference reachable only across an exempted initial period', motion,
      },
    );
  }

  // Non-bill roll calls — each recognised ONLY by its observed printed shape.
  if (/\bA\s+quorum\s+was\s+established\b/i.test(motion)) return { nonBill: 'quorum_call' };
  if (SIMPLE_RESOLUTION_TOKEN_RE.test(motion)) return { nonBill: 'simple_resolution' };
  if (/^The\s+committee\s+report\s+on\b.*\bwas\s+adopted\b/i.test(motion)) {
    // An advice-and-consent vote: the Committee on Gubernatorial Appointments' report sits in this
    // block's narrative and NO bill is named after it (a bill token there would mean the motion
    // is about something else and must fail loud).
    const committee = lastMatchBefore(/\bGubernatorial\s+Appointments\b/g, text, lowerBound, anchorStart);
    if (committee && findBillTokens(text, committee.index, anchorStart).length === 0) return { nonBill: 'appointment' };
  }

  if (/emergency\s+clause/i.test(motion)) {
    return resolveEmergencyClause(text, anchorStart, ordinal, motion, precedingVote, precedingWindowStart, precedingWindow);
  }
  if (AMENDMENT_DESIGNATOR_RE.test(motion)) return resolveAmendmentVote(text, lowerBound, anchorStart, ordinal, motion);
  if (/conference\s+committee\s+report/i.test(motion) && /\badopt/i.test(motion)) {
    return resolveConferenceReport(text, lowerBound, anchorStart, ordinal, motion);
  }
  // Reconsideration is the more specific shape and is tested first: its motion may quote 'read
  // the 3rd time' ('the vote by which the bill was read the 3rd time and passed be reconsidered').
  if (RECONSIDER_RE.test(motion)) return resolveFromFloorActions(text, lowerBound, anchorStart, ordinal, motion, 'narrative_window');
  if (THIRD_READING_RE.test(motion)) {
    // A third reading whose motion names no bill is the post-title-block shape: the bill sits in the
    // 'On motion of Senator X, <vehicle>, entitled:' sentence that opens the title block. No
    // 'entitled:' in this block's narrative means this is not that shape — fail loud, never fall
    // back to proximity.
    const entitled = lastMatchBefore(/,\s*entitled\s*:/g, text, lowerBound, anchorStart);
    if (!entitled) {
      throw new JournalParseError(
        `block ${ordinal}: third-reading motion names no bill and no "entitled:" title block precedes it in this block's narrative - needs human review`,
        {
          ordinal, category: 'bill_refs', reason: 'third reading without a bill or a title block', motion,
        },
      );
    }
    const windowStart = findSentenceStart(text, entitled.index, lowerBound, { exemptInitial: false });
    return { ...resolveFromWindow(text, windowStart, anchorStart, ordinal, motion, 'title_block'), window: { start: windowStart, end: anchorStart } };
  }

  throw noBillReferenceError(ordinal, motion);
}

function resolveEmergencyClause(text, anchorStart, ordinal, motion, precedingVote, precedingWindowStart, precedingWindow = null) {

  // FIX ROUND 3: required, not optional - see the module comment above. Checked BEFORE the scan
  // even runs, since without a successful preceding vote there is nothing to verify against and
  // no point spending effort on a result that can never be trusted regardless of what it finds.
  // Covers both real gaps identified: the preceding block existing but having FAILED (precedingVote
  // is null whenever `last.ordinal !== ordinal - 1`, whether because ordinal-1 itself threw or
  // because there is no block at ordinal-1 at all), and an EC at ordinal 1 or 2 where the
  // backward-scan window would otherwise collapse toward document start.
  if (!precedingVote) {
    throw new JournalParseError(
      `block ${ordinal}: emergency-clause attribution unverifiable - preceding vote block missing or failed`,
      {
        ordinal, category: 'bill_refs', reason: 'emergency-clause attribution unverifiable - preceding vote block missing or failed', motion,
      },
    );
  }

  // ATTRIBUTION FIX (2026-08-23): the conference sequence — CCR adoption, then the CCS 'read the
  // 3rd time and passed' after a printed title block, then 'The emergency clause was adopted' —
  // prints NO 'taken up' line between the title block and the EC (the only 'taken up' is the
  // report's own 'be taken up' sentence, before the CCR block, outside this scan's window), so the
  // round-2/3 taken-up corroboration has nothing to read. The second source in that shape is the
  // title block itself: when the immediately preceding vote was attributed from its title block,
  // the EC attributes to that bill iff every bill token from the title block's window through
  // this anchor names that same bill (the window rule of resolveFromWindow) — 'The President
  // declared the bill passed.' names none, so any stray second bill fails loud as before.
  const takenUpIdx = lastTakenUpIndexBefore(text, anchorStart);
  if (precedingVote.attribution === 'title_block' && precedingWindow
    && (takenUpIdx === -1 || nearestBillRefBefore(text, takenUpIdx, precedingWindowStart).length === 0)) {
    // The EC window is a strict superset of the preceding vote's title-block window (same start,
    // later end), so if resolveFromWindow returns at all its single identity IS the preceding
    // vote's bill; a second bill anywhere between the title block and this anchor fails loud there.
    return resolveFromWindow(text, precedingWindow.start, anchorStart, ordinal, motion, 'preceding_title_block');
  }
  if (takenUpIdx === -1) {
    throw new JournalParseError(
      `block ${ordinal}: emergency-clause block has no bill reference in its own motion and no preceding "taken up" line was found - needs human review`,
      {
        ordinal, category: 'bill_refs', reason: 'no preceding taken-up line found for emergency-clause attribution - needs human review', motion,
      },
    );
  }
  const takenUpRefs = nearestBillRefBefore(text, takenUpIdx, precedingWindowStart);
  if (takenUpRefs.length === 0) {
    throw new JournalParseError(
      `block ${ordinal}: emergency-clause block's nearest preceding "taken up" line has no bill reference near it either - needs human review`,
      {
        ordinal, category: 'bill_refs', reason: 'preceding taken-up line names no bill - needs human review', motion,
      },
    );
  }

  if (precedingVote.bill_refs[0] !== takenUpRefs[0]) {
    throw new JournalParseError(
      `block ${ordinal}: emergency-clause attribution mismatch - the preceding "taken up" line names ${takenUpRefs[0]} but the immediately preceding vote block's primary bill is ${precedingVote.bill_refs[0]}`,
      {
        ordinal,
        category: 'bill_refs',
        reason: 'emergency-clause attribution discrepancy between the preceding taken-up line and the preceding vote block',
        takenUpRef: takenUpRefs[0],
        precedingVoteRef: precedingVote.bill_refs[0],
      },
    );
  }

  return { bill_refs: takenUpRefs, attribution: 'preceding_taken_up' };
}

function parseVoteBlock(blockText, ordinal, motion, bill_refs, attribution) {
  const yeas = requireCategory(blockText, 0, 'yeas', ordinal);
  const nays = requireCategory(blockText, yeas.matchEnd, 'nays', ordinal);
  const absent = requireCategory(blockText, nays.matchEnd, 'absent', ordinal);
  const absentWithLeave = requireCategory(blockText, absent.matchEnd, 'absentWithLeave', ordinal);
  const vacancies = extractVacancies(blockText, absentWithLeave.matchEnd, ordinal);
  return {
    ordinal,
    motion,
    bill_refs,
    attribution,
    yeas: yeas.names,
    nays: nays.names,
    absent: absent.names,
    absentWithLeave: absentWithLeave.names,
    vacancies,
    tallies: { yeas: yeas.count, nays: nays.count, absent: absent.count },
  };
}

// parseJournalVotes(text) -> { votes, failures, nonBillVotes }. CONTROLLER RULING 5 / task-4-brief.md: unlike
// mo-rollcall-pdf.js's parseMoRollCall (one roll call per PDF, throws on failure), one journal PDF
// covers a WHOLE DAY of independent votes - a single corrupted block must not discard the other
// 12. Each anchor match opens a block bounded by the NEXT anchor's start (or end of document for
// the last block), so category lookups can never wander into a different block's headers. Ordinal
// is 1-based, assigned by anchor-match order in the (immutable) PDF - stable across re-parses.
//
// Returns { votes, failures, nonBillVotes }. nonBillVotes (2026-08-23) lists the recorded roll calls
// that are mechanically NOT votes on a bill — quorum calls, simple-resolution adoptions and
// amendments, journal amendments, appointment confirmations — as { ordinal, kind, motion }. They are
// reported, never attributed, and never counted as failures (the day-completeness rule keys on
// `failures` alone), so a day whose only roll calls are procedural can complete.
export function parseJournalVotes(text) {
  const votes = [];
  const failures = [];
  const nonBillVotes = [];
  const windowByOrdinal = new Map();
  const anchors = [...text.matchAll(ANCHOR_RE)];
  for (let i = 0; i < anchors.length; i += 1) {
    const ordinal = i + 1;
    const anchor = anchors[i];
    const anchorEnd = anchor.index + anchor[0].length;
    const blockEnd = i + 1 < anchors.length ? anchors[i + 1].index : text.length;
    const blockText = text.slice(anchorEnd, blockEnd);
    // This block's own narrative starts where the previous block's printed categories end (or,
    // for the first block, after the day-opening attendance roll's identical tail) — the floor for
    // both the motion-sentence lookback and the attribution windows.
    const prevAnchorEnd = i > 0 ? anchors[i - 1].index + anchors[i - 1][0].length : 0;
    const lowerBound = narrativeStartBefore(text, anchor.index, prevAnchorEnd);
    const motion = extractMotionSentence(text, anchor.index, anchorEnd, lowerBound);
    const strictMotion = extractMotionSentence(text, anchor.index, anchorEnd, lowerBound, { exemptInitial: false });
    const last = votes[votes.length - 1];
    const precedingVote = last && last.ordinal === ordinal - 1 ? last : null;
    // Lower bound for the emergency-clause taken-up-line bill scan (resolveBillAttribution): the
    // start of the PRECEDING vote block's own motion-preamble region, i.e. right after the anchor
    // two blocks back - so a stray earlier bill mention can never be picked up by accident.
    //
    // EXPLICIT, not incidental (fix round 3): for i < 2 (ordinal 1 or 2) this expression falls
    // back to 0 - the whole document so far - which on its own would be a genuinely wide-open
    // window. That is deliberately safe, not a gap, ONLY because resolveBillAttribution now
    // REQUIRES a non-null `precedingVote` before this bound is ever even consulted: ordinal 1 has
    // no preceding block at all (precedingVote is always null, so the EC block fails before the
    // scan runs), and ordinal 2's window is only used when block 1 already parsed successfully -
    // in which case block 1's own primary bill_refs[0] still cross-checks whatever this wide
    // window finds, so a wrong pick fails loud rather than silently attributing to preamble text
    // (e.g. THIRD READING OF SENATE BILLS boilerplate) above the day's first bill.
    const precedingWindowStart = i >= 2 ? anchors[i - 2].index + anchors[i - 2][0].length : 0;
    // The attribution window of the immediately preceding vote (only title-block attributions
    // carry one) — the emergency-clause corroboration source in the conference sequence.
    const precedingWindow = precedingVote ? (windowByOrdinal.get(precedingVote.ordinal) ?? null) : null;
    try {
      const resolved = resolveBillAttribution(text, anchor.index, ordinal, motion, precedingVote, precedingWindowStart, lowerBound, precedingWindow, strictMotion);
      if (resolved.nonBill) {
        // A non-bill block is not category-parsed (a quorum call prints Present/Absent, not
        // YEAS/NAYS), but it must still END like every block — its printed tail is the next
        // block's narrative floor. A block with no Vacancies line is malformed: fail it loud
        // rather than let the next vote's motion swallow its lists.
        if (!new RegExp(BLOCK_TAIL_RE).test(blockText)) {
          throw new JournalParseError(
            `block ${ordinal}: could not find the "Vacancies" line - cannot safely close out this non-bill block`,
            { ordinal, category: 'vacancies', blockPreview: blockText.slice(0, 200) },
          );
        }
        nonBillVotes.push({ ordinal, kind: resolved.nonBill, motion });
      } else {
        if (resolved.window) windowByOrdinal.set(ordinal, resolved.window);
        votes.push(parseVoteBlock(blockText, ordinal, motion, resolved.bill_refs, resolved.attribution));
      }
    } catch (err) {
      if (err instanceof JournalParseError) failures.push(err);
      else throw err;
    }
  }
  return { votes, failures, nonBillVotes };
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
