// site/js/legislator-page.js — site/legislator.html's entry point (design spec §2-3, task-6
// brief). A not-yet-linked legislator row, rendered with the SAME profile template as a linked
// person's page: "fetch the row; person_id set -> location.replace('/person/<person_id>'); else
// render the same profile sections with legislators=[row], person=null." Reuses idFromPath,
// mountProfile, renderNotFound from person-page.js unchanged — no lookalike re-implementation.

import { restGet } from './rest.js';
import { sectionState, mountFooter } from './render.js';
import { idFromPath, mountProfile, renderNotFound } from './person-page.js';

// Exported, never auto-run at module load (same reasoning as person-page.js's
// bootstrapPersonPage: this file is imported nowhere else, but keeping the same explicit-call
// convention avoids surprises and keeps the module import-safe for any future test).
export async function bootstrapLegislatorPage() {
  const identityContainer = document.getElementById('identity');
  mountFooter(document.getElementById('site-footer'));

  const legislatorId = idFromPath(window.location.pathname, '/legislator/');
  if (!legislatorId) {
    renderNotFound(identityContainer);
    return;
  }

  sectionState(identityContainer, { state: 'loading' });
  let row;
  try {
    const { rows } = await restGet(`legislators?id=eq.${legislatorId}`);
    row = rows[0] || null;
  } catch {
    sectionState(identityContainer, {
      state: 'failed',
      message: "Couldn't load this legislator — retry",
      onRetry: () => bootstrapLegislatorPage(),
    });
    return;
  }

  if (!row) {
    renderNotFound(identityContainer, () => bootstrapLegislatorPage());
    return;
  }

  // Merges never break URLs (design spec §2): once this row is linked to a person, this page
  // forwards to the canonical /person/<id> URL instead of rendering the single-row view.
  if (row.person_id) {
    window.location.replace(`/person/${row.person_id}`);
    return;
  }

  await mountProfile({
    identity: identityContainer,
    voteFilters: document.getElementById('vote-filters'),
    votes: document.getElementById('votes'),
    sponsorships: document.getElementById('sponsorships'),
    freshness: document.getElementById('freshness'),
  }, { person: null, legislators: [row] });
}
