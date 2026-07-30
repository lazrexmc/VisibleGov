// site/js/bill-page.js — the bill page (design spec §4, task-9 brief; fix round 1, task-9
// review). Browser-native ES module. Same "wiring" layer split as person-page.js/directory-
// page.js: pure helpers here (TDD'd in tests/bill-page.test.js BEFORE the DOM code below existed),
// DOM/network orchestration after, reusing the existing toolbox by exact name — never a lookalike
// reimplementation: rest.js (restGet, fetchAllRows), render.js (el, clearChildren, sectionState),
// receipts.js (officialBillUrl), summary-parse.js (parseBullets, extractStatedPurpose),
// profile-model.js (chamberLabel, groupSponsorships), slugs.js (slugify), person-page.js
// (idFromPath — uuid-validated, reused verbatim for the /bill/<id> parse; isNumericStatusCode and
// joinFlagBadges reused the same way, see their own call sites below), glossary-inline.js
// (markTerms, renderMarkedText — task 9's own new module).
//
// Three-state discipline (plan law, verbatim, same as every other page): every fetch renders one
// of loading / failed ('couldn't load — retry') / honestly-empty. A failed fetch never renders as
// an empty section. Each section below (identity, sponsors, votes, summary) is independently
// three-stated via sectionState().

import { restGet, fetchAllRows } from './rest.js';
import {
  el, clearChildren, sectionState, mountFooter,
} from './render.js';
import { officialBillUrl } from './receipts.js';
import { parseBullets, extractStatedPurpose } from './summary-parse.js';
import { chamberLabel, groupSponsorships } from './profile-model.js';
import { slugify } from './slugs.js';
import { idFromPath, isNumericStatusCode, joinFlagBadges } from './person-page.js';
import { renderMarkedText } from './glossary-inline.js';

// ============================================================================
// Pure helpers (TDD'd in tests/bill-page.test.js BEFORE any of the DOM code below existed)
// ============================================================================

// tallyPositions(castRows) -> {yea, nay, not_voting, absent, other: {}} — a MECHANICAL count of
// stored vote_casts rows, labeled in the UI as "recorded casts in our data"; rendered NEXT TO
// votes.result (the source's printed outcome), never replacing it and never reconciled
// client-side (spec-critical, task-9 brief). Only the four positions this page's own tally box
// names get a top-level bucket; migration 0001's vote_casts CHECK constraint also allows 'present'
// and a literal 'other' — those (and any future/unexpected value) land in `other`, keyed under
// their OWN raw string, displayed rather than dropped or silently folded into an existing bucket.
// Pure: never throws on malformed input, never touches the DOM or network.
const KNOWN_TALLY_POSITIONS = ['yea', 'nay', 'not_voting', 'absent'];

export function tallyPositions(castRows) {
  const result = {
    yea: 0, nay: 0, not_voting: 0, absent: 0, other: {},
  };
  for (const row of (Array.isArray(castRows) ? castRows : [])) {
    if (!row) continue;
    const { position } = row;
    if (typeof position === 'string' && KNOWN_TALLY_POSITIONS.includes(position)) {
      result[position] += 1;
    } else {
      const key = typeof position === 'string' ? position : String(position);
      result.other[key] = (result.other[key] || 0) + 1;
    }
  }
  return result;
}

// Raw '- ' line count, MOVED-BY-REFERENCE from src/cli/verify.js's own countRawBulletLines (task-9
// brief: "reimplementing that 3-line counter in the page module is fine, comment the source") —
// not imported (verify.js is a Node-only CLI module with no business being pulled into a browser
// bundle graph), just the identical 2-line body, so this page's coverage check stays byte-for-byte
// consistent with the verifier's own completeness gate (checkBulletCoverage, src/cli/verify.js).
function countRawBulletLines(bodyMd) {
  return String(bodyMd || '').split('\n').filter((raw) => /^- /.test(raw.trim())).length;
}

export const PLAIN_TEXT_FALLBACK_NOTE = 'Formatting could not be verified for this summary — shown as plain text below.';

// renderSummaryStructured(bodyMd) -> the parsed structure to render, via Task 4's shared parsers
// (parseBullets/extractStatedPurpose — never a lookalike client-side markdown parse, which would
// be the client inventing display facts).
//
// Coverage rule (spec-critical, mirrors the verifier's own checkBulletCoverage): if parseBullets
// yields FEWER bullets than body_md's raw '- ' line count, the parse is incomplete (an edited/
// malformed bullet is invisible to the structured view) — PLAIN-TEXT fallback instead of a
// half-rendered structured view.
//
// Fix round 1, MED-2 (task-9 review, "the vacuous-empty class, 4th appearance"): a structureless
// published body_md (zero bullets AND no stated purpose) used to render the STRUCTURED branch with
// nothing in it — an empty summary section carrying only a "verified clean" receipt underneath,
// which misleadingly implies substantive content was checked when the page shows none at all.
// Split into two honest outcomes instead: body_md that is genuinely blank (`isEmpty: true`, no
// receipt line — there is nothing to have verified) vs. body_md that has REAL content the shared
// parsers just don't recognize as bullets/purpose (the plain-text fallback, same as the coverage-
// gap case, so at least the authored text still renders instead of vanishing).
//
// `formattingVerified`/`isEmpty` are the discriminators the render layer branches on;
// `statedPurpose`/`bullets` stay present (empty) on both fallback branches so every caller can
// destructure the same shape without an extra null-check.
export function renderSummaryStructured(bodyMd) {
  const text = String(bodyMd || '');
  const bullets = parseBullets(text);
  const statedPurpose = extractStatedPurpose(text);

  if (bullets.length === 0 && !statedPurpose) {
    if (text.trim() === '') {
      return {
        formattingVerified: true, isEmpty: true, statedPurpose: null, bullets: [], plainTextLines: [], note: null,
      };
    }
    return {
      formattingVerified: false,
      isEmpty: false,
      statedPurpose: null,
      bullets: [],
      plainTextLines: text.split('\n').filter((line) => line.trim() !== ''),
      note: PLAIN_TEXT_FALLBACK_NOTE,
    };
  }

  const rawBulletLineCount = countRawBulletLines(text);
  if (bullets.length < rawBulletLineCount) {
    return {
      formattingVerified: false,
      isEmpty: false,
      statedPurpose: null,
      bullets: [],
      plainTextLines: text.split('\n').filter((line) => line.trim() !== ''),
      note: PLAIN_TEXT_FALLBACK_NOTE,
    };
  }

  return {
    formattingVerified: true, isEmpty: false, statedPurpose, bullets, plainTextLines: [], note: null,
  };
}

export const NO_SUMMARY_NOTE = 'No plain-language summary yet — the facts above are the record.';

// buildVerificationNote({summary, note, noteUnavailable}) -> the exact receipt sentence (task-9
// brief, verbatim): "Summary by {summaries.model}, adversarially verified {overall} by
// {note.model} on {date}" — the trust-model-v3 receipt that this text passed adversarial
// verification. `note` is a public_verification_notes row (migration 0016: summary_id, model,
// prompt_version, overall, created_at) or null.
//
// Fix round 1, LOW-6 (task-9 review): "no verification record on file" (the fetch SUCCEEDED and
// legitimately found zero rows) and "verification record could not be loaded" (the fetch itself
// FAILED) are different facts — collapsing them into one string would claim more certainty than
// either case alone supports. `noteUnavailable` is the caller's own signal for which happened;
// `note === null` with `noteUnavailable` false/omitted means the former.
// Pure: never throws, never touches the DOM.
export function buildVerificationNote({ summary, note, noteUnavailable } = {}) {
  if (!summary) return NO_SUMMARY_NOTE;
  const model = summary.model || '(model unrecorded)';
  if (noteUnavailable) return `Summary by ${model} — verification record could not be loaded.`;
  if (!note) return `Summary by ${model} — no verification record on file.`;
  const date = String(note.created_at || '').slice(0, 10) || '(date unrecorded)';
  return `Summary by ${model}, adversarially verified ${note.overall} by ${note.model} on ${date}.`;
}

export const MO_DISCLAIMER_TEXT = 'Bill text and status shown are not official copies; the official record is at the linked source.';
export const BILL_NOT_FOUND_MESSAGE = 'No such bill in our data.';

// ============================================================================
// Small rendering helpers (DOM, not independently unit-tested — same convention as
// person-page.js's own DOM helpers; smoke-tested live per the controller's Step 4).
// ============================================================================

// Mirrors person-page.js's billHref exactly, in reverse direction (a bill linking OUT to a
// sponsor's profile instead of a profile linking IN to a bill) — the SAME /person/<id>/<slug> and
// /legislator/<id>/<slug> shapes, never a third link scheme.
function personHref(legislator) {
  const displayName = legislator?.full_name || '(name unrecorded)';
  return legislator?.person_id
    ? `/person/${legislator.person_id}/${slugify(displayName)}`
    : `/legislator/${legislator?.id}/${slugify(displayName)}`;
}

// Fix round 1, LOW-3 (task-9 review): the bill page's own noun ("No such bill," never person-
// page.js's "No such profile" wording) — reuses sectionState's 'failed' visual/semantic weight
// exactly like person-page.js's renderNotFound, but is NOT imported from person-page.js (that
// module hardcodes its own profile-specific message). Deliberately NEVER offered a retry button
// (task-9 review, explicit: "no retry button for a genuine not-found — mirror person-page's
// uuid-reject path") — both call sites below (a malformed/non-uuid URL, and a well-formed uuid
// that resolves to zero rows) are treated the same honest way: retrying the identical lookup
// against a bill id that plainly does not exist would only ever fail again the same way.
function renderBillNotFound(container) {
  sectionState(container, { state: 'failed', message: BILL_NOT_FOUND_MESSAGE });
}

// Fix round 1, LOW-7 (task-9 review): a not-found bill must not leave the static "Sponsors" /
// "Plain-language summary" / "Roll calls" headings (and their now-permanently-empty sections)
// visible below the not-found message — that would misleadingly imply those sections exist for a
// bill that does not. Toggled via a class on <main id="app"> (site/css/site.css hides the
// non-identity h2s and sections when it's present) rather than clearChildren-ing #app outright, so
// a later successful retry-driven re-render (bootstrapBillPage called again) can simply toggle the
// class back off without needing to reconstruct any removed DOM.
function setNotFoundLayout(isNotFound) {
  const app = document.getElementById('app');
  if (app) app.classList.toggle('bill-not-found', Boolean(isNotFound));
}

function renderIdentity(container, bill) {
  clearChildren(container);
  container.appendChild(el('h1', {}, bill.identifier || '(identifier unrecorded)'));
  container.appendChild(el('p', { class: 'bill-title' }, bill.title || '(title unrecorded)'));

  // Numeric MO status codes omitted (task-9 brief: "bills.status for MO bills is currently a bare
  // numeric LegiScan code ... a status matching /^\d+$/ renders NOTHING — a data correction is
  // pending Lance approval"). Reuses person-page.js's isNumericStatusCode verbatim (see that
  // module's own doc comment for the full rationale) rather than a second copy of the same
  // temporary-display-honesty predicate. Federal statuses are printed sentences and always render.
  if (bill.status && !isNumericStatusCode(bill.status)) {
    container.appendChild(el('p', { class: 'bill-status' }, `Status: ${bill.status}`));
  }

  const session = bill.sessions || null;
  const jurisdiction = session?.jurisdictions || null;

  // Fix round 1, LOW-2 (task-9 review): a null session embed (the bill's session_id doesn't
  // resolve, or the embed simply came back empty) used to render NO session line at all — now an
  // honest 'Session unrecorded' state, same as any other unrecorded fact on this site.
  const sessionLabel = session ? [jurisdiction?.name, session.name || session.identifier].filter(Boolean).join(' — ') : '';
  container.appendChild(el('p', { class: 'bill-session' }, sessionLabel || 'Session unrecorded'));

  // Fix round 1, LOW-2: fail TOWARD showing the MO disclaimer — a null session embed means this
  // bill's jurisdiction cannot even be determined, so MO cannot be ruled out. Only a session we
  // POSITIVELY know is NOT mo-legislature suppresses it; an unplaceable bill errs toward showing
  // it rather than silently omitting a disclaimer a real MO bill might have needed.
  const jurisdictionId = session ? session.jurisdiction_id : null;
  const showMoDisclaimer = jurisdictionId == null || jurisdictionId === 'mo-legislature';
  if (showMoDisclaimer) {
    container.appendChild(el('p', { class: 'bill-mo-disclaimer' }, MO_DISCLAIMER_TEXT));
  }

  const url = officialBillUrl(bill);
  if (url) {
    try {
      container.appendChild(el('a', { class: 'bill-official-link', href: url }, 'Official bill text'));
    } catch {
      // A malformed/hostile canonical_url degrades to an honest notice rather than taking the
      // whole identity section down (same containment pattern as receipt links elsewhere).
      container.appendChild(el('span', { class: 'bill-official-link-unavailable' }, 'Official source link unavailable'));
    }
  }
}

const SPONSOR_GROUP_LABELS = {
  primary: 'Primary sponsor',
  cosponsor: 'Cosponsor',
  joint: 'Joint sponsor',
  unspecified: 'Sponsor (type unspecified by source)',
};
const SPONSOR_GROUP_ORDER = ['primary', 'cosponsor', 'joint', 'unspecified'];

function renderSponsors(container, sponsorRows) {
  clearChildren(container);
  const grouped = groupSponsorships(sponsorRows); // can throw UnknownSponsorTypeError — caller wraps
  let renderedAny = false;
  for (const type of SPONSOR_GROUP_ORDER) {
    const rows = grouped[type];
    if (rows.length === 0) continue;
    renderedAny = true;
    const section = el('section', { class: `bill-sponsor-group bill-sponsor-group-${type}` });
    section.appendChild(el('h3', {}, `${SPONSOR_GROUP_LABELS[type]} (${rows.length})`));
    const list = el('ul', {});
    for (const row of rows) {
      const legislator = row.legislators || {};
      const li = el('li', {});
      li.appendChild(el('a', { href: personHref(legislator) }, legislator.full_name || '(name unrecorded)'));
      list.appendChild(li);
    }
    section.appendChild(list);
    container.appendChild(section);
  }
  if (!renderedAny) {
    sectionState(container, { state: 'empty', message: 'No sponsors recorded.' });
  }
}

function formatTallyLine(tally) {
  if (!tally) return 'Recorded-cast tally unavailable for this roll call.';
  const parts = [
    `yea ${tally.yea}`, `nay ${tally.nay}`, `not voting ${tally.not_voting}`, `absent ${tally.absent}`,
  ];
  for (const key of Object.keys(tally.other).sort()) {
    parts.push(`${key} ${tally.other[key]}`);
  }
  return `Recorded casts in our data — ${parts.join(', ')}`;
}

// Fix round 1, HIGH-1 (task-9 review — 7 live unresolved flags all land on the roll-call surface
// that shows printed-result-beside-recorded-tallies, e.g. HB 1623: printed 103-48 beside recorded
// yea 0 nay 1, unexplained without a flag): `flagsUnavailable` and each vote's own `.flagged`
// (attached via person-page.js's joinFlagBadges — the SAME pure join, not a lookalike copy) render
// with the PROFILE PAGE's exact badge markup/text/classes, never a bill-page-specific rewording.
function renderVotes(container, votes, tallyByVoteId, flagsUnavailable) {
  clearChildren(container);
  if (flagsUnavailable) {
    // Exact class/text match to person-page.js's own flagsUnavailable notice — one wording for
    // "we could not confirm flag status," not two that could drift apart.
    container.appendChild(el('p', { class: 'flags-unavailable-notice' }, 'Reconciliation-flag status unavailable for this page.'));
  }
  const list = el('ul', { class: 'bill-vote-list' });
  for (const vote of votes) {
    const li = el('li', { class: 'bill-vote-row' });
    if (vote.jurisdiction_id && vote.chamber) {
      li.appendChild(el('p', { class: 'bill-vote-chamber' }, chamberLabel(vote.jurisdiction_id, vote.chamber)));
    }
    li.appendChild(el('p', { class: 'bill-vote-question' }, vote.question || '(no recorded question)'));
    li.appendChild(el('p', { class: 'bill-vote-result' }, `Result (as printed by the source): ${vote.result || '(not recorded)'}`));
    li.appendChild(el('p', { class: 'bill-vote-tally' }, formatTallyLine(tallyByVoteId.get(vote.id))));
    if (vote.source_url) {
      try {
        li.appendChild(el('a', { class: 'bill-vote-source-link', href: vote.source_url }, 'source'));
      } catch {
        li.appendChild(el('span', { class: 'bill-vote-source-unavailable' }, 'source unavailable'));
      }
    }
    if (vote.flagged) {
      // Exact markup match to person-page.js's renderVoteRow badge — same class, same href, same
      // glyph+text — so a reader who has seen this badge on a profile page recognizes it here too.
      li.appendChild(el('a', { class: 'flag-badge', href: '/trust#flags' }, '⚑ reconciliation flag'));
    }
    list.appendChild(li);
  }
  container.appendChild(list);
}

function renderSummary(container, {
  summary, note, noteUnavailable, glossaryTerms, glossaryUnavailable,
}) {
  clearChildren(container);

  if (!summary) {
    // sectionState's own 'empty' render already prints this (see loadSummarySection below) — this
    // branch only exists so renderSummary stays safe to call directly in isolation.
    container.appendChild(el('p', { class: 'bill-summary-none' }, NO_SUMMARY_NOTE));
    return;
  }

  const structured = renderSummaryStructured(summary.body_md);

  if (structured.isEmpty) {
    // Fix round 1, MED-2: nothing was actually authored — no bullets, no purpose, no plain text
    // either. Rendering the verification-note receipt here would imply substantive content was
    // checked and passed when the page shows none at all — an honest-empty state instead, no
    // receipt line (this function returns here, before the receipt paragraph below is ever built).
    container.appendChild(el('p', { class: 'bill-summary-none' }, 'This bill has a published summary record with no extractable content.'));
    return;
  }

  if (structured.formattingVerified) {
    if (structured.statedPurpose) {
      const p = el('p', { class: 'bill-summary-purpose' });
      // Fix round 1, LOW-4: `inline` (text + <dfn> wraps) goes INTO the <p>; `details` (block-level
      // expandable panels) are appended AFTER it, as siblings in `container` — never nested inside
      // the <p>, which would be invalid structure and broken layout.
      const { inline, details } = renderMarkedText(structured.statedPurpose, glossaryTerms);
      p.appendChild(inline);
      container.appendChild(p);
      for (const detail of details) container.appendChild(detail);
    }
    if (structured.bullets.length > 0) {
      const ul = el('ul', { class: 'bill-summary-bullets' });
      for (const bullet of structured.bullets) {
        const li = el('li', {});
        // A bullet's <li> can validly hold block content directly (unlike the purpose <p> above),
        // so the detail panels are appended as further children of the SAME <li>, after the
        // inline text and section citation — still never nested inside an inline element.
        const { inline, details } = renderMarkedText(bullet.point, glossaryTerms);
        li.appendChild(inline);
        li.appendChild(el('span', { class: 'bill-summary-bullet-section' }, ` (${bullet.section})`));
        for (const detail of details) li.appendChild(detail);
        ul.appendChild(li);
      }
      container.appendChild(ul);
    }
    // Fix round 2, NEW-5 (task-9 re-review, cosmetic): the "glossary unavailable" notice only
    // belongs on THIS branch — the plain-text fallback below never attempts glossary marking at
    // all (it can't trust the parsed bullet/purpose text it would mark), so a fetch failure there
    // is moot: no marking would have applied even on a successful fetch, so nothing to apologize
    // for. LOW-6 (round 1): distinct from "this summary references no glossary terms at all,"
    // which renders no notice because there is nothing wrong to report.
    if (glossaryUnavailable) {
      container.appendChild(el('p', { class: 'bill-glossary-unavailable' }, 'Glossary unavailable for this summary.'));
    }
  } else {
    // Never render half (task-9 brief, spec-critical): the parse coverage gap (or, per MED-2, a
    // structureless-but-non-empty body) means the structured view — and therefore glossary
    // marking, which is built on the parsed bullet text — cannot be trusted. Plain, unmarked text
    // lines instead, with the honest note attached.
    container.appendChild(el('p', { class: 'bill-summary-fallback-note' }, structured.note));
    for (const line of structured.plainTextLines) {
      container.appendChild(el('p', { class: 'bill-summary-plain-line' }, line));
    }
  }

  container.appendChild(el('p', { class: 'bill-verification-note' }, buildVerificationNote({ summary, note, noteUnavailable })));
}

// ============================================================================
// Section orchestration — each independently three-stated (loading/failed/empty/ready), per the
// plan-law quoted at the top of this file.
// ============================================================================

const BILL_SELECT = 'id,identifier,title,status,canonical_url,session_id,'
  + 'sessions(id,identifier,name,jurisdiction_id,jurisdictions(id,name))';

// Fix round 1, LOW-5 (task-9 review): explicit select= for the columns this section actually
// uses (never a bare `*`), and `.nullslast` on the vote_date ordering — Postgres's own default for
// a bare DESC order is NULLS FIRST, which would put undated/procedural votes at the TOP of a
// newest-first roll-call list; `.nullslast` keeps that honestly at the end instead.
const VOTES_SELECT = 'id,jurisdiction_id,chamber,vote_date,question,result,source_url';

// Fix round 1, MED-3 (task-9 review): groupSponsorships can THROW (UnknownSponsorTypeError, a
// sponsor_type outside the 0015 vocabulary) — the fetch AND the render call are now inside the
// SAME try/catch, mirroring person-page.js:774-795's loadSponsorshipsSection exactly, so a
// render-time throw routes to the SAME 'failed'-with-retry state a fetch failure would, instead of
// escaping past an already-cleared-to-'ready' container as an unhandled rejection.
async function loadSponsorsSection(container, { billId }) {
  sectionState(container, { state: 'loading' });
  const reload = () => loadSponsorsSection(container, { billId }).catch(() => {});
  try {
    const rows = (await restGet(`bill_sponsors?bill_id=eq.${billId}&select=sponsor_type,legislators(id,full_name,person_id)`)).rows;
    if (rows.length === 0) {
      sectionState(container, { state: 'empty', message: 'No sponsors recorded.' });
      return;
    }
    sectionState(container, { state: 'ready' });
    renderSponsors(container, rows);
  } catch {
    sectionState(container, {
      state: 'failed', message: "Couldn't load sponsors — retry", onRetry: reload,
    });
  }
}

// Exported (task-9 re-review round 2, HIGH-1) so tests/bill-page.test.js can assert the FULL
// fetch -> join -> render pipeline directly — the reviewer's own point: a fix without a test that
// exercises the real join call site (a raw votes row shaped exactly like the live HB 1623 case) is
// the same hole waiting to reopen.
export async function loadVotesSection(container, { billId }) {
  sectionState(container, { state: 'loading' });
  const reload = () => loadVotesSection(container, { billId }).catch(() => {});
  let votes;
  try {
    votes = (await restGet(`votes?bill_id=eq.${billId}&select=${VOTES_SELECT}&order=vote_date.desc.nullslast`)).rows;
  } catch {
    sectionState(container, {
      state: 'failed', message: "Couldn't load roll calls — retry", onRetry: reload,
    });
    return;
  }
  if (votes.length === 0) {
    sectionState(container, { state: 'empty', message: 'No recorded roll calls for this bill.' });
    return;
  }

  // Some MO roll calls carry 160+ casts (task-9 context) — fetchAllRows per vote, in parallel
  // across votes. A single vote's cast fetch failing is caught PER-VOTE (skip != empty: it maps
  // to `null`, rendered as an honest "tally unavailable," never a false claim of zero casts) so
  // one bad fetch never blanks every other roll call's real tally.
  const tallyByVoteId = new Map();
  const tallyWork = Promise.all(votes.map(async (vote) => {
    try {
      const casts = await fetchAllRows(`vote_casts?vote_id=eq.${vote.id}&select=position`);
      tallyByVoteId.set(vote.id, tallyPositions(casts));
    } catch {
      tallyByVoteId.set(vote.id, null);
    }
  }));

  // HIGH-1 (task-9 review): the SAME reconciliation-flags read + join as the profile page —
  // public_reconciliation_flags?vote_id=in.(...)&resolved=is.false (an ADJUDICATED discrepancy is
  // not an open dispute; only unresolved flags are worth a live badge), joined via
  // person-page.js's own joinFlagBadges (not a lookalike copy). Runs in parallel with the tally
  // fetches above — independent data, no reason to serialize.
  //
  // Fix round 2, HIGH-1 (task-9 re-review, reviewer-verified minimal fix — NOT CLOSED in round 1):
  // joinFlagBadges keys its join on `row.vote_id`. The PROFILE page feeds it public_vote_feed rows,
  // where migration 0016's view aliases `v.id AS vote_id`; THIS page queries the raw `votes` table
  // directly, whose own primary key column is plain `id` — there is no `vote_id` column on these
  // rows at all. Without remapping, every `flaggedIds.has(row.vote_id)` check was
  // `has(undefined)`, always false — the flags fetch itself was correct, joinFlagBadges was
  // correct, this ONE alias gap silently discarded every match (0/1668 tests caught it, because no
  // test exercised the join with a raw-shaped votes row — see the DOM regression test in
  // tests/bill-page.test.js, which reproduces the HB 1623-shaped construction this bug hid behind).
  // `votesWithVoteId` is built ONCE, used as the join's input on both the success and failure
  // paths below; the rows joinFlagBadges RETURNS still carry their real `id` (spread first,
  // `vote_id` added after — `renderVotes` never reads `vote_id`, only `id`).
  const votesWithVoteId = votes.map((v) => ({ ...v, vote_id: v.id }));
  const voteIds = votes.map((v) => v.id).filter(Boolean);
  let flaggedVotes = votesWithVoteId;
  let flagsUnavailable = false;
  const flagsWork = (async () => {
    try {
      const flagRows = voteIds.length > 0
        ? (await restGet(`public_reconciliation_flags?vote_id=in.(${voteIds.join(',')})&resolved=is.false`)).rows
        : [];
      flaggedVotes = joinFlagBadges(votesWithVoteId, flagRows);
    } catch {
      flaggedVotes = joinFlagBadges(votesWithVoteId, []);
      flagsUnavailable = true;
    }
  })();

  await Promise.all([tallyWork, flagsWork]);

  // Fix round 2, NEW-4 (task-9 re-review, LOW — mirrors person-page.js's own HIGH-1 fix from its
  // round 3): the render phase is now INSIDE the same try/catch as everything a render-time throw
  // should route to 'failed' for. Before this, a throw during renderVotes (e.g. a hostile/
  // malformed value tripping render.js's attribute guard, outside the per-row containment
  // renderVotes already has for source links) would escape past the already-painted 'ready' state
  // and be silently swallowed by bootstrapBillPage's own `.catch(() => {})` — a blank section with
  // no failed message and no retry, worse than either honest state.
  try {
    sectionState(container, { state: 'ready' });
    renderVotes(container, flaggedVotes, tallyByVoteId, flagsUnavailable);
  } catch {
    sectionState(container, {
      state: 'failed', message: "Couldn't load roll calls — retry", onRetry: reload,
    });
  }
}

async function loadSummarySection(container, { billId }) {
  sectionState(container, { state: 'loading' });
  const reload = () => loadSummarySection(container, { billId }).catch(() => {});
  let summary;
  try {
    // published_at.desc.nullslast,created_at.desc — same ordering person-page.js's own summaries
    // query uses, so "first row" always means "current published," never an arbitrary/unordered
    // row on a tie or a null published_at.
    const rows = (await restGet(
      `summaries?bill_id=eq.${billId}&status=eq.published&order=published_at.desc.nullslast,created_at.desc`,
    )).rows;
    summary = rows[0] || null;
  } catch {
    sectionState(container, {
      state: 'failed', message: "Couldn't load the summary — retry", onRetry: reload,
    });
    return;
  }

  if (!summary) {
    sectionState(container, { state: 'empty', message: NO_SUMMARY_NOTE });
    return;
  }

  // Verification note and glossary are enhancements ON TOP of an already-successfully-fetched
  // summary, not hard dependencies of it (same "skip != empty" reasoning person-page.js applies to
  // its one-liner/flag-badge fetches) — a failure here degrades to buildVerificationNote's own
  // honest "could not be loaded" fallback / a visible "glossary unavailable" notice (LOW-6), never
  // fails this section outright.
  let note = null;
  let noteUnavailable = false;
  try {
    const noteRows = (await restGet(`public_verification_notes?summary_id=eq.${summary.id}&order=created_at.desc`)).rows;
    note = noteRows[0] || null;
  } catch {
    note = null;
    noteUnavailable = true;
  }

  let glossaryTerms = [];
  let glossaryUnavailable = false;
  try {
    const links = (await restGet(`summary_terms?summary_id=eq.${summary.id}`)).rows;
    const termIds = [...new Set(links.map((l) => l.term_id).filter(Boolean))];
    // MED-1 (task-9 review): order=citation.nullsfirst,id — deterministic fetch order is what
    // makes markTerms' grouping (glossary-inline.js) render every duplicate-named term's citation
    // in a stable, reproducible order rather than whatever order PostgREST happened to return.
    glossaryTerms = termIds.length > 0
      ? (await restGet(`glossary_terms?id=in.(${termIds.join(',')})&status=eq.published&select=id,term,kind,citation,gloss_md,supported_by_quote,source_url&order=citation.nullsfirst,id`)).rows
      : [];
  } catch {
    glossaryTerms = [];
    glossaryUnavailable = true;
  }

  // Fix round 2, NEW-4 (task-9 re-review, LOW — same person-page.js HIGH-1 pattern as
  // loadVotesSection above): render phase inside the fetch's own try/catch, so a render-time throw
  // routes to 'failed' instead of escaping past the painted 'ready' state into bootstrapBillPage's
  // swallowing `.catch(() => {})`.
  try {
    sectionState(container, { state: 'ready' });
    renderSummary(container, {
      summary, note, noteUnavailable, glossaryTerms, glossaryUnavailable,
    });
  } catch {
    sectionState(container, {
      state: 'failed', message: "Couldn't load the summary — retry", onRetry: reload,
    });
  }
}

// Entry point for site/bill.html — exported, never auto-run at module load (same convention as
// bootstrapPersonPage/bootstrapLegislatorPage/bootstrapDirectoryPage).
export async function bootstrapBillPage() {
  const identityContainer = document.getElementById('bill-identity');
  mountFooter(document.getElementById('site-footer'));
  // Reset any not-found layout left over from a prior attempt on this same page load (a retry
  // click re-runs this whole function) before doing anything else.
  setNotFoundLayout(false);

  const billId = idFromPath(window.location.pathname, '/bill/');
  if (!billId) {
    setNotFoundLayout(true);
    renderBillNotFound(identityContainer);
    return;
  }

  sectionState(identityContainer, { state: 'loading' });
  let bill;
  try {
    const { rows } = await restGet(`bills?id=eq.${billId}&select=${BILL_SELECT}`);
    bill = rows[0] || null;
  } catch {
    sectionState(identityContainer, {
      state: 'failed',
      message: "Couldn't load this bill — retry",
      onRetry: () => bootstrapBillPage(),
    });
    return;
  }

  if (!bill) {
    setNotFoundLayout(true);
    renderBillNotFound(identityContainer);
    return;
  }

  sectionState(identityContainer, { state: 'ready' });
  renderIdentity(identityContainer, bill);

  await Promise.all([
    loadSponsorsSection(document.getElementById('bill-sponsors'), { billId }).catch(() => {}),
    loadVotesSection(document.getElementById('bill-votes'), { billId }).catch(() => {}),
    loadSummarySection(document.getElementById('bill-summary'), { billId }).catch(() => {}),
  ]);
}
