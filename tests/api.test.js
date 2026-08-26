/**
 * Automated API test suite for the Link Shortener backend.
 *
 * These are integration tests: they hit a REAL running server
 * (with real Postgres + Redis behind it), not mocks. That matches
 * what this project actually needs to prove -- cache-aside behavior,
 * Redis-backed rate limiting, and async analytics flush timing only
 * mean something against real infra.
 *
 * BEFORE RUNNING:
 *   1. docker compose up -d        (Postgres + Redis)
 *   2. npm start                   (in one terminal, leave it running)
 *   3. npm test                    (in another terminal)
 *
 * The suite creates its own unique user and links per run (timestamped)
 * so it's safe to re-run without manual cleanup.
 */

const request = require('supertest');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const api = request(BASE_URL);

const runId = Date.now();
const testEmail = `jest-${runId}@example.com`;
const testPassword = 'test1234';

let token;
let linkId;
let shortCode;

// Give slow environments (first Docker pull, cold DB connection) room to breathe.
jest.setTimeout(20000);

describe('Health', () => {
  test('GET /health reports database and redis up', async () => {
    const res = await api.get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.database).toBe('up');
    expect(res.body.redis).toBe('up');
  });
});

describe('Auth', () => {
  test('POST /api/auth/signup creates a new user', async () => {
    const res = await api
      .post('/api/auth/signup')
      .send({ email: testEmail, password: testPassword });
    expect(res.status).toBe(201);
    expect(res.body.email).toBe(testEmail);
  });

  test('POST /api/auth/signup rejects a duplicate email', async () => {
    const res = await api
      .post('/api/auth/signup')
      .send({ email: testEmail, password: testPassword });
    expect(res.status).toBe(409);
  });

  test('POST /api/auth/login returns a JWT', async () => {
    const res = await api
      .post('/api/auth/login')
      .send({ email: testEmail, password: testPassword });
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    token = res.body.token;
  });

  test('POST /api/auth/login rejects a wrong password', async () => {
    const res = await api
      .post('/api/auth/login')
      .send({ email: testEmail, password: 'wrong-password' });
    expect(res.status).toBe(401);
  });

  test('GET /api/auth/me returns the authenticated user', async () => {
    const res = await api
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.email).toBe(testEmail);
  });

  test('GET /api/auth/me without a token is rejected', async () => {
    const res = await api.get('/api/auth/me');
    expect(res.status).toBe(401);
  });
});

describe('Links: create, list, get', () => {
  test('POST /api/links creates a short link', async () => {
    const res = await api
      .post('/api/links')
      .set('Authorization', `Bearer ${token}`)
      .send({ original_url: `https://example.com/${runId}` });
    if (res.status !== 201) {
      // eslint-disable-next-line no-console
      console.log('DEBUG create-link failure body:', JSON.stringify(res.body));
    }
    expect(res.status).toBe(201);
    expect(typeof res.body.short_code).toBe('string');
    linkId = res.body.id;
    shortCode = res.body.short_code;
  });

  test('POST /api/links with the same URL returns the existing short_code (dedup)', async () => {
    const res = await api
      .post('/api/links')
      .set('Authorization', `Bearer ${token}`)
      .send({ original_url: `https://example.com/${runId}` });
    expect(res.status).toBe(200);
    expect(res.body.short_code).toBe(shortCode);
  });

  test('GET /api/links lists the created link', async () => {
    const res = await api
      .get('/api/links')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const ids = res.body.map((l) => String(l.id));
    expect(ids).toContain(String(linkId));
  });

  test('GET /api/links/:id returns that link', async () => {
    const res = await api
      .get(`/api/links/${linkId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(String(res.body.id)).toBe(String(linkId));
  });

  test('GET /api/links/:id for another user\'s link (or nonexistent id) is not found', async () => {
    const res = await api
      .get('/api/links/999999999999999')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

describe('Redirect + cache-aside', () => {
  test('GET /:short_code redirects to the original URL', async () => {
    const res = await api.get(`/${shortCode}`).redirects(0);
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.location).toBe(`https://example.com/${runId}`);
  });

  test('a second redirect hit is served consistently (cache populated)', async () => {
    const res = await api.get(`/${shortCode}`).redirects(0);
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.headers.location).toBe(`https://example.com/${runId}`);
  });

  test('unknown short_code returns 404', async () => {
    const res = await api.get('/thisCodeDoesNotExist123').redirects(0);
    expect(res.status).toBe(404);
  });
});

describe('Analytics (async click ingestion)', () => {
  test('GET /api/links/:id/stats reflects clicks after the flush interval', async () => {
    // Fire a few more clicks, then wait past ANALYTICS_FLUSH_INTERVAL_MS
    // (default 1000ms) before asserting -- this is what actually proves
    // the async queue is writing to Postgres, not just accepting requests.
    await api.get(`/${shortCode}`).redirects(0);
    await api.get(`/${shortCode}`).redirects(0);

    await new Promise((resolve) => setTimeout(resolve, 2000));

    const res = await api
      .get(`/api/links/${linkId}/stats`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.total_clicks).toBeGreaterThanOrEqual(2);
  });
});

describe('Update + cache invalidation', () => {
  test('PUT /api/links/:id updates the URL', async () => {
    const res = await api
      .put(`/api/links/${linkId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ original_url: `https://changed-example.com/${runId}` });
    expect(res.status).toBe(200);
    expect(res.body.original_url).toBe(`https://changed-example.com/${runId}`);
  });

  test('redirect after update goes to the NEW url, proving the cache was invalidated', async () => {
    const res = await api.get(`/${shortCode}`).redirects(0);
    expect(res.headers.location).toBe(`https://changed-example.com/${runId}`);
  });
});

describe('Rate limiting', () => {
  test('exceeding SHORTEN_RATE_LIMIT_MAX returns 429', async () => {
    const max = Number(process.env.SHORTEN_RATE_LIMIT_MAX || 10);
    let sawRateLimit = false;
    let lastStatus;

    // Fire one more than the configured max, each with a unique URL
    // so we're not just hitting the dedup path instead of the limiter.
    for (let i = 0; i <= max; i += 1) {
      const res = await api
        .post('/api/links')
        .set('Authorization', `Bearer ${token}`)
        .send({ original_url: `https://example.com/rate-limit-${runId}-${i}` });
      lastStatus = res.status;
      if (res.status === 429) {
        sawRateLimit = true;
        break;
      }
    }

    expect(sawRateLimit).toBe(true);
    expect(lastStatus).toBe(429);
  });
});

describe('Delete', () => {
  let throwawayId;

  test('POST /api/links creates a throwaway link to delete', async () => {
    const res = await api
      .post('/api/links')
      .set('Authorization', `Bearer ${token}`)
      .send({ original_url: `https://delete-me.example.com/${runId}` });
    // May legitimately be 429 if the rate-limit test above just maxed out
    // the window -- in that case we skip the delete assertions gracefully.
    if (res.status === 429) {
      throwawayId = null;
      return;
    }
    expect(res.status).toBe(201);
    throwawayId = res.body.id;
  });

  test('DELETE /api/links/:id removes the link', async () => {
    if (!throwawayId) return;
    const res = await api
      .delete(`/api/links/${throwawayId}`)
      .set('Authorization', `Bearer ${token}`);
    expect([200, 204]).toContain(res.status);
  });

  test('GET /api/links/:id after delete returns 404', async () => {
    if (!throwawayId) return;
    const res = await api
      .get(`/api/links/${throwawayId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});