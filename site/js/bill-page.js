// site/js/bill-page.js — the bill page (design spec §4, task-9 brief). Browser-native ES module.
// Same "wiring" layer split as person-page.js/directory-page.js: pure helpers here (TDD'd in
// tests/bill-page.test.js BEFORE the DOM code below existed), DOM/network orchestration after,
// reusing the existing toolbox by exact name — never a lookalike reimplementation: rest.js
// (restGet, fetchAllRows), render.js (el, clearChildren, sectionState), receipts.js
// (officialBillUrl), summary-parse.js (parseBullets, extractStatedPurpose), profile-model.js
// (chamberLabel, groupSponsorships), slugs.js (slugify), person-page.js (idFromPath — uuid-
// validated, reused verbatim for the /bill/<id> parse; isNumericStatusCode and renderNotFound
// reused the same way, see their own call sites below), glossary-inline.js (markTerms,
// renderMarkedText — task 9's own new module).
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
import { idFromPath, isNumericStatusCode, renderNotFound } from './person-page.js';
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
// be the client inventing display facts). Coverage rule (spec-critical, mirrors the verifier's own
// checkBulletCoverage): if parseBullets yields FEWER bullets than body_md's raw '- ' line count,
// the parse is incomplete (an edited/malformed bullet is invisible to the structured view) and
// this returns the PLAIN-TEXT fallback shape instead — never a half-rendered structured view.
// `formattingVerified` is the discriminator the render layer branches on; `statedPurpose`/
// `bullets` stay present (empty) on the fallback branch so every caller can treat the return
// shape uniformly without an extra null-check.
export function renderSummaryStructured(bodyMd) {
  const bullets = parseBullets(bodyMd);
  const rawBulletLineCount = countRawBulletLines(bodyMd);

  if (bullets.length < rawBulletLineCount) {
    return {
      formattingVerified: false,
      statedPurpose: null,
      bullets: [],
      plainTextLines: String(bodyMd || '').split('\n').filter((line) => line.trim() !== ''),
      note: PLAIN_TEXT_FALLBACK_NOTE,
    };
  }

  return {
    formattingVerified: true,
    statedPurpose: extractStatedPurpose(bodyMd),
    bullets,
    plainTextLines: [],
    note: null,
  };
}

export const NO_SUMMARY_NOTE = 'No plain-language summary yet — the facts above are the record.';

// buildVerificationNote({summary, note}) -> the exact receipt sentence (task-9 brief, verbatim):
// "Summary by {summaries.model}, adversarially verified {overall} by {note.model} on {date}" — the
// trust-model-v3 receipt that this text passed adversarial verification. `note` is a
// public_verification_notes row (migration 0016: summary_id, model, prompt_version, overall,
// created_at) or null. Two states are named explicitly by the brief: no published summary at all
// (the exact honest line), and the normal receipt. A published summary with no verification-note
// row on file is a third, defensive case NOT covered by steady-state trust model v3 (publish
// implies verification already happened) but handled honestly rather than assumed impossible.
// Pure: never throws, never touches the DOM.
export function buildVerificationNote({ summary, note } = {}) {
  if (!summary) return NO_SUMMARY_NOTE;
  const model = summary.model || '(model unrecorded)';
  if (!note) return `Summary by ${model} — verification record unavailable.`;
  const date = String(note.created_at || '').slice(0, 10) || '(date unrecorded)';
  return `Summary by ${model}, adversarially verified ${note.overall} by ${note.model} on ${date}.`;
}

export const MO_DISCLAIMER_TEXT = 'Bill text and status shown are not official copies; the official record is at the linked source.';

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
  if (session) {
    const sessionLabel = [jurisdiction?.name, session.name || session.identifier].filter(Boolean).join(' — ');
    container.appendChild(el('p', { class: 'bill-session' }, sessionLabel || 'Session unrecorded'));
  }

  const isMoBill = session?.jurisdiction_id === 'mo-legislature';
  if (isMoBill) {
    // "Facts always" (design spec §4): every MO bill carries this disclaimer, regardless of
    // whether an official link is on file — a missing link is itself worth stating honestly.
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
  const grouped = groupSponsorships(sponsorRows);
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

function renderVotes(container, votes, tallyByVoteId) {
  clearChildren(container);
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
    list.appendChild(li);
  }
  container.appendChild(list);
}

function renderSummary(container, { summary, note, glossaryTerms }) {
  clearChildren(container);

  if (!summary) {
    // sectionState's own 'empty' render already prints this (see loadSummarySection below) — this
    // branch only exists so renderSummary stays safe to call directly in isolation.
    container.appendChild(el('p', { class: 'bill-summary-none' }, NO_SUMMARY_NOTE));
    return;
  }

  const structured = renderSummaryStructured(summary.body_md);

  if (structured.formattingVerified) {
    if (structured.statedPurpose) {
      const p = el('p', { class: 'bill-summary-purpose' });
      p.appendChild(renderMarkedText(structured.statedPurpose, glossaryTerms));
      container.appendChild(p);
    }
    if (structured.bullets.length > 0) {
      const ul = el('ul', { class: 'bill-summary-bullets' });
      for (const bullet of structured.bullets) {
        const li = el('li', {});
        li.appendChild(renderMarkedText(bullet.point, glossaryTerms));
        li.appendChild(el('span', { class: 'bill-summary-bullet-section' }, ` (${bullet.section})`));
        ul.appendChild(li);
      }
      container.appendChild(ul);
    }
  } else {
    // Never render half (task-9 brief, spec-critical): the parse coverage gap means the
    // structured view (and therefore glossary marking, which is built on the parsed bullet text)
    // cannot be trusted — plain, unmarked text lines instead, with the honest note attached.
    container.appendChild(el('p', { class: 'bill-summary-fallback-note' }, structured.note));
    for (const line of structured.plainTextLines) {
      container.appendChild(el('p', { class: 'bill-summary-plain-line' }, line));
    }
  }

  container.appendChild(el('p', { class: 'bill-verification-note' }, buildVerificationNote({ summary, note })));
}

// ============================================================================
// Section orchestration — each independently three-stated (loading/failed/empty/ready), per the
// plan-law quoted at the top of this file.
// ============================================================================

const BILL_SELECT = 'id,identifier,title,status,canonical_url,session_id,'
  + 'sessions(id,identifier,name,jurisdiction_id,jurisdictions(id,name))';

async function loadSponsorsSection(container, { billId }) {
  sectionState(container, { state: 'loading' });
  const reload = () => loadSponsorsSection(container, { billId }).catch(() => {});
  let rows;
  try {
    rows = (await restGet(`bill_sponsors?bill_id=eq.${billId}&select=sponsor_type,legislators(id,full_name,person_id)`)).rows;
  } catch {
    sectionState(container, {
      state: 'failed', message: "Couldn't load sponsors — retry", onRetry: reload,
    });
    return;
  }
  if (rows.length === 0) {
    sectionState(container, { state: 'empty', message: 'No sponsors recorded.' });
    return;
  }
  sectionState(container, { state: 'ready' });
  renderSponsors(container, rows);
}

async function loadVotesSection(container, { billId }) {
  sectionState(container, { state: 'loading' });
  const reload = () => loadVotesSection(container, { billId }).catch(() => {});
  let votes;
  try {
    votes = (await restGet(`votes?bill_id=eq.${billId}&order=vote_date.desc`)).rows;
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
  await Promise.all(votes.map(async (vote) => {
    try {
      const casts = await fetchAllRows(`vote_casts?vote_id=eq.${vote.id}&select=position`);
      tallyByVoteId.set(vote.id, tallyPositions(casts));
    } catch {
      tallyByVoteId.set(vote.id, null);
    }
  }));

  sectionState(container, { state: 'ready' });
  renderVotes(container, votes, tallyByVoteId);
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
  // honest "verification record unavailable" fallback / an empty glossary, never fails this
  // section outright.
  let note = null;
  try {
    const noteRows = (await restGet(`public_verification_notes?summary_id=eq.${summary.id}&order=created_at.desc`)).rows;
    note = noteRows[0] || null;
  } catch {
    note = null;
  }

  let glossaryTerms = [];
  try {
    const links = (await restGet(`summary_terms?summary_id=eq.${summary.id}`)).rows;
    const termIds = [...new Set(links.map((l) => l.term_id).filter(Boolean))];
    glossaryTerms = termIds.length > 0
      ? (await restGet(`glossary_terms?id=in.(${termIds.join(',')})&status=eq.published&select=id,term,kind,citation,gloss_md,supported_by_quote,source_url`)).rows
      : [];
  } catch {
    glossaryTerms = [];
  }

  sectionState(container, { state: 'ready' });
  renderSummary(container, { summary, note, glossaryTerms });
}

// Entry point for site/bill.html — exported, never auto-run at module load (same convention as
// bootstrapPersonPage/bootstrapLegislatorPage/bootstrapDirectoryPage).
export async function bootstrapBillPage() {
  const identityContainer = document.getElementById('bill-identity');
  mountFooter(document.getElementById('site-footer'));

  const billId = idFromPath(window.location.pathname, '/bill/');
  if (!billId) {
    renderNotFound(identityContainer);
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
    renderNotFound(identityContainer, () => bootstrapBillPage());
    return;
  }

  sectionState(identityContainer, { state: 'ready' });
  renderIdentity(identityContainer, bill);

  await Promise.all([
    loadSponsorsSection(document.getElementById('bill-sponsors'), { billId }),
    loadVotesSection(document.getElementById('bill-votes'), { billId }),
    loadSummarySection(document.getElementById('bill-summary'), { billId }),
  ]);
}
