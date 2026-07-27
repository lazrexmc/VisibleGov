import { fetchWithLimit } from '../lib/http.js';
import { createLimiter } from '../lib/rate-limiter.js';

export const SOURCE = 'mo-legislature';
// OpenStates free tier is tight (per-minute + daily caps): stay well inside it.
export const moLimiter = createLimiter({ minIntervalMs: 7000 });

const BASE = 'https://v3.openstates.org';

function headers() {
  return { 'X-API-KEY': process.env.OPENSTATES_API_KEY };
}

const OPTION_MAP = new Map([
  ['yes', 'yea'], ['no', 'nay'], ['absent', 'absent'], ['not voting', 'not_voting'],
]);

export function mapOpenstatesOption(raw) {
  return OPTION_MAP.get(String(raw).trim().toLowerCase()) ?? 'other';
}

export function mapChamber(classification) {
  if (classification === 'upper') return 'senate';
  if (classification === 'lower') return 'house';
  return null;
}

export function parseSessions(json) {
  return (json.legislative_sessions ?? []).map((s) => ({
    identifier: String(s.identifier),
    name: s.name ?? null,
    start_date: s.start_date || null,
    end_date: s.end_date || null,
  }));
}

export function parsePerson(json) {
  const p = (json.results ?? [])[0];
  if (!p) throw new Error('people fixture/response has no results');
  const roles = [];
  const allRoles = [p.current_role, ...(p.other_roles ?? [])].filter(Boolean);
  for (const r of allRoles) {
    const chamber = mapChamber(r.org_classification ?? r.classification);
    if (!chamber) continue;
    roles.push({
      chamber,
      district: r.district != null ? String(r.district) : null,
      start_date: r.start_date || null,
      end_date: r.end_date || null,
    });
  }
  return { openstates_id: p.id, full_name: p.name, party: p.party ?? null, roles };
}

export function parseBillsWithVotes(json) {
  return (json.results ?? []).map((b) => ({
    bill: {
      identifier: String(b.identifier),
      title: b.title ?? '',
      status: null, // lifecycle stage mapping is a later-slice concern
      canonical_url: b.openstates_url ?? '',
    },
    votes: (b.votes ?? []).map((v) => ({
      vote: {
        source_key: `mo-${v.id}`,
        // Real OpenStates v3 payload: each vote event carries its own
        // `organization.classification` ('upper'|'lower') directly — verified present on
        // all 95 vote events in tests/fixtures/mo-legislature/bills-with-votes.json.
        // Fall back to the bill's from_organization if a future payload ever omits it.
        chamber: mapChamber(v.organization?.classification) ?? mapChamber(b.from_organization?.classification) ?? 'senate',
        vote_date: v.start_date || null,
        question: v.motion_text ?? '',
        result: v.result ?? '',
        source_url: b.openstates_url ?? '',
      },
      casts: (v.votes ?? []).map((pv) => ({
        openstates_id: pv.voter?.id ?? null,
        voter_name: pv.voter_name ?? pv.voter?.name ?? '',
        position: mapOpenstatesOption(pv.option),
      })),
    })),
  }));
}

export function fetchSessions(limiter = moLimiter) {
  const url = `${BASE}/jurisdictions/ocd-jurisdiction/country:us/state:mo/government?include=legislative_sessions`;
  return fetchWithLimit(url, { source: SOURCE, limiter, headers: headers(), as: 'json' });
}

export function fetchBillsWithVotes(session, page, limiter = moLimiter) {
  const url = `${BASE}/bills?jurisdiction=Missouri&session=${encodeURIComponent(session)}&include=votes&per_page=20&page=${page}`;
  return fetchWithLimit(url, { source: SOURCE, limiter, headers: headers(), as: 'json' });
}

export function fetchPersonById(id, limiter = moLimiter) {
  const url = `${BASE}/people?id=${encodeURIComponent(id)}`;
  return fetchWithLimit(url, { source: SOURCE, limiter, headers: headers(), as: 'json' });
}
