// src/lib/overflow-parks.js — permanent, self-expiring suppression of bills that overflow the
// model's output allowance.
//
// WHY THIS EXISTS (2026-11-06). Missouri appropriations bills exceed `max_tokens` and were retried
// on EVERY billed tick: HB 2 hit it ten times between 2026-10-20 and 2026-11-05, HB 2287 nine,
// HB 2017 seven. Each retry paid for a full authored output that was then discarded, and no
// instrument reported any of it, because a skip is not a failure anything checks
// (docs/EXPECTED_FAILURES.md entry 4). Lance, relayed 2026-11-06: "VisibleGov should fix that
// spending issue promptly."
//
// THE RULE, agreed with RapidForge under docs/JOINT_CHANGE_PROTOCOL.md: a `max_tokens` stop on
// UNCHANGED input is permanent, keyed by a hash of the bill text, and nothing further is spent on
// that bill until its text OR the output allowance changes.
//
// WHY NOT `parked.json` / `parked_bills`. That store means something different: a human-reviewed,
// human-unparked judgement, keyed by `bill_id` ALONE. This suppression is keyed by bill+text and
// expires by itself, so putting it there would (a) make `parkedIds` unable to express the hash
// scoping that is the whole point, (b) confuse `unpark-stochastic-parks.mjs` and
// `migrate-parked-to-ledger.mjs`, which reason about that store's semantics, and (c) collide with
// the 4-bill unpark already drafted and awaiting Lance. Separate store, separate meaning.
//
// TWO ASYMMETRIES DRIVE EVERY DECISION HERE, and they point in opposite directions:
//   - Paying twice for an impossible bill costs money.
//   - Permanently suppressing a POSSIBLE bill removes it from a civic-transparency site with no
//     symptom anywhere.
// The second is worse, so **every ambiguous case fails toward ATTEMPTING**: an unknown stage, a
// missing hash, a malformed record and an unreadable store all decline to suppress. That is a
// deliberate choice to risk money rather than risk coverage.
//
// WHY THE STAGE IS RECORDED AND NOT JUST THE BILL. The allowance is per stage, and they differ by
// an order of magnitude: `coverage` caps output at 3,000 tokens while `verify` gets 32,000. "HB 2
// overflowed" is not a fact until it says where. HB 2 in fact failed at `coverage` — the tightest
// stage — which is exactly why the allowance clause matters: a bill that cannot fit 3,000 tokens is
// NOT proven impossible at 8,000, so raising that limit must release the park automatically rather
// than needing someone to remember.

// EVERY EXPORT IN THIS FILE IS CITED BY NAME IN ANOTHER REPO (RapidForge's MODULE_DIRECTORY.md
// section 5, recorded 2026-11-06). Renaming one breaks that documentation and nothing in either
// tree fails - see the inbound-pointer register in docs/JOINT_CHANGE_PROTOCOL.md before a rename,
// and tell RapidForge when one lands.

// Mirrors the allowances the chain actually passes: MAX_OUTPUT_TOKENS (src/lib/summarizer.js),
// VERIFY_MAX_OUTPUT_TOKENS (src/lib/verifier.js), and the inline literals in
// src/lib/billed-summary-chain.js. Kept as data rather than imported because this module must stay
// pure and loadable without the chain's model clients.
//
// A STAGE MISSING FROM THIS MAP IS UNPARKABLE BY DESIGN — see parseMaxTokensFailure. Whoever adds a
// stage to the chain adds it here, or overflows in that stage silently keep costing money.
export const STAGE_OUTPUT_ALLOWANCES = {
  author: 16000,
  reauthor: 16000,
  verify: 32000,
  provisions: 4000,
  'provisions-corroboration': 4000,
  coverage: 3000,
};

// The chain throws `new Error(`${label}: hit max_tokens`)` where label is `${stage}:${identifier}`
// (src/lib/billed-summary-chain.js). So the message is `stage:identifier: hit max_tokens`.
//
// Anchored on the LITERAL suffix rather than matched loosely: a refusal, a billing error or a
// completeness failure must never be read as an overflow, because those are the retryable kinds and
// turning one into a permanent park would lose a bill that was only unlucky.
const MAX_TOKENS_SUFFIX = ': hit max_tokens';

export function parseMaxTokensFailure(message) {
  if (typeof message !== 'string' || !message.endsWith(MAX_TOKENS_SUFFIX)) return null;
  const head = message.slice(0, -MAX_TOKENS_SUFFIX.length);
  // Split on the FIRST colon only: the stage never contains one, while an identifier may
  // ("HB 2: Part II"). Splitting on the last would swallow the stage.
  const colon = head.indexOf(':');
  if (colon <= 0) return null;
  const stage = head.slice(0, colon);
  const identifier = head.slice(colon + 1);
  if (!identifier) return null;
  // An unrecognised stage has no declared allowance, so the "until the allowance changes" half of
  // the rule could never be evaluated and the park could never expire. Decline to park it at all.
  if (!Object.prototype.hasOwnProperty.call(STAGE_OUTPUT_ALLOWANCES, stage)) return null;
  return { stage, identifier };
}

// Binds the record to the TEXT, so a substitute or amended bill is a different input that gets one
// fresh attempt. Returns null rather than a key built from `undefined`, which would make every
// untexted bill collide into one shared park entry.
export function overflowKey(billId, textHash) {
  if (!billId || typeof billId !== 'string') return null;
  if (!textHash || typeof textHash !== 'string') return null;
  return `${billId}@${textHash.slice(0, 16)}`;
}

export function overflowRecordFor({ billId, identifier, stage, textHash, now = new Date() }) {
  const maxTokens = STAGE_OUTPUT_ALLOWANCES[stage];
  if (typeof maxTokens !== 'number') return null;
  if (!overflowKey(billId, textHash)) return null;
  return {
    bill_id: billId,
    identifier: identifier ?? null,
    stage,
    max_tokens: maxTokens,
    text_hash: textHash,
    recorded_at: now.toISOString(),
    reason: `stage '${stage}' hit max_tokens at its ${maxTokens}-token output allowance on this exact text; `
      + 'permanent until the bill text changes or that allowance is raised',
  };
}

// The decision a tick makes BEFORE spending anything. `allowances` is injectable so a caller (and a
// test) can ask "would this still be suppressed if coverage were raised?" without mutating module
// state.
export function overflowSuppression(store, { billId, textHash } = {}, allowances = STAGE_OUTPUT_ALLOWANCES) {
  const notSuppressed = (reason) => ({ suppressed: false, record: null, reason });
  if (!store || typeof store !== 'object') return notSuppressed('no overflow store');
  const key = overflowKey(billId, textHash);
  if (!key) return notSuppressed('no usable bill id + text hash');
  const record = store[key];
  if (!record || typeof record !== 'object') return notSuppressed('no record for this bill at this text');
  // A record that cannot name its stage and the limit it hit cannot be compared against today's
  // allowance, so it can never expire. Release rather than hold a bill on a comparison nothing can
  // make — the fail-toward-attempting rule in this file's header.
  const { stage, max_tokens: recordedMax } = record;
  if (typeof stage !== 'string' || typeof recordedMax !== 'number') {
    return notSuppressed('malformed overflow record — releasing rather than suppressing on junk');
  }
  const current = allowances?.[stage];
  if (typeof current !== 'number') {
    return notSuppressed(`stage '${stage}' no longer declares an allowance — cannot evaluate expiry, so releasing`);
  }
  if (current > recordedMax) {
    return notSuppressed(
      `stage '${stage}' allowance rose from ${recordedMax} to ${current} — overflow park expired, one fresh attempt`,
    );
  }
  return {
    suppressed: true,
    record,
    reason: `permanently skipped, UNPAID: stage '${stage}' hit max_tokens at its ${recordedMax}-token `
      + `output allowance on this exact text (recorded ${String(record.recorded_at).slice(0, 10)}). `
      + 'Will retry by itself if the bill text changes or that allowance is raised.',
  };
}
