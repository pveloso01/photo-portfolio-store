// Single entry point that drizzle-kit reads for schema generation.
// Each bounded context owns a file; this file re-exports their tables.
//
// Cross-context foreign keys are deliberately NOT declared with Drizzle
// `references()` so schema files stay independent. Application code enforces
// referential integrity at the bounded-context boundary.
//
// Per-context `tables` groupings are exposed under namespaced exports to
// avoid name collisions across files.

export * as users from './users.js';
export * as events from './events.js';
export * as photos from './photos.js';
export * as search from './search.js';
export * as catalog from './catalog.js';
export * as commerce from './commerce.js';
export * as payouts from './payouts.js';
export * as compliance from './compliance.js';
export * as integrations from './integrations.js';
export * as participants from './participants.js';
