// Identity context — organizations, users, sessions, memberships, photographer profiles.
// All tables live in the Postgres `app` schema.
// Cross-context foreign keys (e.g. to events) are kept as plain uuid columns
// without references() to avoid coupling schema files. Application code enforces.

import { sql } from 'drizzle-orm';
import {
  index,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const app = pgSchema('app');

// ---------- Enums ----------

export const userRole = app.enum('user_role', [
  'superadmin',
  'admin',
  'photographer',
  'organizer',
  'assistant',
  'attendee',
]);

export const userStatus = app.enum('user_status', ['active', 'suspended', 'deleted']);

export const orgMemberRole = app.enum('org_member_role', ['owner', 'admin', 'member']);

export const kycStatus = app.enum('kyc_status', ['unstarted', 'pending', 'verified', 'rejected']);

// ---------- users ----------
// Note: email uses plain text rather than citext to avoid requiring the citext
// extension. Case-insensitive uniqueness is enforced via a unique index on
// lower(email). The application normalizes emails to lowercase on write.

export const users = app.table(
  'users',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    email: text('email').notNull().unique(),
    passwordHash: text('password_hash'),
    emailVerifiedAt: timestamp('email_verified_at', {
      withTimezone: true,
      mode: 'date',
    }),
    displayName: text('display_name'),
    role: userRole('role').notNull().default('attendee'),
    status: userStatus('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    // updated_at: application code (or a future DB trigger) MUST bump this on
    // every row mutation. Default only covers initial insert.
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    emailLowerIdx: uniqueIndex('users_email_lower_idx').on(sql`lower(${table.email})`),
  }),
);

// ---------- organizations ----------

export const organizations = app.table(
  'organizations',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    // ownerUserId refs users.id — kept as plain uuid to allow future
    // cross-context flexibility; FK is added explicitly below for in-file refs.
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    // updated_at: application or trigger responsibility (see users.updatedAt).
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    // Explicit named index for readability (slug is already unique).
    orgSlugIdx: uniqueIndex('organizations_slug_idx').on(table.slug),
  }),
);

// ---------- sessions ----------

export const sessions = app.table(
  'sessions',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // sha256 hash of the refresh token; raw token never stored.
    refreshTokenHash: text('refresh_token_hash').notNull(),
    userAgent: text('user_agent'),
    // IP stored as text; no IPv4/6 type enforcement at this stage.
    ip: text('ip'),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    activeSessionsIdx: index('sessions_active_idx').on(
      table.userId,
      table.revokedAt,
      table.expiresAt,
    ),
    refreshTokenHashIdx: uniqueIndex('sessions_refresh_token_hash_idx').on(table.refreshTokenHash),
  }),
);

// ---------- organization_members ----------

export const organizationMembers = app.table(
  'organization_members',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: orgMemberRole('role').notNull().default('member'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.orgId, table.userId] }),
  }),
);

// ---------- photographer_profiles ----------

export const photographerProfiles = app.table('photographer_profiles', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  displayName: text('display_name').notNull(),
  bio: text('bio'),
  websiteUrl: text('website_url'),
  // Set by F2.9 KYC onboarding flow.
  stripeAccountId: text('stripe_account_id'),
  kycStatus: kycStatus('kyc_status').notNull().default('unstarted'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .default(sql`now()`),
  // updated_at: application or trigger responsibility (see users.updatedAt).
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .default(sql`now()`),
});

// ---------- magic_link_tokens ----------
// Passwordless auth: stores sha256 hashes of short-lived magic-link tokens.
// Plaintext token is emailed to the user; only the hash is persisted.

export const magicLinkTokens = app.table(
  'magic_link_tokens',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    emailLower: text('email_lower').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'date' }),
    ipHash: text('ip_hash'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    emailIdx: index('magic_link_tokens_email_idx').on(table.emailLower, table.expiresAt),
  }),
);

// ---------- Grouped export ----------

export const tables = {
  organizations,
  users,
  sessions,
  organizationMembers,
  photographerProfiles,
  magicLinkTokens,
};
