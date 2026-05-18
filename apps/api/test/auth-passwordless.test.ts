// Passwordless (magic-link) auth route tests. Stubs out the module-level db
// client with an in-memory fake and mocks the mail sender. Mirrors the testing
// style used in auth.test.ts (F1.2) but is purpose-built for the passwordless
// query shape.

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ----- env (must be set BEFORE importing the route module) -----
process.env.JWT_ACCESS_SECRET = 'test-access-secret-test-access-secret-xx';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-test-refresh-secret-x';
process.env.JWT_ACCESS_TTL = '15m';
process.env.JWT_REFRESH_TTL = '30d';
process.env.ARGON2_MEMORY_KIB = '8';
process.env.RATE_LIMIT_AUTH_REQS_PER_MIN = '1000';
process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
process.env.APP_BASE_URL = 'http://localhost:3000';

// ----- fake db -----

interface UserRow {
  id: string;
  email: string;
  passwordHash: string | null;
  emailVerifiedAt: Date | null;
  role: string;
  status: string;
}

interface MagicLinkRow {
  id: string;
  emailLower: string;
  tokenHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
  ipHash: string | null;
  userAgent: string | null;
}

interface SessionRow {
  id: string;
  userId: string;
  refreshTokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

interface AuditRow {
  action: string;
  actorKind: string;
  actorUserId: string | null;
}

interface Store {
  users: UserRow[];
  magicLinks: MagicLinkRow[];
  sessions: SessionRow[];
  audits: AuditRow[];
}

const makeId = (() => {
  let i = 0;
  return (prefix: string) => `${prefix}-${(++i).toString().padStart(8, '0')}`;
})();

const store: Store = { users: [], magicLinks: [], sessions: [], audits: [] };

const resetStore = (): void => {
  store.users = [];
  store.magicLinks = [];
  store.sessions = [];
  store.audits = [];
};

// Hint state captured by the mocked drizzle helpers below.
let lastTokenHashLookup: string | null = null;
let lastEmailLowerLookup: string | null = null;
let lastMagicLinkIdLookup: string | null = null;

// ---- Select chain ----

type Table = 'users' | 'magic_links' | 'sessions' | 'unknown';

const detectSelectTable = (fields: Record<string, unknown>): Table => {
  const keys = Object.keys(fields);
  if (keys.includes('tokenHash') || keys.includes('emailLower') || keys.includes('consumedAt')) {
    return 'magic_links';
  }
  if (keys.includes('refreshTokenHash')) return 'sessions';
  if (keys.includes('email') || keys.includes('passwordHash') || keys.includes('status')) {
    return 'users';
  }
  return 'unknown';
};

const project = (
  row: Record<string, unknown>,
  fields: Record<string, unknown>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(fields)) out[k] = row[k];
  return out;
};

const makeSelectChain = (fields: Record<string, unknown>) => {
  const table = detectSelectTable(fields);
  const chain = {
    from(_t: unknown) {
      return chain;
    },
    where(_expr: unknown) {
      return chain;
    },
    async limit(_n: number) {
      if (table === 'magic_links') {
        const hash = lastTokenHashLookup;
        lastTokenHashLookup = null;
        if (!hash) return [];
        const now = Date.now();
        const row = store.magicLinks.find(
          (m) => m.tokenHash === hash && m.consumedAt === null && m.expiresAt.getTime() > now,
        );
        return row ? [project(row as unknown as Record<string, unknown>, fields)] : [];
      }
      if (table === 'users') {
        const email = lastEmailLowerLookup;
        lastEmailLowerLookup = null;
        if (!email) return [];
        const row = store.users.find((u) => u.email.toLowerCase() === email);
        return row ? [project(row as unknown as Record<string, unknown>, fields)] : [];
      }
      return [];
    },
  };
  return chain;
};

// ---- Insert chain ----

type InsertTable = 'users' | 'magic_links' | 'sessions' | 'audit_log';

const detectInsertTable = (token: unknown): InsertTable => {
  if (typeof token === 'object' && token !== null) {
    const t = token as Record<string, unknown>;
    if ('tokenHash' in t || 'token_hash' in t || 'emailLower' in t || 'email_lower' in t) {
      return 'magic_links';
    }
    if ('refreshTokenHash' in t || 'refresh_token_hash' in t) return 'sessions';
    if ('email' in t || 'passwordHash' in t || 'password_hash' in t) return 'users';
    if ('action' in t || 'actorKind' in t) return 'audit_log';
  }
  return 'audit_log';
};

const makeInsertChain = (table: InsertTable) => {
  const builder = {
    _values: null as Record<string, unknown> | null,
    values(v: Record<string, unknown>) {
      this._values = v;
      return this;
    },
    returning(fields: Record<string, unknown>) {
      const v = this._values ?? {};
      let row: Record<string, unknown> = {};
      if (table === 'users') {
        const u: UserRow = {
          id: makeId('u'),
          email: String(v.email),
          passwordHash: (v.passwordHash as string | null) ?? null,
          emailVerifiedAt: (v.emailVerifiedAt as Date | null) ?? null,
          role: 'attendee',
          status: 'active',
        };
        store.users.push(u);
        row = u as unknown as Record<string, unknown>;
      } else if (table === 'magic_links') {
        const m: MagicLinkRow = {
          id: makeId('m'),
          emailLower: String(v.emailLower),
          tokenHash: String(v.tokenHash),
          expiresAt: v.expiresAt as Date,
          consumedAt: null,
          ipHash: (v.ipHash as string | null) ?? null,
          userAgent: (v.userAgent as string | null) ?? null,
        };
        store.magicLinks.push(m);
        row = m as unknown as Record<string, unknown>;
      } else if (table === 'sessions') {
        const s: SessionRow = {
          id: makeId('s'),
          userId: String(v.userId),
          refreshTokenHash: String(v.refreshTokenHash),
          expiresAt: v.expiresAt as Date,
          revokedAt: null,
        };
        store.sessions.push(s);
        row = s as unknown as Record<string, unknown>;
      }
      return Promise.resolve([project(row, fields)]);
    },
    then(onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
      const v = this._values ?? {};
      if (table === 'audit_log') {
        store.audits.push({
          action: String(v.action),
          actorKind: String(v.actorKind),
          actorUserId: (v.actorUserId as string | null) ?? null,
        });
      } else if (table === 'magic_links') {
        // Bare insert without .returning() — still persist.
        const m: MagicLinkRow = {
          id: makeId('m'),
          emailLower: String(v.emailLower),
          tokenHash: String(v.tokenHash),
          expiresAt: v.expiresAt as Date,
          consumedAt: null,
          ipHash: (v.ipHash as string | null) ?? null,
          userAgent: (v.userAgent as string | null) ?? null,
        };
        store.magicLinks.push(m);
      }
      return Promise.resolve(undefined).then(onFulfilled, onRejected);
    },
  };
  return builder;
};

// ---- Update chain ----

const makeUpdateChain = (table: 'magic_links' | 'sessions' | 'users') => {
  const builder = {
    _set: null as Record<string, unknown> | null,
    set(v: Record<string, unknown>) {
      this._set = v;
      return this;
    },
    where(_expr: unknown) {
      // For magic_links consume: requires lastMagicLinkIdLookup + isNull(consumedAt).
      const mid = lastMagicLinkIdLookup;
      lastMagicLinkIdLookup = null;
      if (table === 'magic_links' && mid) {
        const m = store.magicLinks.find((x) => x.id === mid);
        if (m && m.consumedAt === null && this._set?.consumedAt) {
          m.consumedAt = this._set.consumedAt as Date;
          return {
            returning: (_fields: Record<string, unknown>) => Promise.resolve([{ id: m.id }]),
          };
        }
        return {
          returning: (_fields: Record<string, unknown>) => Promise.resolve([]),
        };
      }
      return Promise.resolve(undefined);
    },
  };
  return builder;
};

const fakeDb = {
  select(fields: Record<string, unknown>) {
    return makeSelectChain(fields);
  },
  insert(table: unknown) {
    return makeInsertChain(detectInsertTable(table));
  },
  update(table: unknown) {
    const name = detectInsertTable(table);
    if (name === 'magic_links') return makeUpdateChain('magic_links');
    if (name === 'sessions') return makeUpdateChain('sessions');
    return makeUpdateChain('users');
  },
};

// ----- mocks -----

vi.mock('../src/lib/db.js', () => ({ db: fakeDb }));

const sendMailMock = vi.fn(async () => undefined);
vi.mock('../src/lib/email.js', () => ({
  sendMail: (...args: unknown[]) => sendMailMock(...args),
}));

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    eq: (col: unknown, val: unknown) => {
      if (typeof val === 'string') {
        if (val.startsWith('m-')) lastMagicLinkIdLookup = val;
        else if (/^[a-f0-9]{64}$/.test(val)) lastTokenHashLookup = val;
      }
      return { __eq: true, col, val };
    },
    sql: Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        if (strings.join('').includes('lower(')) {
          const candidate = values[values.length - 1];
          if (typeof candidate === 'string') {
            lastEmailLowerLookup = candidate.toLowerCase();
          }
        }
        return { __sql: strings.join('|'), values };
      },
      { raw: (s: string) => ({ __raw: s }) },
    ),
  };
});

// ----- now import the SUT -----

const buildApp = async (): Promise<FastifyInstance> => {
  const Fastify = (await import('fastify')).default;
  const routes = (await import('../src/routes/auth-passwordless.js')).default;
  const app = Fastify({ logger: false });
  await app.register(routes);
  await app.ready();
  return app;
};

describe('passwordless auth routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    resetStore();
    sendMailMock.mockClear();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('POST /v1/auth/passwordless/request → 200 for unknown email (no enumeration)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/passwordless/request',
      payload: { email: 'ghost@example.com' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ message: 'If that email exists, a link has been sent.' });
  });

  it('POST /v1/auth/passwordless/request writes a token row with sha256 hash + 15min ttl', async () => {
    const before = Date.now();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/passwordless/request',
      payload: { email: 'Alice@Example.COM' },
    });
    expect(res.statusCode).toBe(200);
    expect(store.magicLinks).toHaveLength(1);
    const row = store.magicLinks[0];
    if (!row) throw new Error('expected row');
    expect(row.emailLower).toBe('alice@example.com');
    expect(row.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(row.consumedAt).toBeNull();
    const ttlMs = row.expiresAt.getTime() - before;
    expect(ttlMs).toBeGreaterThan(14 * 60 * 1000);
    expect(ttlMs).toBeLessThanOrEqual(15 * 60 * 1000 + 1000);
    expect(sendMailMock).toHaveBeenCalledOnce();
    // Plaintext token MUST NOT appear in stored row.
    const html = sendMailMock.mock.calls[0]?.[0]?.html as string;
    expect(html).toContain('http://localhost:3000/auth/verify?token=');
  });

  it('POST /v1/auth/passwordless/request is always 200 for malformed payload (no enumeration)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/passwordless/request',
      payload: { email: 'not-an-email' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('POST /v1/auth/passwordless/verify happy path → 200 + creates user when missing', async () => {
    // Seed a magic-link row by going through request.
    await app.inject({
      method: 'POST',
      url: '/v1/auth/passwordless/request',
      payload: { email: 'newuser@example.com' },
    });
    // Recover plaintext from the email mock.
    const html = sendMailMock.mock.calls[0]?.[0]?.html as string;
    const match = /token=([^"\s]+)/.exec(html);
    if (!match) throw new Error('token not in email');
    const plain = decodeURIComponent(match[1] ?? '');

    expect(store.users).toHaveLength(0);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/passwordless/verify',
      payload: { token: plain },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.accessToken).toBe('string');
    expect(typeof body.refreshToken).toBe('string');
    expect(body.user.email).toBe('newuser@example.com');
    expect(store.users).toHaveLength(1);
    expect(store.sessions).toHaveLength(1);
    // Token now marked consumed.
    expect(store.magicLinks[0]?.consumedAt).not.toBeNull();
  });

  it('POST /v1/auth/passwordless/verify with expired token → 401', async () => {
    // Insert an expired row directly.
    const { hashMagicLinkToken } = await import('../src/auth/magic-link.js');
    const plain = 'expired-token-plain';
    const hash = hashMagicLinkToken(plain);
    store.magicLinks.push({
      id: makeId('m'),
      emailLower: 'expired@example.com',
      tokenHash: hash,
      expiresAt: new Date(Date.now() - 60 * 1000),
      consumedAt: null,
      ipHash: null,
      userAgent: null,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/passwordless/verify',
      payload: { token: plain },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_token');
  });

  it('POST /v1/auth/passwordless/verify with consumed token → 401 (replay protection)', async () => {
    const { hashMagicLinkToken } = await import('../src/auth/magic-link.js');
    const plain = 'consumed-token-plain';
    const hash = hashMagicLinkToken(plain);
    store.magicLinks.push({
      id: makeId('m'),
      emailLower: 'consumed@example.com',
      tokenHash: hash,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      consumedAt: new Date(),
      ipHash: null,
      userAgent: null,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/passwordless/verify',
      payload: { token: plain },
    });
    expect(res.statusCode).toBe(401);
  });

  it('POST /v1/auth/passwordless/verify with bogus token → 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/passwordless/verify',
      payload: { token: 'nonsense-token-that-does-not-exist' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('POST /v1/auth/passwordless/verify with malformed payload → 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/passwordless/verify',
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });
});
