# Cloudflare Pages deploy — runbook

**Status (2026-08-05): DEPLOYED and VERIFIED LIVE at https://visiblegov.pages.dev.** Phase 1
(create the Pages project) and Phase 2 (verify on `.pages.dev`) are DONE — 21 mechanical curl checks
pass and the full product loop was confirmed in a real browser with zero console errors. **What
remains is Phase 3 (nameservers) and Phase 4 (custom domain)**, both console/DNS work in Lance's own
Cloudflare account.

> **Two real bugs surfaced during Phase 2 — the verification earned its cost.** (1) Every
> `_redirects` rule was broken: Pages 308-canonicalizes `.html`, so targets pointing at `.html`
> looped `/trust` and stripped the uuid from `/person/<id>`. Fixed by making the `/person`, `/legislator`,
> `/bill` targets extensionless and DELETING the `/trust` rule entirely (Pages serves `trust.html`
> at `/trust` natively — the rule was the loop) (PLAYBOOK_DELTA lesson 32). (2) Every anonymous profile's vote list returned HTTP 500 — the
> `public_vote_feed` view's anti-join crossed anon's 3s `statement_timeout`; fixed by migration 0031
> (lesson 33). Both are fixed, applied, and re-verified live. The lesson: a browser walk under the
> real anon role at real data volume catches what curl-the-endpoint cannot.

Written 2026-08-05, replacing the half-finished deploy *spec* (the brainstorm paused 2026-08-03
with sections 2 and 4 unpresented). Section 2 was "implementation detail of the two fixes" — those
are now BUILT, so a spec for them would be describing existing code. What was genuinely still
missing is the runbook and the verification checklist, which is this document.

Phase order follows the LinkedUmp four-phase runbook (`C:\Users\lance\OneDrive\Desktop\
MidMoConsultant\LinkedUmp\PLAYBOOK_DELTA.md` §5), which this project's own `PLAYBOOK_DELTA.md` §7
lesson 5 instructs reading in place at deploy time. It also matches Lance's own 2026-07-28 ruling:
**`.pages.dev` first, custom domain as a separate later phase.** Doing both at once makes a broken
result ambiguous between the deploy and the DNS.

---

## Pre-flight (all DONE — recorded so a future rebuild knows what had to be true)

| Item | Status |
|---|---|
| `geocode.js` sets its own security headers | ✅ built 2026-08-05 — Pages Functions do NOT inherit `_headers` |
| `site/404.html` | ✅ built 2026-08-05, JS-free |
| `revoke execute ... from authenticated` | ✅ migration `0030`, applied + verified live 2026-08-05 |
| Site verified end-to-end in a real browser against live data | ✅ 2026-08-03 (Playwright, zero console errors) |
| Suite green | ✅ 2,328 / 0 |
| LegiScan CC BY 4.0 attribution present | ✅ full text + license link on `trust.html`; every page's footer links to `/trust#attribution` |

### ✅ The one thing that had no production evidence — now VERIFIED

`site/functions/geocode.js` imports `../js/security-headers.js` — a module **outside** the
`functions/` directory. Before deploy that import had never run in Cloudflare's environment (it
works locally only because Node resolves it directly), so it was flagged as the deploy's one
unproven piece: if Cloudflare's esbuild bundling had not followed the cross-directory relative
import, `/geocode` would have 500'd and address lookup would break (everything else unaffected).
**Phase 2 confirmed it works** — `/geocode` returned 200 with real Census data and all three
security headers on the response, on its first exposure to the live environment. Kept here as the
record of what the risk was and that it was cleared. (If a future edit ever moves that constant and
breaks this: move it into `site/functions/` and import locally, or inline the three header values,
then re-point the drift test in `tests/site-modules.test.js`.)

---

## Phase 1 — Create the Pages project (`.pages.dev` only)

**Trap first:** Cloudflare's UI funnels you toward **Workers**, including from the activation
email. This is a *Pages* project. Use **Workers & Pages → Pages tab → Connect to Git**. (LinkedUmp
hit this twice, a year apart, through two different UI packagings.)

Settings — these exact values:

| Field | Value | Why |
|---|---|---|
| **Project name** | e.g. `visiblegov` | **pick deliberately — this becomes the permanent `<name>.pages.dev` URL** and is the first field in the wizard; renaming later means a new URL |
| Repository | `lazrexmc/VisibleGov` | private repo; authorize Cloudflare's GitHub app for it |
| Production branch | `main` | |
| Framework preset | **None** | a preset injects an assumed build command you'd then have to clear |
| Build command | *(empty)* | there is no build step — the site is plain HTML/CSS/ES modules |
| **Build output directory** | **LEAVE EMPTY** | ⚠️ see below — do NOT put `site` here |
| Root directory (advanced) → Path | `site` | **required** — Pages discovers `functions/` relative to the ROOT directory, so this is what makes `/geocode` deploy at all; `_headers`/`_redirects` are read from here too |
| Environment variables | *(none)* | `site/config.js` carries the anon URL/key; no secrets exist in `site/` |

> **⚠️ Build output directory: LEAVE EMPTY — an earlier version of this table said `site`, which is
> WRONG and would have failed the build** (caught by Lance reading the wizard against this doc before
> clicking Save). **Build output directory is resolved relative to Root directory.** With Root
> directory = `site`, Pages is already inside `<repo>/site/`, so an output directory of `site`
> resolves to `<repo>/site/site/` — a path that does not exist. Empty means "this directory," which
> is where `index.html`, `_headers`, `_redirects`, and `functions/` actually are. The two valid
> configurations: **root `site` + output empty** (what we use — required, because `functions/` is
> only discovered under the root directory), or root empty + output `site` (serves the static files
> fine but does NOT deploy the geocode Function). Setting both is the one combination that breaks.

The first deploy fires automatically on project creation — it is not a separate step.

---

## Phase 2 — Verify on `.pages.dev` BEFORE touching DNS

Do all of this against the `https://<project>.pages.dev` URL. **Verify at the origin with
`curl`, not a browser screenshot** — Pages ignores a `Cache-Control` override in `_headers` for
assets, so a browser can show you a cached lie (LinkedUmp §292).

```bash
BASE=https://<project>.pages.dev

# 1. Security headers on a STATIC page (from site/_headers)
curl -sI "$BASE/" | grep -iE "content-security-policy|x-content-type-options|referrer-policy"

# 2. Security headers on the FUNCTION response (from site/js/security-headers.js).
#    This is the fix built 2026-08-05 — before it, this returned bare.
curl -si -X POST "$BASE/geocode" \
  -H 'content-type: application/json' \
  -d '{"address":"1 N Main St, Columbia, MO"}' | head -20

# 3. The 400 error path also carries headers (regression check on the same fix)
curl -si -X POST "$BASE/geocode" -H 'content-type: application/json' -d '{}' | head -12

# 4. _redirects rewrites survive a hard request (not just client-side routing)
curl -sI "$BASE/trust"           # expect 200, not 404 (Pages serves trust.html here natively; no rule)
curl -sI "$BASE/person/whatever" # expect 200 (rewrites to the extensionless /person, uuid preserved)

# 5. The new 404 page
curl -si "$BASE/no-such-page" | head -12   # expect 404 + text/html + "Page not found"
```

Then, in a real browser, walk the product claim end-to-end (the same loop verified locally on
2026-08-03): directory → click a legislator → see real recorded votes → click a bill from a vote →
see that bill's real roll-call tally. Check the console is clean.

**Two browser checks beyond the happy path:**

- **Address lookup actually works** (the geocode Function end-to-end, not just its headers) — type a
  real Missouri address and confirm it returns representatives. This is the feature that breaks if
  the cross-directory import fails; check #2 above tests the plumbing, this tests the product.
- **Attribution renders and resolves.** Click **Attribution** in the footer → it must land on
  `/trust#attribution` and show the LegiScan CC BY 4.0 notice with its license link. This is not
  cosmetic: LegiScan's binding terms (`docs/research/2026-07-28-legiscan-terms.md`, rule 10) require
  CC BY 4.0 attribution *with link* on every public surface displaying their data, and going public
  is the exact moment that obligation starts applying. CC BY 4.0 explicitly permits satisfying it via
  a hyperlink to a page carrying the notice, which is what the footer does — so this is compliant as
  built, and the check is confirming it survived the deploy, not redesigning it.

**Do not proceed to Phase 3 until Phase 2 is fully green.**

**If something fails.** Pages keeps every deployment: project → **Deployments** → any prior build →
**Rollback**. Nothing here touches the database, so a bad deploy is cosmetic and reversible — the
backend, the scheduler, and all ingestion keep running untouched regardless of what the site does.
A failed *build* is even simpler: nothing was ever published, and the previous deployment (or, on
the first attempt, nothing at all) stays live.

---

## Phase 3 — Move the zone to Cloudflare (nameservers)

Context, decided 2026-08-05: Lance owns `helpingpeoplehelpingpeople.com`, and it currently serves
only a disposable caard.io one-pager he is fine losing. Moving nameservers **moves the entire
zone**, not just the subdomain — the one-pager will stop resolving once its records are gone.

**The trap (LinkedUmp §4.3, "Registrar cruft fights your DNS"):** when Cloudflare imports the
existing zone it pulls in whatever the registrar had — commonly a parking `A` record, a parking
`www` CNAME, several `eforward` MX records and an SPF `TXT`. All of it is dead weight after the NS
move (registrar email forwarding only works on the registrar's own DNS), and leftover records fight
the Pages custom-domain attachment.

1. Cloudflare dashboard → **Add a site** → enter the domain → Free plan.
2. Cloudflare shows the records it imported. **Delete all of them.**
   - **Nothing on this zone needs preserving** — Lance confirmed 2026-08-05: no email functions of
     any kind, and the only content is a disposable caard.io one-pager. That confirmation is what
     makes this step a clean sweep rather than a judgment call: the usual danger here is dropping
     `MX` records and silently killing email that someone set up (or that a registrar added by
     default), and that danger does not exist on this domain.
   - So: parking `A`, parking `www` CNAME, SPF `TXT`, any `eforward`/`MX`, and the caard.io records
     all go. Leftover records fight the Pages custom-domain attachment (LinkedUmp §4.3) — a clean
     zone is the goal, not a minimal edit.
3. Cloudflare gives you two nameservers. Set them at the current registrar, replacing what's there.
4. Wait for Cloudflare to report the zone **Active** (usually minutes; can take longer).

---

## Phase 4 — Attach the custom domain

Decided 2026-07-28: the target is **`visiblegov.helpingpeoplehelpingpeople.com`** (a subdomain).
Now that the apex is free, using the apex instead is a live option — but it is a *product* decision
(the domain name does not match the VisibleGov brand), not a technical one, and the subdomain
remains the standing decision unless Lance changes it.

1. Pages project → **Custom domains** → **Set up a custom domain** → enter the subdomain.
2. With the zone already on Cloudflare (Phase 3), the required DNS record is created for you.
3. Wait for the certificate to issue (status goes Active).
4. Re-run **every** `curl` check from Phase 2 against the custom domain. Headers, redirects, the
   geocode Function, and the 404 page are all origin/host-sensitive — passing on `.pages.dev` does
   not prove them on the custom domain.

One LinkedUmp lesson explicitly checked and **not applicable here**: *"different origins = different
sessions — `*.pages.dev` and the custom domain each hold their own login."* That concerns auth
sessions; this site has no login at all (anon key only, RLS is the wall), so both hostnames can
coexist without confusion.

---

## Open decision (not blocking any phase)

**Preview deployments.** Pages auto-builds a public preview for every branch/PR by default. Because
`site/config.js` hardcodes the real production anon key, every preview is a fully live copy of the
real site reading real data.

**Recommendation: leave the default on.** This is a public-transparency site — the data is *meant*
to be world-readable, the anon key is designed to be public, RLS is the actual wall, and there is no
auth session to get confused across origins. The only mild downsides are duplicate content for
search engines and the chance someone shares a stale preview URL. Restrict it later if either
becomes a real annoyance.

---

## After deploy — say what is actually true

LinkedUmp §4.2's status ladder, worth repeating because it has caught over-claiming before:
**built → deployed/viewable → live.** A URL that resolves is *viewable*. "Live" means real people
using it for real work. Until someone who is not Lance has actually looked up their representative
and gotten a useful answer, the honest phrasing is "deployed, in owner testing."
