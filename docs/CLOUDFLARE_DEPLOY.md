# Cloudflare Pages deploy — runbook

**Status (2026-08-05): DEPLOYED and VERIFIED LIVE at https://visiblegov.pages.dev.** *(Update
2026-08-22: custom domain DECIDED — `visiblegov.us`, owned by Lance; Phases 3-4 below rewritten
for it; the console work is his, when he is back.)* Phase 1
(create the Pages project) and Phase 2 (verify on `.pages.dev`) are DONE — 21 mechanical curl checks
pass and the full product loop was confirmed in a real browser with zero console errors. **What
remains is Phase 3 (nameservers) and Phase 4 (custom domain)**, both console/DNS work in Lance's own
Cloudflare account (plus one nameserver switch in his Namecheap account, the registrar for
`visiblegov.us`). *(Re-verified 2026-08-23: every Phase 2 curl check (#1-#5) still passes on
`.pages.dev`, the `.html` → extensionless 308s still hold, and an anonymous `public_vote_feed`
profile query returns 200 in well under a second — the 08-05 evidence is no longer the only proof;
see the dated line in Phase 2. Nothing under `site/` names a host, so Phases 3-4 change no code —
see "No code changes for Phase 4" below.)*

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
| Suite green | ✅ green — 2,328 / 0 at deploy time (2026-08-05); 2,600+ / 0 on 2026-08-23; run `node --test` in a clean shell for the current count (exact counts in docs go stale — CLAUDE.md) |
| LegiScan CC BY 4.0 attribution present | ✅ full text + license link on `trust.html`; every data page's footer (built at runtime by `mountFooter` in `site/js/render.js`) links to `/trust#attribution`. The JS-free `404.html` deliberately has no footer and links to `/trust` only — it displays no LegiScan data, so the attribution obligation does not attach to it |

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
| **Project name** | `visiblegov` — the actual value, not an example: it is what makes the live URL `https://visiblegov.pages.dev`, and a rebuild must reuse it to reproduce that URL | **pick deliberately — this becomes the permanent `<name>.pages.dev` URL** and is the first field in the wizard; renaming later means a new URL |
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
assets, so a browser can show you a cached lie (LinkedUmp PLAYBOOK_DELTA §8.2, "Launch-to-live traps"
item 2 — the same item this repo's PLAYBOOK_DELTA §7 lesson 5 cites).

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

**Re-run 2026-08-23 against `https://visiblegov.pages.dev` — all pass** (recorded so the
2026-08-05 run is not the only evidence): #1 all three security headers on `/`; #2 geocode 200
with all three headers; #3 geocode 400 with all three headers; #4 `/trust` and `/person/whatever`
both 200; #5 `/no-such-page` 404, `text/html`, "Page not found". Also: `/person.html` and
`/trust.html` each 308 to their extensionless path (the canonicalization behind the lesson-32
`_redirects` fix), and an anonymous REST query of `public_vote_feed` for one legislator (200-row
limit) returned HTTP 200 in ~0.2s — migration 0031's fix is still holding under the anon role.

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

## Phase 3 — Put the zone on Cloudflare (nameservers)

> **DECIDED 2026-08-22: the custom domain is `visiblegov.us`** — Lance bought it ("I now own the
> domain visiblegov.us as well"; setup deferred to after his AFK). This REPLACES the 2026-07-28
> subdomain plan (`visiblegov.helpingpeoplehelpingpeople.com`): the HPHP zone is no longer
> involved at all, so the "clean sweep / delete the caard.io records" text below does not apply —
> a freshly registered `visiblegov.us` zone carries only registrar parking cruft. The apex
> (`visiblegov.us`) is the target, with `www` as a redirect/alias. Everything else in Phases 3-4
> (add site → delete imported cruft → set nameservers at the registrar → wait for Active → attach
> in Pages → re-run every Phase-2 check against the new host) is unchanged in shape.

Context (historical, 2026-08-05, for the old subdomain plan): Lance owns
`helpingpeoplehelpingpeople.com`, and it currently serves only a disposable caard.io one-pager he
is fine losing. Moving nameservers **moves the entire zone**, not just the subdomain — the
one-pager will stop resolving once its records are gone. **Superseded 2026-08-22 — not needed
for `visiblegov.us`; keep that zone where it is.** The HPHP clean-sweep rationale that step 2
used to carry lives here now (moved 2026-08-23 — it was zone-specific, and a reader following
step 2 literally would have applied a superseded justification to the wrong zone):

- *(superseded 2026-08-22)* Nothing on the HPHP zone needed preserving — Lance confirmed
  2026-08-05 (CHATLOG, the 2026-08-05 HPHP-email entry): no email functions of any kind, and the
  only content was a disposable caard.io one-pager. That confirmation is what made the step a
  clean sweep rather than a judgment call *on that zone*: the usual danger is dropping `MX`
  records and silently killing email someone set up (or a registrar added by default), and it
  did not exist there.
- *(superseded 2026-08-22)* So, on HPHP: parking `A`, parking `www` CNAME, SPF `TXT`, any
  `eforward`/`MX`, and the caard.io records would all have gone.

**That confirmation was about `helpingpeoplehelpingpeople.com` only and does not transfer to
`visiblegov.us`** — the .us zone gets its own look in step 2 below.

**The trap (LinkedUmp §4.3, "Registrar cruft fights your DNS"):** when Cloudflare imports the
existing zone it pulls in whatever the registrar had — commonly a parking `A` record, a parking
`www` CNAME, several `eforward` MX records and an SPF `TXT`. All of it is dead weight after the NS
move (registrar email forwarding only works on the registrar's own DNS), and leftover records fight
the Pages custom-domain attachment.

1. Cloudflare dashboard → **Add a site** → enter `visiblegov.us` → Free plan.
2. Cloudflare shows the records it imported. **Delete all of them — for the reason that is true of
   THIS zone** *(rewritten 2026-08-23; the HPHP-specific bullets that used to sit here are in the
   historical paragraph above)*:
   - `visiblegov.us` is a fresh registration — RDAP (checked 2026-08-23): registrar NameCheap,
     Inc., registered 2026-08-22T13:19Z — and nothing has ever been set up on it: no email, no
     site, no record anyone added on purpose. As of 2026-08-23 it resolves only to registrar
     parking (`A 162.255.119.110`; nameservers `dns1`/`dns2.registrar-servers.com`).
   - So what Cloudflare imports should be registrar cruft only: the parking `A`, probably a
     parking `www` CNAME, and whatever default `MX`/`TXT` Namecheap adds. **Read the imported
     list and confirm it is only that before deleting.** If a record is there that Lance does not
     recognise, stop and ask rather than assume — the 2026-08-05 "no email to preserve"
     confirmation was about a different zone and does not cover this one.
   - Leftover records fight the Pages custom-domain attachment (LinkedUmp §4.3) — a clean zone is
     the goal, not a minimal edit.
3. Cloudflare gives you two nameservers. Set them at **Namecheap** (the registrar for
   `visiblegov.us`): the domain's **Manage** page → the **Nameservers** setting → switch from
   Namecheap BasicDNS to **Custom DNS** and enter the two Cloudflare hosts, replacing
   `dns1`/`dns2.registrar-servers.com`.
4. Wait for Cloudflare to report the zone **Active** (usually minutes; can take longer).

---

## Phase 4 — Attach the custom domain

> **Verification is scripted — run it the moment the domain is attached:**
> `bash scripts/verify-custom-domain.sh https://visiblegov.us`
> It re-runs every Phase-2 check against the new host (apex 200, all three security headers,
> `/trust`, the `/person/<id>` rewrite, the 404 body, the geocode Function's rejection path and
> its headers, and that the index actually renders) and exits non-zero if any fail. Baselined
> against `https://visiblegov.pages.dev` on 2026-08-24: 11 passed, 0 failed. Pass a host argument
> to check either deployment; with no argument it checks `https://visiblegov.us`.

~~Decided 2026-07-28: the target is `visiblegov.helpingpeoplehelpingpeople.com` (a subdomain).~~
**Superseded 2026-08-22: the target is the apex `visiblegov.us`** (Lance bought it — CHATLOG
2026-08-22 morning entry, "I now own the domain visiblegov.us as well"; registered
2026-08-22T13:19Z at Namecheap per RDAP). *(Citation corrected 2026-08-23: this line originally
cited "CHATLOG 2026-08-21" and said "the .com is squatted at ~$1,995 and .org is taken" — the
08-21 CHATLOG entry only lists the candidates `visiblegov.us / .net / the subdomain`, and no
CHATLOG, TODO, or memory entry records the .com/.org pricing; that aside is kept here as
unrecorded, not as a cited fact.)* Attach the apex, then add `www`
as a second custom domain (Pages issues certificates for both; point `www` at the apex with a
Cloudflare redirect rule or a second Pages custom domain — either is fine; the choice is still
open, see "Open decisions" below — and re-run the checks against both hosts:
`https://visiblegov.us` in full, and `https://www.visiblegov.us` either in full (second custom
domain) or for its redirect to the apex (redirect rule)).

1. Pages project → **Custom domains** → **Set up a custom domain** → enter `visiblegov.us`.
2. With the zone already on Cloudflare (Phase 3), the required DNS record is created for you.
3. Wait for the certificate to issue (status goes Active).
4. Re-run **every** `curl` check from Phase 2 against the custom domain. Headers, redirects, the
   geocode Function, and the 404 page are all origin/host-sensitive — passing on `.pages.dev` does
   not prove them on the custom domain.

**No code changes for Phase 4** (verified 2026-08-23): nothing under `site/` names a host — a grep
for `pages.dev`, `visiblegov.us`, and `helpingpeople` returns nothing — and the CSP in
`site/_headers` (and its Function-side copy in `site/js/security-headers.js`, confirmed carrying
the same Supabase `connect-src` origin on the live geocode response) hardcodes only the Supabase
origin, which does not change. `site/config.js` carries the Supabase URL and anon key, which are
host-independent. So Phases 3-4 are entirely console work; the step-4 re-run checks the
*platform's* behaviour on the new host (certificate, `_headers` injection, `_redirects`, the
Function route), not any code path.

**Docs to flip when Phase 4 lands** (listed 2026-08-23; as of that date each of these names
`visiblegov.us` as the *pending* custom domain — most beside a struck-through or
"(Superseded 2026-08-22)" mention of the 2026-07-28 subdomain — so the work is flipping "pending"
to "done", not correcting the target; grep `visiblegov.us` and `helpingpeoplehelpingpeople`, line
numbers drift):
- `README.md` — the status paragraph ("Only the custom domain remains — DECIDED 2026-08-22 as the
  apex `visiblegov.us` ..."), the site bullet ("custom domain (`visiblegov.us`, decided
  2026-08-22) still pending"), and this runbook's entry in the file list ("what remains is console
  work (Phases 3-4 ...)").
- `CLAUDE.md` — the RESUME banner's "What remains: the custom-domain phases (nameservers + attach
  ~~...~~ — superseded 2026-08-22: the apex `visiblegov.us` ...)" and the standing-rules bullet's
  "Only the custom-domain phases remain".
- `TODO.md` — RESUME HERE item (e) ("custom domain DECIDED 2026-08-22: `visiblegov.us` ... his
  console work after his AFK") and the Cloudflare-deploy NOW entry under it, whose "Remaining, per
  `docs/CLOUDFLARE_DEPLOY.md`" sentence still reads the subdomain + clean sweep before its
  "(Superseded 2026-08-22 ...)" note, plus the HPHP context paragraph in its item 4.
- Memory `deploy-last-backend-first.md` — its "What remains (the ONLY open deploy work)" paragraph
  still names the HPHP subdomain with the clean-sweep framing (the `.us` decision is only in the
  2026-08-22 update line at the bottom), and `MEMORY.md`'s index line says "deferred past his
  AFK" — rewrite both to done.
- This runbook — the status banner at the top, the Phase 3 "DECIDED" callout, and the "After
  deploy" ladder.

One LinkedUmp lesson explicitly checked and **not applicable here**: *"different origins = different
sessions — `*.pages.dev` and the custom domain each hold their own login."* That concerns auth
sessions; this site has no login at all (anon key only, RLS is the wall), so both hostnames can
coexist without confusion.

---

## Open decisions (not blocking any phase)

**Preview deployments.** Pages auto-builds a public preview for every branch/PR by default. Because
`site/config.js` hardcodes the real production anon key, every preview is a fully live copy of the
real site reading real data.

**Recommendation: leave the default on.** This is a public-transparency site — the data is *meant*
to be world-readable, the anon key is designed to be public, RLS is the actual wall, and there is no
auth session to get confused across origins. The only mild downsides are duplicate content for
search engines and the chance someone shares a stale preview URL. Restrict it later if either
becomes a real annoyance.

**`www` wiring — DECIDED 2026-08-25 (Lance): option (a), redirect `www` to the apex.** One
canonical URL (`https://visiblegov.us`), which is better for search engines and for links people
share; `www.visiblegov.us` still works for anyone who types it, it just does not stay there.
*(The alternative considered and not taken: attaching `www` as a second Pages custom domain, which
serves the same content on two hosts.)*

Wiring order matters — a redirect rule only fires if DNS actually routes `www` to Cloudflare's
edge, so the DNS record comes first:

1. Attach the apex `visiblegov.us` in Pages (step 1 above). Cloudflare creates the apex DNS
   record itself as part of the attachment — do not hand-add one.
2. DNS → **Add record**: type `CNAME`, name `www`, target `visiblegov.us`, **Proxied (orange
   cloud)**. Proxied is the load-bearing part: a grey-cloud (DNS-only) record bypasses the edge
   and the redirect rule never runs.
3. Rules → **Redirect Rules** → Create. Match: `Hostname` **equals** `www.visiblegov.us`.
   Then: **Dynamic** redirect, status **301**, target expression
   `concat("https://visiblegov.us", http.request.uri.path)`, **preserve query string ON**.
   Dynamic + `concat` rather than a static URL so a deep link keeps its path —
   `www.visiblegov.us/trust` must land on `visiblegov.us/trust`, not the home page.

Phase-4 host list this fixes: run the full check set against `https://visiblegov.us`
(`scripts/verify-custom-domain.sh`), and against `https://www.visiblegov.us` check only that it
301s to the apex **preserving the path**.

---

## After deploy — say what is actually true

LinkedUmp §4.2's status ladder, worth repeating because it has caught over-claiming before:
**built → deployed/viewable → live.** A URL that resolves is *viewable*. "Live" means real people
using it for real work. Until someone who is not Lance has actually looked up their representative
and gotten a useful answer, the honest phrasing is "deployed, in owner testing."
