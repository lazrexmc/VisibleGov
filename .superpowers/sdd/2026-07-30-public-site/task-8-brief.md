### Task 8: directory + address lookup (+ the geocode function)

**Files:**
- Create: `site/js/directory-page.js` (replaces index placeholder wiring), `site/js/districts.js`, `site/functions/geocode.js`
- Modify: `site/index.html`
- Test: `tests/districts.test.js`, `tests/directory-model.test.js`

**Interfaces:**
- `districts.js` (pure):
  - `parseGeographies(censusJson)` → `{state, cd, sldu, sldl}` — from `result.addressMatches[0].geographies`, matching layer keys by PREFIX: `'Congressional Districts'`, `'State Legislative Districts - Upper'`, `'State Legislative Districts - Lower'`; fields: `STUSAB` (state), `CD119`/`BASENAME` for the district number; districts normalized via `normalizeDistrict` (strip leading zeros: '02' → '2'); no match → nulls, never throws.
  - `matchReps({terms, legislators}, {state, cd, sldu, sldl})` → `{usSenators: [], usHouse: [], moSenate: [], moHouse: [], asOf}` — us senators: us-congress + chamber=senate + (term.state ?? term.district) === state; us house: us-congress + house + term.state === state + normalizeDistrict(term.district) === cd; MO: mo-legislature + chamber + normalizeDistrict(term.district) === sldu/sldl (only when state==='MO'). `asOf`: from the matched terms' dates when present, else `'per the most recent term evidence in our data (dates unrecorded)'` — the spec's currency-honesty ruling, verbatim behavior: NEVER the word "current".
  - When several legislators match one seat (era overlap unprovable), return ALL matches; the UI renders them all with their date evidence — showing candidates honestly beats guessing.
- `site/functions/geocode.js` (the one allowed server code):

```js
// Cloudflare Pages Function: /geocode?address=... — a no-logging pass-through to the Census
// Geocoder (their API sends no CORS headers, so the browser cannot call it directly).
// PRIVACY CONTRACT (spec §5, review-blocking): the address is forwarded to the Census request
// and NOWHERE else. No console.log, no analytics, no KV, no cache writes, no error reporting
// that includes the address. Errors return generic JSON.
export async function onRequestGet({ request }) {
  const address = new URL(request.url).searchParams.get('address');
  if (!address || address.length > 500) {
    return Response.json({ error: 'address required' }, { status: 400 });
  }
  const u = new URL('https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress');
  u.searchParams.set('address', address);
  u.searchParams.set('benchmark', 'Public_AR_Current');
  u.searchParams.set('vintage', 'Current');
  u.searchParams.set('format', 'json');
  try {
    const upstream = await fetch(u, { signal: AbortSignal.timeout(15000) });
    if (!upstream.ok) return Response.json({ error: 'geocoder unavailable' }, { status: 502 });
    return Response.json(await upstream.json());
  } catch {
    return Response.json({ error: 'geocoder unavailable' }, { status: 502 });
  }
}
```

- Directory: `fetchAllRows('legislators?select=id,full_name,party,person_id,bioguide_id,mo_senate_id,mo_house_id,openstates_id,legiscan_people_id')` + persons + terms (fetchAllRows each); group rows by person_id (ungrouped rows stand alone); one entry per person/row: display name, chamber/party/district from most recent term, link to `/person/` or `/legislator/`; client-side text filter over name + chamber + party (a filter over a COMPLETE fetched list — not a partial-page sort). Alphabetical by surname — the one neutral order.
- Address UI: input + "find my representatives" → `/geocode` → `parseGeographies` → `matchReps` → the five-people result with as-of labels; the privacy contract sentence renders VERBATIM next to the input: "Your address is sent to the U.S. Census Bureau geocoder to find your districts, and is not stored or logged — not by us, not ever."; geocoder failure → the three-state 'failed' treatment; address-not-found → honest empty ("the geocoder couldn't match that address").

- [ ] **Step 1: TDD districts.js** off a captured real Census payload fixture (capture once with a public landmark address — e.g. the MO State Capitol, 201 W Capitol Ave, Jefferson City, MO — never a private address, commit as `tests/fixtures/census/capitol.json`): parse → `{state:'MO', cd, sldu, sldl}` exact; leading-zero normalization; matchReps against a terms fixture incl. the ambiguous-seat multi-match case and the null-dates as-of string. FAIL first.
- [ ] **Step 2: Implement districts.js + directory model to green.**
- [ ] **Step 3: Wire index.html + directory-page.js + the function.** Local dev: `serve-site.js` gains a `/geocode` passthrough mimicking the function (same code path importable — keep the upstream-URL builder as an exported pure function so the dev server and the Pages function share it).
- [ ] **Step 4: Full suite green, commit** — `git commit -m "feat: directory + address lookup (geocode pass-through, currency-honest matching)"`
- [ ] **Step 5 (controller smoke):** Capitol address → five MO people with as-of labels; a non-MO address → federal-only results labeled; garbage address → honest failure.

