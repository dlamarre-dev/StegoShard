import { renderLegal } from './legal/render';

// The "last updated" date lives here, not in the localized prose, so a wording
// tweak in one language never implies a policy change across all of them.
renderLegal('privacy', '2026-07-13');
