// Auth route integration tests against real Postgres via testcontainers.
//
// Re-enables the 6 tests skipped under #107:
//   - register lowercases email
//   - duplicate email -> 409
//   - login happy path
//   - login wrong password
//   - login wrong email
//   - refresh rotates tokens
//
// Strategy: globalSetup spins up Postgres + applies migrations and sets
// DATABASE_URL before any module is imported. The auth routes use the lazy
// db proxy from src/lib/db.ts, so they pick up the live URL transparently.
// We rely on per-test cleanup (TRUNCATE users + sessions) rather than the
// withTransaction helper because the auth route opens its own implicit
// transactions inside the request handler and a wrapping tx would deadlock.

import { createDbClient, schema } from '@pkg/db';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const { users } = schema.users.tables;

describe('auth routes — real Postgres', () => {
  let app: FastifyInstance;
  let db: ReturnType<typeof createDbClient>;

  beforeAll(async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('integration globalSetup did not set DATABASE_URL');
    db = createDbClient(url);
  });

  afterAll(async () => {
    // postgres-js pools persist; we let the process exit clean them up.
  });

  beforeEach(async () => {
    // Clean state between tests. CASCADE handles sessions + audit FKs.
    await db.execute(
      sql`TRUNCATE TABLE app.audit_log, app.sessions, app.users RESTART IDENTITY CASCADE`,
    );

    const Fastify = (await import('fastify')).default;
    const authRoutes = (await import('../src/routes/auth.js')).default;
    app = Fastify({ logger: false });
    await app.register(authRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('POST /v1/auth/register → 201 and lowercases email', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'Alice@Example.COM',
        password: 'correct-horse-battery-staple',
        displayName: 'Alice',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user.email).toBe('alice@example.com');
    expect(body.user.role).toBe('attendee');

    const rows = await db.select().from(users).where(sql`${users.email} = 'alice@example.com'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.email).toBe('alice@example.com');
  });

  it('POST /v1/auth/register duplicate email → 409', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'bob@example.com', password: 'correct-horse-battery-staple' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'BOB@example.com', password: 'correct-horse-battery-staple' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('POST /v1/auth/login happy path → 200', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'carol@example.com', password: 'correct-horse-battery-staple' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'carol@example.com', password: 'correct-horse-battery-staple' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.accessToken).toBe('string');
    expect(typeof body.refreshToken).toBe('string');
    expect(body.user.email).toBe('carol@example.com');
    const setCookie = res.headers['set-cookie'];
    const cookieStr = Array.isArray(setCookie) ? setCookie.join(';') : (setCookie ?? '');
    expect(cookieStr).toContain('refresh_token=');
    expect(cookieStr).toContain('HttpOnly');
    expect(cookieStr).toContain('SameSite=Strict');
  });

  it('POST /v1/auth/login wrong password → 401', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'dan@example.com', password: 'correct-horse-battery-staple' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'dan@example.com', password: 'wrong-password-xxxxx' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_credentials');
  });

  it('POST /v1/auth/login wrong email → 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'nobody@example.com', password: 'anything-at-all-xxxx' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_credentials');
  });

  it('POST /v1/auth/refresh rotates tokens', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'eve@example.com', password: 'correct-horse-battery-staple' },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'eve@example.com', password: 'correct-horse-battery-staple' },
    });
    const { refreshToken } = login.json();
    const refreshRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken },
    });
    expect(refreshRes.statusCode).toBe(200);
    const body = refreshRes.json();
    expect(typeof body.accessToken).toBe('string');
    expect(body.refreshToken).not.toBe(refreshToken);

    // Original refresh token now reused -> must be revoked and reject.
    const reuse = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken },
    });
    expect(reuse.statusCode).toBe(401);
  });
});
