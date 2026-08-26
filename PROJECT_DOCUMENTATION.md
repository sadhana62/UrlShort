# Link Shortener — Project Documentation

A backend-focused URL shortener built with Node.js, Express, PostgreSQL, and Redis. This isn't just "make a long URL short" — the actual goal of this project was to use a simple, well-understood problem as a vehicle for practicing real distributed-systems and backend-engineering patterns: caching, rate limiting, ID generation without central coordination, and decoupling slow work from the request path.

This document explains **why** the project exists, **why** each technology was chosen, and **how** the pieces fit together — so you can explain any part of it confidently in an interview or when handing it off to someone else.

---

## 1. Why build a URL shortener at all?

On the surface it's a toy problem: turn `https://example.com/some/very/long/path` into `http://localhost:3000/N0hYB2q`. But underneath, a *production-grade* URL shortener has to solve several genuinely hard problems at scale:

- **Redirects must be fast.** A short link redirect is on the critical path of someone's click — every millisecond of latency is felt directly by a real user.
- **Redirects vastly outnumber creations.** A single popular link might get shortened once and clicked millions of times. This read-heavy, write-light pattern is exactly what caching is built for.
- **IDs need to be generated at high volume, from multiple servers, without fighting over a single counter.** A naive auto-increment column becomes a bottleneck the moment you have more than one app server.
- **Abuse is easy and cheap.** Anyone can hit `POST /api/links` in a loop and generate spam or exhaust your database.
- **Analytics (click tracking) must not slow down the redirect itself.** Recording *that* a click happened is not something the user should have to wait for.

Each of these problems maps directly to one of the architectural decisions below. That mapping — problem → decision — is the actual point of the project.

---

## 2. What this server actually provides

At a high level, the server offers four groups of services:

| Service | Purpose |
|---|---|
| **Auth** | Signup/login with hashed passwords and JWTs, so links belong to accounts and only the owner can manage them |
| **Link management** | Create, list, update, delete short links; each maps a short code to a destination URL |
| **Redirect** | The actual `GET /:short_code` → `302` to the original URL — this is the "hot path" of the whole system |
| **Analytics** | Click counts, click-over-time, and top referrers per link, computed from click events recorded asynchronously |

Everything else in the architecture (Redis, Snowflake IDs, rate limiting, the async queue) exists purely to make these four services fast, safe, and scalable — not because they're impressive-sounding buzzwords.

---

## 3. Why each technology was chosen

### Node.js + Express
Express is a thin, unopinionated HTTP layer — it doesn't hide what's happening on each request, which matters when the *point* of the project is to reason clearly about caching, rate limiting, and async work. A heavier framework would obscure exactly the parts we want to be deliberate about.

### PostgreSQL
The source of truth. Links, users, and click records need to survive restarts and support relational integrity — e.g., a `link_clicks` row referencing a `links` row via a real foreign key. Postgres also gives us `BIGINT` primary keys (needed for Snowflake IDs — see below) and indexing for the query patterns this app actually uses (`user_id + created_at`, `link_id + clicked_at`).

### Redis
Two completely different jobs, both suited to Redis specifically because it's fast, in-memory, and — crucially — **shared across every app server**, unlike process memory:

1. **Caching hot short-code lookups** (see §4)
2. **Rate limiting link creation** (see §5)

### JWT + bcrypt
Stateless auth: once a user logs in, the server doesn't need to look anything up to verify who they are on every request — the token itself carries that. `bcrypt` hashes passwords so raw passwords are never stored, following standard practice (salted, slow-to-brute-force hashing).

### Docker
Postgres and Redis need to run *somewhere* consistently across machines. Docker means "the database and cache are exactly this version, configured exactly this way" regardless of whether you're running this on a Windows laptop, a teammate's Mac, or a CI pipeline. See §8 for the deeper "why Docker specifically" explanation.

---

## 4. Why Redis cache-aside for redirects

**The problem:** every redirect (`GET /:short_code`) needs to look up the destination URL. If every single redirect hits Postgres, a popular link gets hammered with repeated, identical, read-only queries — wasted database load for information that doesn't change often.

**The pattern — cache-aside:**
1. On a redirect request, check Redis first (`link:{short_code}`).
2. **Cache hit** → return the cached destination immediately. No database touched at all.
3. **Cache miss** → query Postgres, then *write* the result into Redis (with a TTL) before responding, so the next request is a hit.

**Why this specific pattern (vs. always writing to cache on create):** cache-aside only ever caches things that are actually being read. A link nobody clicks never occupies cache memory. This matters because most short links in the real world are only ever clicked a handful of times (or never) — cache-aside naturally caches only the *popular* links, which is exactly the ones causing repeated load.

**The part people get wrong — invalidation:** if a link's destination URL is updated (`PUT /api/links/:id`) or deleted, the cached entry becomes stale and would keep sending users to the *old* URL. That's why both `PUT` and `DELETE` explicitly call `invalidateCachedLink()` to remove the stale Redis entry — the next read is forced to miss, hit Postgres, and re-cache the correct value. This discipline (writes invalidate, reads repopulate) is the entire reason cache-aside is safe to use.

---

## 5. Why Redis for rate limiting (and why a sliding window)

**The problem:** `POST /api/links` is a write endpoint — it touches the database. Without a limit, one user (or a bot) could spam link creation and degrade the service for everyone else.

**Why not just count requests in a JavaScript variable in memory?** Because Node apps in production typically run as *multiple processes* (for scaling and reliability). If server A and server B each keep their own private in-memory counter, a client can bypass the "limit" just by having requests land on different servers. Redis solves this because it's a single shared source of truth that every server instance can read and write to — the limit is enforced *globally*, not per-process.

**Why a sliding window instead of a simple fixed window?** A naive fixed window (e.g., "max 10 requests per minute, resetting on the minute") allows a burst of 20 requests right at the boundary — 10 in the last second of one window, 10 in the first second of the next. A sliding window (implemented here with a Redis **sorted set**, timestamps as scores) continuously looks back exactly N milliseconds from *now*, so there's no exploitable boundary. The algorithm:

1. Remove timestamps older than the window (`ZREMRANGEBYSCORE`)
2. Count what's left (`ZCARD`)
3. If under the limit, record this request's timestamp (`ZADD`) and set an expiry on the whole key
4. If at/over the limit, reject with `429`

This is a genuinely industry-standard rate-limiting pattern, not a toy version — the same idea (sorted-set sliding window in Redis) shows up in real production rate limiters.

**A deliberate safety choice:** if Redis itself is unreachable, this rate limiter **fails open** (allows the request rather than blocking everyone). The reasoning: a rate limiter's job is to protect against *abuse*, not to become a single point of failure that takes down the whole app if the cache goes down. Losing rate limiting temporarily is a much smaller problem than losing all writes.

---

## 6. Why Snowflake-style IDs instead of auto-increment

**The problem:** a standard auto-increment (`SERIAL`) primary key requires the database to hand out the *next* number — every insert has to coordinate through one counter. That's fine on a single small app, but it becomes a central bottleneck the moment you want multiple app servers writing at once, and it doesn't work at all if you ever split into multiple database shards (each shard would generate colliding IDs).

**The Snowflake approach:** generate a unique 64-bit ID *in the application process itself*, with no database round-trip required, by packing three pieces of information into one number:

- A timestamp (so IDs are roughly sortable by creation time)
- A node ID (so multiple app servers never generate the same ID, even at the exact same millisecond)
- A per-millisecond sequence counter (so a single server can generate many IDs within the same millisecond without collisions)

The short code itself is just this number encoded in Base62 (0-9, a-z, A-Z) to make it compact and URL-safe.

**Why this matters for an interview:** this is a real pattern used by Twitter (who popularized it), Discord, Instagram, and others, specifically because it removes the database as a coordination point for ID generation — a genuine distributed-systems concept, not just a way to make random-looking strings.

---

## 7. Why async analytics instead of writing clicks synchronously

**The problem:** every redirect could, in principle, also write a row into `link_clicks` (who clicked, when, from where). But if that database write happens *before* the redirect response is sent, every single redirect is now as slow as the slowest part of that write — and a burst of clicks on a popular link creates a burst of writes competing with the read-heavy redirect traffic.

**The fix:** the redirect handler doesn't write to the database at all. It resolves the destination URL, **pushes the click event onto an in-memory queue**, and responds immediately. A separate background worker periodically flushes the queue to Postgres in batches (by time interval or batch size, whichever comes first).

**Why this is the right trade-off:** it decouples "the user needs *this* fast" (the redirect) from "the business needs *this* eventually, but not necessarily instantly" (analytics). Batching writes is also far more efficient for Postgres than one insert per click.

**Known, documented limitation:** because the queue currently lives in application memory, a server crash between "click enqueued" and "batch flushed" loses those events. The project intentionally documents this rather than hiding it — the honest next step (see below) is to move the queue to something durable like Redis Streams, Kafka, or SQS, so events survive a crash.

---

## 8. Why Docker (specifically, why not "just install Postgres and Redis locally")

- **Reproducibility.** "Run `docker compose up -d`" produces the exact same Postgres 16 + Redis 7 setup on any machine — no "works on my machine" version drift.
- **Isolation.** Postgres and Redis run in their own containers with their own storage, completely separate from anything else installed on the host machine. Deleting them (`docker compose down -v`) leaves zero trace on the host.
- **Throwaway-safe for local dev.** Because state lives in a named Docker *volume* rather than being installed system-wide, you can nuke and recreate the entire database with one command if something gets into a bad state — genuinely useful, and something this project needed while debugging a schema issue during development.
- **Matches how this would really be deployed.** Production systems overwhelmingly run Postgres/Redis as managed services or containers, not hand-installed on a bare server — using Docker locally mirrors that reality.

**A hard-won lesson from building this:** Docker *volumes* persist data across container restarts on purpose — that's the point, so you don't lose your database every time you stop the containers. But it means `docker compose down` alone does **not** wipe your data; you need `docker compose down -v` to also remove the volumes, and even then it's worth confirming with `docker volume ls` that they're actually gone. This project hit a real bug where a stale table schema kept surviving container restarts specifically because of this — a good example of why "restart it" and "reset it" are different operations with Docker.

---

## 9. Data model

```
users
├── id (BIGSERIAL, PK)
├── email (unique)
├── password_hash
└── created_at

links
├── id (BIGINT, Snowflake-generated, PK)
├── user_id (FK → users.id, ON DELETE CASCADE)
├── short_code (unique)
├── original_url
├── is_active
├── created_at
└── updated_at

link_clicks
├── id (BIGSERIAL, PK)
├── link_id (FK → links.id, ON DELETE CASCADE)
├── clicked_at
├── user_agent
└── referrer
```

`ON DELETE CASCADE` matters here: deleting a user removes their links, and deleting a link removes its click history — no orphaned rows left behind.

---

## 10. API reference

### Auth
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/signup` | Create an account |
| POST | `/api/auth/login` | Get a JWT |
| GET | `/api/auth/me` | Confirm who the current token belongs to |

### Links (require `Authorization: Bearer <token>`)
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/links` | Create a short link (deduped per-user by URL) |
| GET | `/api/links` | List your links |
| GET | `/api/links/:id` | Get one link |
| PUT | `/api/links/:id` | Update URL / active status (invalidates cache) |
| DELETE | `/api/links/:id` | Delete a link (invalidates cache) |
| GET | `/api/links/:id/stats` | Total clicks, clicks over time, top referrers |

### Public
| Method | Path | Purpose |
|---|---|---|
| GET | `/:short_code` | The actual redirect |
| GET | `/health` | Reports database, Redis, and analytics-queue status |

---

## 11. Testing

Two complementary layers exist, both hitting a **real running server** (with real Postgres/Redis) rather than mocks — deliberately, because mocking Redis/Postgres would mean never actually proving the cache-aside or rate-limiting logic works:

- **`tests/api.test.js`** — Jest + Supertest integration suite. Run with `npm test` (requires the app and Docker containers already running).
- **Postman collection** — the same flows, importable for manual/exploratory testing and as living API documentation.

---

## 12. Known, honest limitations

These are documented intentionally rather than hidden — a good sign of engineering maturity is knowing exactly where the edges of a system are:

- Analytics queue is in-memory, not durable (see §7)
- No custom short-code aliases (auto-generated only)
- No dead-letter handling for analytics batches that fail to write
- No read replicas or real shard router yet — the sharding strategy (by `short_code` hash) is designed and documented but not implemented

---

## 13. What NOT to push to GitHub (`.gitignore` check)

Your current `.gitignore` already correctly excludes:
- `node_modules/` — huge, regenerable from `package-lock.json` via `npm install`
- `.env` — contains secrets (JWT secret, DB credentials) that should never be committed
- Log files, PID files, coverage output, OS/editor cruft (`.DS_Store`, `Thumbs.db`), `.vscode/`

**Two things to clean up before pushing, found while reviewing the repo:**
1. A stale nested `project/project/` folder (an old, outdated copy of `db.js`, `index.js`, and some routes) is currently **tracked in git** — `.gitignore` doesn't retroactively untrack already-committed files. Remove it with `git rm -r project/project` and commit.
2. `package.json.old` (a backup made during troubleshooting) isn't tracked yet but also isn't ignored — either delete it or add a line for it in `.gitignore` before it gets accidentally committed.

**Always keep `.env.example` tracked** (unlike `.env` itself) — it documents which environment variables are needed without leaking real values, which is exactly what someone cloning the repo needs.