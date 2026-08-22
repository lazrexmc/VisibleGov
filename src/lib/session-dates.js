// Session start dates for Missouri sessions — the data behind "recency-first" ordering.
//
// WHY THIS EXISTS (2026-08-21): 30 of the 31 `sessions` rows for mo-legislature carried a NULL
// start_date. Every writer that created those rows (ingest-legiscan, ingest-mo-house,
// ingest-mo-senate) mints a session from its own source's identifier + name and never knows a
// date; the one writer that DOES carry dates (src/cli/ingest.js via OpenStates' session list)
// writes with insert-if-absent, so it only ever dated the single session it was run for and
// never patched rows another driver had already created. Net effect: the exporter's documented
// "newest session first" sort (scripts/export-summary-wave.mjs) silently degraded to arbitrary
// order for 2,388 of 2,521 queued bills. This module is the fix's pure core; the CLI
// (src/cli/sync-session-dates.js) and the exporter import it.
//
// SOURCES, in authority order — every written value names its source:
//   1. Missouri Constitution, Art. III §20 (effective 1988-12-08, revisor.mo.gov): "The general
//      assembly shall meet on the first Wednesday after the first Monday in January following
//      each general election" and reconvenes on the same rule each year after the May 30
//      adjournment. For a REGULAR session the convening date is therefore deterministic from
//      the year alone (`convenesOn`). OpenStates' published start dates agree with this rule for
//      every regular session 2012-2026 except 2018, where OpenStates publishes 2017-12-01 — the
//      prefiling date, not the convening date. The rule wins; the disagreement is recorded.
//   2. OpenStates' jurisdiction session list (v3.openstates.org, legislative_sessions) — the only
//      source on hand with special-session dates (identifiers YYYYS1/YYYYS2, names "First/1st
//      Extraordinary Session"). Used as-published for specials, and as corroboration for regular
//      sessions. Known defect guarded below: 2022S1 is published with end_date 2021-09-23, a
//      year before its start — an end earlier than its start is refused, never written.
//   3. The earliest recorded bill action inside the session's own LegiScan dataset (the local,
//      hash-verified cache the vote ingest already uses). For SPECIAL sessions this is the
//      better-attested date: measured 2026-08-21 it agrees with OpenStates on 7 of 11 specials
//      and is EARLIER on 4 (2017 S1 05-22 vs 06-01, 2017 S2 06-12 vs 07-25, 2018 S1 05-18 vs
//      05-21, 2022 S1 09-14 vs 09-15) — a recorded bill action proves the session had already
//      begun, so a later OpenStates date is provably not the start. It also dates the three
//      specials OpenStates does not list (2010, 2011, 2013). Rule: a special takes the EARLIER
//      of the two sources, and the source written is named — with two guards the adversarial
//      review (2026-08-21) earned: (a) a LegiScan date outside the session's own year is never
//      written (the same datasets demonstrably carry stray out-of-session entries: the 2017
//      Regular dataset has HR9 "Offered" dated 2016-01-06, 2021's has a 2020-11-20 prefile,
//      2023's carries 2022-10-17 governor messages) — it is reported as out-of-year and the
//      OpenStates date, if any, is written alone; (b) "both sources" is claimed only when the
//      two dates are IDENTICAL — a first reading weeks after OpenStates' start neither
//      contradicts nor corroborates it, and the note says so. The LegiScan minimum is never
//      used for regular sessions: their earliest action is normally the December 1 prefiling,
//      and three datasets carry even earlier strays, which is exactly why guard (a) exists.
//
// Only start_date is written. end_date is deliberately out of scope: OpenStates' regular-session
// end dates mix the constitutional May 30 adjournment with the bill-deadline Friday (and one
// Sunday), so writing them would fill a column with values of mixed meaning.
//
// Writes are additive (PLAYBOOK §3.5): a row that already has a start_date is never touched.

export const MO_CONST_SOURCE = 'mo-const-art3-s20';
export const OPENSTATES_SOURCE = 'openstates';
export const LEGISCAN_ACTION_SOURCE = 'legiscan-earliest-recorded-action';
export const BOTH_SOURCES = 'openstates+legiscan-earliest-recorded-action';

const pad2 = (n) => String(n).padStart(2, '0');

// First Wednesday after the first Monday in January of `year` (Mo. Const. art. III §20).
export function convenesOn(year) {
  const y = Number(year);
  if (!Number.isInteger(y) || y < 1989) throw new Error(`convenesOn: year ${year} is outside the 1988 rule's effect`);
  const jan1Dow = new Date(Date.UTC(y, 0, 1)).getUTCDay(); // 0 = Sunday .. 6 = Saturday
  const firstMonday = 1 + ((1 - jan1Dow + 7) % 7);
  const wednesdayAfter = firstMonday + 2;
  return `${y}-01-${pad2(wednesdayAfter)}`;
}

const ORDINAL_WORDS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5 };

// "1st" / "2nd" / "First" / "Second" -> 1 / 2; null when no ordinal is present.
export function parseOrdinal(text) {
  const s = String(text ?? '').toLowerCase();
  const num = /\b(\d+)(?:st|nd|rd|th)\b/.exec(s);
  if (num) return Number(num[1]);
  for (const [word, n] of Object.entries(ORDINAL_WORDS)) if (new RegExp(`\\b${word}\\b`).test(s)) return n;
  return null;
}

// Year from a session's own identifier or name — the fallback the exporter needs when a row
// carries no date. Returns null when neither holds a four-digit 20xx year.
export function sessionYear(row) {
  for (const field of [row?.identifier, row?.name]) {
    const m = /\b(20\d{2})\b/.exec(String(field ?? ''));
    if (m) return Number(m[1]);
  }
  return null;
}

// Our own sessions rows: `YYYY` / `261` (regular, year from the name) or `YYYY-special-<legiscan id>`
// with the ordinal in the name ("2025 1st Special Session").
export function classifyMoSessionRow(row) {
  const year = sessionYear(row);
  if (year == null) return null;
  const identifier = String(row?.identifier ?? '');
  const name = String(row?.name ?? '');
  // MO House session codes ('261' = 2026 regular) encode the year in their leading two digits;
  // the name is minted from a constant by that driver, so the code must agree with the name's
  // year or the row is reported as unclassified rather than dated from a stale name.
  const houseCode = /^(\d{2})\d$/.exec(identifier);
  if (houseCode && 2000 + Number(houseCode[1]) !== year) return null;
  const special = /-special-\d+$/.test(identifier) || /special|extraordinary/i.test(name);
  if (!special) return { year, kind: 'regular', ordinal: null };
  const ordinal = parseOrdinal(name);
  return ordinal == null ? null : { year, kind: 'special', ordinal };
}

// OpenStates legislative_sessions entries: identifier `YYYY` (regular) or `YYYYS<n>` (special);
// the name carries the ordinal as a word or number. `classification` is NOT trusted — OpenStates
// marks several Missouri extraordinary sessions "primary".
export function classifyOpenStatesSession(s) {
  const m = /^(20\d{2})(?:S(\d+))?$/.exec(String(s?.identifier ?? ''));
  if (!m) return null;
  const year = Number(m[1]);
  if (!m[2]) return { year, kind: 'regular', ordinal: null };
  return { year, kind: 'special', ordinal: Number(m[2]) };
}

const keyOf = (c) => `${c.year}|${c.kind}|${c.ordinal ?? ''}`;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s) => typeof s === 'string' && ISO_DATE.test(s) && !Number.isNaN(Date.parse(s));

// planSessionDates({ rows, openstates, legiscanEarliestAction? }) -> { patches, unchanged, unmatched,
// unclassified, corroboration }
//   rows: our sessions rows (id, identifier, name, start_date, jurisdiction_id)
//   openstates: parsed OpenStates sessions ({identifier, name, start_date, end_date})
//   legiscanEarliestAction: optional Map(sessions.id -> 'YYYY-MM-DD' | { date, bill_number, action, file }),
//     the earliest recorded bill action in that session's LegiScan dataset — used for SPECIAL
//     sessions only (see header); the record form lets the plan note name the evidence.
export function planSessionDates({ rows, openstates, legiscanEarliestAction = new Map() }) {
  const os = new Map();
  for (const s of openstates ?? []) {
    const c = classifyOpenStatesSession(s);
    if (c) os.set(keyOf(c), s);
  }
  const patches = [];
  const unchanged = [];
  const unmatched = [];
  const unclassified = [];
  const corroboration = { regularAgree: 0, regularDisagree: [], specialAgree: 0, specialLegiscanEarlier: [], specialLegiscanLater: [], legiscanOutOfYear: [] };
  const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
  const describe = (rec) => (rec && typeof rec === 'object' ? `${rec.date} (${[rec.bill_number, rec.action].filter(Boolean).join(' ') || 'bill history'}${rec.file ? `, ${rec.file}` : ''})` : String(rec));
  for (const row of rows ?? []) {
    if (row.jurisdiction_id !== 'mo-legislature') continue;
    if (row.start_date) { unchanged.push({ id: row.id, identifier: row.identifier, start_date: row.start_date }); continue; }
    const c = classifyMoSessionRow(row);
    if (!c) { unclassified.push({ id: row.id, identifier: row.identifier, name: row.name }); continue; }
    const published = os.get(keyOf(c));
    if (c.kind === 'regular') {
      const startDate = convenesOn(c.year);
      const notes = [];
      if (published?.start_date) {
        if (published.start_date === startDate) corroboration.regularAgree += 1;
        else {
          corroboration.regularDisagree.push({ identifier: row.identifier, openstates: published.start_date, rule: startDate });
          notes.push(`openstates publishes ${published.start_date}; Mo. Const. art. III §20 convening date ${startDate} written instead`);
        }
      } else {
        notes.push('no OpenStates entry for this session; date from Mo. Const. art. III §20 alone');
      }
      patches.push({ id: row.id, identifier: row.identifier, name: row.name, kind: 'regular', start_date: startDate, source: MO_CONST_SOURCE, notes });
      continue;
    }
    // special session: the earlier of OpenStates' published start and LegiScan's earliest
    // recorded bill action; the source written is named. Neither on hand -> stays NULL, reported.
    const osStart = validDate(published?.start_date) ? published.start_date : null;
    const rec = legiscanEarliestAction.get(row.id);
    const recDate = rec && typeof rec === 'object' ? rec.date : rec;
    const notes = [];
    let earliest = validDate(recDate) ? recDate : null;
    // Guard (a): a LegiScan date outside the session's own year is a stray, never a start.
    if (earliest && Number(earliest.slice(0, 4)) !== c.year) {
      corroboration.legiscanOutOfYear.push({ identifier: row.identifier, year: c.year, legiscan: describe(rec) });
      notes.push(`LegiScan's earliest recorded action ${describe(rec)} lies outside ${c.year} — treated as a stray entry, not used`);
      earliest = null;
    }
    if (!osStart && !earliest) {
      unmatched.push({ id: row.id, identifier: row.identifier, name: row.name, reason: published ? 'openstates entry has no valid start_date and no usable LegiScan dataset on hand' : 'no OpenStates entry and no usable LegiScan dataset on hand for this special session', notes });
      continue;
    }
    if (published && validDate(published.end_date) && osStart && published.end_date < osStart) {
      notes.push(`openstates end_date ${published.end_date} precedes start_date ${osStart} — end refused (not written anyway)`);
    }
    let startDate; let source;
    if (osStart && earliest) {
      if (earliest < osStart) {
        startDate = earliest; source = LEGISCAN_ACTION_SOURCE;
        corroboration.specialLegiscanEarlier.push({ identifier: row.identifier, openstates: osStart, legiscan: earliest });
        notes.push(`openstates publishes ${osStart}, but LegiScan records a bill action ${describe(rec)} — the session had begun by then; earliest recorded action written`);
      } else if (earliest === osStart) {
        startDate = osStart; source = BOTH_SOURCES;
        corroboration.specialAgree += 1;
        notes.push(`both sources agree: LegiScan's earliest recorded action ${describe(rec)} is the OpenStates start`);
      } else {
        // Guard (b): a later first action neither contradicts nor corroborates the published start.
        startDate = osStart; source = OPENSTATES_SOURCE;
        corroboration.specialLegiscanLater.push({ identifier: row.identifier, openstates: osStart, legiscan: earliest, days: daysBetween(osStart, earliest) });
        notes.push(`earliest LegiScan bill action ${describe(rec)} is ${daysBetween(osStart, earliest)} days after the OpenStates start — not contradicted, not corroborated`);
      }
    } else if (earliest) {
      startDate = earliest; source = LEGISCAN_ACTION_SOURCE;
      notes.push(`no OpenStates entry; earliest recorded bill action in the session's LegiScan dataset written: ${describe(rec)} (the session had begun by this date)`);
    } else {
      startDate = osStart; source = OPENSTATES_SOURCE;
      if (!rec) notes.push('no LegiScan dataset on hand to corroborate the OpenStates start');
    }
    patches.push({ id: row.id, identifier: row.identifier, name: row.name, kind: 'special', start_date: startDate, source, openstates_identifier: published?.identifier ?? null, notes });
  }
  return { patches, unchanged, unmatched, unclassified, corroboration };
}

// Recency key for ordering bills by session, newest first. Prefers the real start_date; falls
// back to the year parsed from the session's identifier/name so an undated row still lands in
// its year instead of sorting last. `dated` tells the caller how many rows needed the fallback —
// the exporter reports that count rather than degrading silently.
export function sessionRecencyKey(row) {
  if (row?.start_date) return { key: String(row.start_date), dated: true };
  const year = sessionYear(row);
  if (year != null) return { key: `${year}-00-00`, dated: false }; // sorts before any real date in that year
  return { key: '', dated: false };
}
