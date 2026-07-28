import { XMLParser } from 'fast-xml-parser';
import { fetchWithLimit } from '../lib/http.js';
import { createLimiter } from '../lib/rate-limiter.js';

export const SOURCE = 'mo-house-xml';

// house.mo.gov's own published ToU (tests/fixtures/research/mo-house-xml/
// xml-bill-list-instructions-doc.html, quoted verbatim): "Do not automate scripts to pull down
// information more often than once every half hour." Mechanically enforced, not just
// documented — every fetch* function below defaults to this shared limiter.
export const MO_HOUSE_MIN_INTERVAL_MS = 30 * 60 * 1000;
export const moHouseLimiter = createLimiter({ minIntervalMs: MO_HOUSE_MIN_INTERVAL_MS });

// SessionSet.js (tests/fixtures/research/mo-house-xml/session-set.js) hardcodes the current
// session's URL-path code as '261'. Per docs/research/2026-07-27-mo-data-sources.md (Q4,
// VERIFIED-BY-PAYLOAD): session 261 = "2026 2nd Regular, 103rd General Assembly". This is the
// House XML export's OWN session-naming scheme — a different identifier space from OpenStates'
// session keys already used by src/adapters/mo-legislature.js (e.g. '2022', '2022S1'). Both are
// stored as separate `sessions` rows under jurisdiction_id='mo-legislature' (keyed on
// (jurisdiction_id, identifier)) since they represent different source systems' naming for the
// same government sessions, not a single canonical key.
export const DEFAULT_MO_HOUSE_SESSION = '261';
export const MO_HOUSE_SESSION_NAME = '2026 2nd Regular, 103rd General Assembly';

const BASE = 'https://documents.house.mo.gov/xml';

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

function asArray(x) {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

function trimmedString(v) {
  return v == null ? '' : String(v).trim();
}

// ---- identifiers ----

// MO House XML's own BillNumber field is a bare 'HB1800'/'HJR28' (no space) — normalize to the
// same 'TYPE NNN' shape normalizeBillIdentifier (us-congress.js) uses, so downstream code (vote
// source_key construction, display) can treat every jurisdiction's identifiers uniformly. Not
// reused directly from us-congress.js because that function requires a pre-existing space
// between type and number (`^([A-Z .]+?)\s+(\d+)$`), which MO's un-spaced BillNumber never has.
export function normalizeMoBillIdentifier(billNumber) {
  const s = trimmedString(billNumber).toUpperCase();
  const m = s.match(/^([A-Z]+)(\d+)$/);
  if (!m) return s;
  return `${m[1]} ${m[2]}`;
}

// ---- BillList.XML / MemberList.XML (the two "index" documents) ----

// Deviation from the research doc's proposed shape (docs/research/2026-07-27-mo-data-sources.md,
// "Proposed adapter shape"): that shape guessed `{ bill_number, title, sponsor, last_action_date,
// bill_xml_url }`. THE FIXTURE IS THE SOURCE OF TRUTH — verified against the real, live-captured
// tests/fixtures/research/mo-house-xml/bill-list-sample-truncated.xml (and confirmed by
// xml-bill-exports-schema-doc.html's own documented BillXML element list), the real BillList.XML
// carries ONLY BillType/BillNumber/SessionYear/SessionCode/BillXMLLink/LastTimeRun per bill — no
// title, sponsor, or last_action_date. Those only exist in each bill's own per-bill XML
// (parseMoBillXml below). This returns what the source actually provides; title/sponsor/status
// come from the per-bill detail fetch, not the list.
export function parseMoBillList(xmlString) {
  const doc = xml.parse(xmlString);
  const entries = asArray(doc.ROOT?.BillXML);
  return entries.map((e) => {
    const billType = trimmedString(e.BillType);
    const billNumber = trimmedString(e.BillNumber);
    return {
      bill_type: billType,
      bill_number: billNumber,
      identifier: normalizeMoBillIdentifier(`${billType}${billNumber}`),
      session_year: e.SessionYear != null ? String(e.SessionYear) : null,
      session_code: e.SessionCode ?? null,
      bill_xml_url: e.BillXMLLink ?? null,
      last_time_run: e.LastTimeRun ?? null,
    };
  });
}

// Same reality-check as parseMoBillList: MemberList.XML only indexes district -> per-district
// XML link (RepresentativeDistrict/RepresentativeXMLLink/LastTimeRun) — name/party/etc. live in
// each district's own RepresentativeXML document (parseMoRepresentative below).
//
// NOTE (leading-zero trap): fast-xml-parser auto-coerces numeric-looking element text to JS
// numbers, so a raw '<RepresentativeDistrict>001</RepresentativeDistrict>' parses to the number
// 1, not the string '001' — String(1) === '1' loses the zero-padding the URL segment ('261-
// 001.xml') visibly has. This is harmless here because `representative_xml_url` is always used
// verbatim (never reconstructed from the bare district number), and parseMoRepresentative's
// DistrictNum goes through the exact same coercion, so join keys built from either side stay
// internally consistent even though neither is zero-padded.
export function parseMoMemberList(xmlString) {
  const doc = xml.parse(xmlString);
  const entries = asArray(doc.ROOT?.RepresentativeXML);
  return entries.map((e) => ({
    district: String(e.RepresentativeDistrict ?? '').trim(),
    representative_xml_url: e.RepresentativeXMLLink ?? null,
    last_time_run: e.LastTimeRun ?? null,
  }));
}

// Roster entry shape per task-4-brief.md: { mo_house_id: district number as text, surname,
// full_name, party }. mo_house_id is the identity key migration 0005 (draft) adds to
// legislators.
export function parseMoRepresentative(xmlString) {
  const doc = xml.parse(xmlString);
  const info = doc.ROOT?.RepresentativeData?.RepresentativeInfo;
  if (!info) throw new Error('representative XML has no RepresentativeInfo');
  const surname = trimmedString(info.LastName);
  const firstName = trimmedString(info.FirstName);
  return {
    mo_house_id: info.DistrictNum != null ? String(info.DistrictNum) : '',
    surname,
    full_name: [firstName, surname].filter(Boolean).join(' '),
    party: info.Party ?? null,
  };
}

// ---- per-bill detail XML ----

// Action-level RollCall (schema doc: nested directly under Action) is AGGREGATE-ONLY —
// TotalYes/TotalNo/TotalPresent, never individual votes, never a PDF link. This is the ONLY
// place a roll call's date + motion text (the Action's own Description) live.
function extractActionRollcalls(actions) {
  return actions
    .filter((a) => a.RollCall)
    .map((a) => ({
      date: a.PubDate ?? null,
      motion: trimmedString(a.Description),
      yes: Number(a.RollCall.TotalYes ?? 0),
      no: Number(a.RollCall.TotalNo ?? 0),
      present: Number(a.RollCall.TotalPresent ?? 0),
    }));
}

// BillText > RollCalls > RollCall (schema doc: nested under a bill-text version) is the ONLY
// place RollCallPDF/SessionDay/RollCallNumber live — but this element has no date or motion of
// its own. The two roll-call representations are joined below by exact tally match.
function extractPdfRollcalls(billTexts) {
  const out = [];
  for (const bt of billTexts) {
    for (const rc of asArray(bt.RollCalls?.RollCall)) {
      out.push({
        yes: Number(rc.TotalYes ?? 0),
        no: Number(rc.TotalNo ?? 0),
        present: Number(rc.TotalPresent ?? 0),
        pdf_url: rc.RollCallPDF ?? null,
        session_day: rc.SessionDay != null ? String(rc.SessionDay) : null,
        roll_call_number: rc.RollCallNumber != null ? String(rc.RollCallNumber) : null,
      });
    }
  }
  return out;
}

// Pure join: house.mo.gov's XML never gives a single element carrying BOTH a roll call's
// date/motion AND its PDF link (see the two extract* functions above) — the only shared key
// between the Action-level aggregate and the BillText-level PDF entry is the tally itself
// (TotalYes/TotalNo/TotalPresent, identical in both places for the same real-world vote,
// confirmed against HB1800's floor vote: 82/61/2 in both). Each pdf-rollcall is consumed at
// most once (pool.splice) so two action-rollcalls can never both claim the same PDF link even
// if their tallies happen to collide — an unmatched action-rollcall (committee votes, which
// never get a RollCallPDF at all per the research doc) simply keeps pdf_url: null, honestly.
export function joinRollcalls(actionRollcalls, pdfRollcalls) {
  const pool = [...pdfRollcalls];
  return actionRollcalls.map((rc) => {
    const idx = pool.findIndex((p) => p.yes === rc.yes && p.no === rc.no && p.present === rc.present);
    if (idx === -1) return { ...rc, pdf_url: null, session_day: null, roll_call_number: null };
    const [match] = pool.splice(idx, 1);
    return { ...rc, pdf_url: match.pdf_url, session_day: match.session_day, roll_call_number: match.roll_call_number };
  });
}

// parseMoBillXml(xml) -> { bill, actions, rollcalls } per task-4-brief.md. `rollcalls` carries
// aggregate tallies + (when matched) a RollCallPDF link — never individual casts (Task 4b's
// job, gated on pdfjs-dist + migration 0005).
export function parseMoBillXml(xmlString) {
  const doc = xml.parse(xmlString);
  const info = doc.ROOT?.BillInformation;
  if (!info) throw new Error('bill XML has no BillInformation');

  const billNumber = trimmedString(info.BillNumber);
  const actions = asArray(info.Action);
  const billTexts = asArray(info.BillText);
  const sponsors = asArray(info.Sponsor);
  const sponsor = sponsors.find((s) => s.SponsorType === 'Sponsor') ?? sponsors[0] ?? null;
  // Every Action.Link for a given bill points to the same house.mo.gov bill page (verified
  // across all 26 actions on the HB1800 fixture) — take the first non-empty one as the
  // canonical URL rather than trying to pick a "best" action.
  const canonicalUrl = actions[0]?.Link ? trimmedString(actions[0].Link) : null;

  const rollcalls = joinRollcalls(extractActionRollcalls(actions), extractPdfRollcalls(billTexts));

  return {
    bill: {
      identifier: normalizeMoBillIdentifier(billNumber),
      // LongTitle reads as an actual descriptive sentence (matches how us-congress/mo-legislature
      // `title` fields read elsewhere); ShortTitle is closer to a subject tag (e.g. "REAL
      // PROPERTY ASSESSMENTS") — fall back to it only if LongTitle is somehow absent.
      title: info.Title?.LongTitle || info.Title?.ShortTitle || '',
      // Raw latest-action text, same convention as us-congress.js's parseBillDetail
      // (`status: b.latestAction?.text ?? null`) — no lifecycle-stage judgment computed here.
      status: info.LastAction ?? null,
      canonical_url: canonicalUrl,
      sponsor_name: sponsor?.FullName ?? null,
      sponsor_district: sponsor?.District != null ? String(sponsor.District) : null,
    },
    actions: actions.map((a) => ({
      description: trimmedString(a.Description),
      date: a.PubDate ?? null,
    })),
    rollcalls,
  };
}

// ---- votes rows ----

// source_key 'mo-house-xml-<bill_identifier>-<n>' per task-4-brief.md, n = 1-based ordinal
// within the bill in document order. The identifier's internal space is stripped for the key
// ('HB 1800' -> 'HB1800') to match every other adapter's space-free source_key convention (e.g.
// 'us-house-119-2025-123', 'us-senate-119-1-616') — the space-carrying `bill_identifier` itself
// is never used as a raw key elsewhere in the schema.
//
// result: the XML never prints an explicit pass/fail word on a roll call (only
// TotalYes/TotalNo/TotalPresent, on both the Action-level aggregate and the BillText-level PDF
// entry) — per task-4-brief.md: "if the XML only gives numbers, result = 'Y-N' numeric string,
// documented". No pass/fail judgment is computed from the tallies or from the Action's
// Description text (e.g. "...Passed...") even though that word is visually suggestive; only the
// literal printed numbers go into `result`.
export function buildMoVoteRows(billIdentifier, rollcalls) {
  const key = String(billIdentifier).replace(/\s+/g, '');
  return rollcalls.map((rc, i) => ({
    source_key: `mo-house-xml-${key}-${i + 1}`,
    chamber: 'house',
    vote_date: rc.date,
    question: rc.motion,
    result: `${rc.yes}-${rc.no}`,
    source_url: rc.pdf_url ?? null,
  }));
}

// ---- fetchers (all through moHouseLimiter by default — house.mo.gov ToU: <= 1 req/30min) ----

export function fetchMoBillList(session = DEFAULT_MO_HOUSE_SESSION, limiter = moHouseLimiter) {
  const url = `${BASE}/${session}-BillList.XML`;
  return fetchWithLimit(url, { source: SOURCE, limiter, as: 'text' });
}

// bill_xml_url/representative_xml_url come from a prior fetch (BillList/MemberList) as full
// URLs already — fetched verbatim, never reconstructed.
export function fetchMoBillXml(billXmlUrl, limiter = moHouseLimiter) {
  return fetchWithLimit(billXmlUrl, { source: SOURCE, limiter, as: 'text' });
}

export function fetchMoMemberList(session = DEFAULT_MO_HOUSE_SESSION, limiter = moHouseLimiter) {
  const url = `${BASE}/${session}-MemberList.XML`;
  return fetchWithLimit(url, { source: SOURCE, limiter, as: 'text' });
}

export function fetchMoRepresentative(representativeXmlUrl, limiter = moHouseLimiter) {
  return fetchWithLimit(representativeXmlUrl, { source: SOURCE, limiter, as: 'text' });
}
