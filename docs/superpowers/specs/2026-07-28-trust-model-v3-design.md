# Trust Model v3 — Process-Audit Adjudication (DRAFT, awaiting Lance's approval)

**Origin (Lance, 2026-07-28, verbatim):** "My biggest concern is me approving them, I'm not a
lawyer or a judge. I just have to believe what is displayed to me is true. My best bet,
personally, would be to copy paste all of the information and manulaly run it thru multiple
LLMs. Is there another process that would satisfy my project?"

**The reframe v3 is built on (Lance confirmed he understands his role this way):** Lance is a
**process auditor, not a truth certifier**. The system's trustworthiness comes from the chain —
official-text-only grounding, source URL + content hash, author-cited supporting quote,
adversarial refutation against the same excerpt, mechanical completeness gates — not from any
human's legal expertise. Lance's check is reading comprehension ("does the gloss/summary say
anything the quoted official text doesn't support, and is it neutral?"), which a non-lawyer can
do honestly.

## What changes from v2 → v3 (three mechanisms, in adoption order)

### 1. Receipts on the public site (adopt first — cheap, philosophically core)
Every published Background gloss (and, pattern-wise, every summary) renders with:
- the official source link (already stored: source_url with subsection fragment),
- the author model's supporting quote (already stored: supported_by_quote),
- an honest provenance label: machine-generated from the referenced law's official text,
  adversarially verified, human-audited — wording to be finalized with Lance.
Nobody — reader, Lance, or model — is asked to trust an authority; the chain itself is shown.
Belongs to Plan 3 (public site rendering); the data already exists.

### 2. Adjudication by exception (changes v2's "nothing publishes without my click")
- Lance personally reads: every FLAGGED item + a random sample of clean items (default 10% —
  Lance sets the number).
- Clean, unflagged, fully-verified items AUTO-APPROVE after the verification quorum (see 3).
- Every auto-approval is logged with its full verification record (glossary_notes /
  summary_notes row, action 'auto-approved', naming the quorum) — auditable after the fact.
- The review page gains a "sample for me" button + an auto-approve toggle Lance controls.
  Nothing auto-approves until Lance flips it on, per queue (glossary vs summaries separately).

### 3. Verifier diversity (Lance's own multi-LLM instinct, systematized)
- A second independent verifier refutes each item against the SAME excerpt; ideally a
  different vendor (GPT/Gemini via Lance's own accounts) for genuine independence of blind
  spots. Same mechanical rules: refute-stance, derived overall, never self-reported.
- Quorum rule for auto-approval (mechanism 2): ALL verifiers clean. Any single flag → Lance's
  queue. Disagreement between verifiers is itself surfaced, never averaged away.
- BLOCKED for now by the standing no-API-spend hold (Anthropic side) — cross-vendor keys are
  Lance's call whenever he wants this leg. v3 can adopt mechanisms 1-2 first; quorum = the
  existing single sonnet verifier until diversity is funded.

## What does NOT change
- Facts-only rule; official-text-only grounding; no model knowledge as a factual source.
- Mechanical gates on every model-calling run (per-run approval, cost stated) — unchanged.
- Draft-then-apply for schema; provenance columns; RLS walls.
- Rejected/flagged items still require Lance — auto-approval never touches a flag.

## Open decisions (Lance)
1. Sample rate for clean items (default proposal: 10%).
2. Second verifier vendor + key (GPT? Gemini? both? later?).
3. Public label wording for the receipts block.
4. Whether summaries adopt exception-based adjudication at the same time as glosses, or after
   glosses prove the pattern.

## Adoption status
- 2026-07-28: drafted from the conversation above; NOTHING implemented yet. CLAUDE.md's
  standing-policy section stays at trust model v2 until Lance approves this spec and the
  first mechanism ships.
