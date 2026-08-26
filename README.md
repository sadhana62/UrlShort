# Link Shortener Backend

This project is a Node.js + Express URL shortener backed by PostgreSQL, with Redis used for hot-link caching and distributed rate limiting.

> For a deep dive into **why** each design decision was made (caching, rate limiting, Snowflake IDs, Docker, and more), see [PROJECT_DOCUMENTATION.md](./PROJECT_DOCUMENTATION.md).

## What this project now demonstrates

- JWT-based signup/login and authenticated link management
- Snowflake-style distributed ID generation instead of a single auto-increment source
- Redis cache-aside for hot short-code lookups
- Redis-backed sliding-window rate limiting on link creation
- Async analytics ingestion so redirects do not block on write-heavy side effects
- Basic health checks and analytics endpoints
- Automated tests (Jest + Supertest) and a Postman collection covering every endpoint

## Stack

- Node.js
- Express
- PostgreSQL
- Redis
- JWT
- bcrypt
- Docker (for local Postgres + Redis)
- Jest + Supertest (automated testing)

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+ recommended)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) — used to run Postgres and Redis locally without installing them directly on your machine

## Run locally with Docker

This is the recommended way to run the project — it spins up Postgres and Redis in containers so you don't need to install either one natively.

1. **Start Postgres and Redis:**
   ```bash
   docker compose up -d
   ```
   This reads `docker-compose.yml` and starts two containers: `linkshortener-postgres` (Postgres 16) and `linkshortener-redis` (Redis 7), with their data stored in named Docker volumes so it persists across restarts.

2. **Confirm both containers are running:**
   ```bash
   docker ps
   ```
   You should see both containers with status `Up`.

3. **Set up your environment file:**
   ```bash
   cp .env.example .env
   ```
   The default values in `.env.example` already match the Docker Compose setup, so no edits are required for local development — just replace `JWT_SECRET` with your own random string.

4. **Install dependencies:**
   ```bash
   npm install
   ```

5. **Start the app:**
   ```bash
   npm start
   ```
   On first run, the app automatically creates the `users`, `links`, and `link_clicks` tables (see `db.js`) — no manual schema setup needed. The server starts on `http://localhost:3000`.

6. **Verify it's working:**
   ```bash
   curl http://localhost:3000/health
   ```
   A healthy response looks like:
   ```json
   { "status": "ok", "database": "up", "redis": "up", "analytics": { "queuedEvents": 0 } }
   ```

### Stopping and resetting

- **Stop containers (keep data):** `docker compose down`
- **Stop containers AND delete all data** (useful if you want a completely clean database): `docker compose down -v`, then verify with `docker volume ls` that the volumes are actually gone before running `docker compose up -d` again.

## Running the tests

Both test approaches run against a **real** running server (with real Postgres/Redis behind it), not mocks — this project's interesting behavior (caching, rate limiting) can only be verified against real infrastructure.

**Automated (Jest + Supertest):**
```bash
# In one terminal — leave it running:
npm start

# In a second terminal:
npm test
```

**Postman:** import `postman_collection.json` into Postman and run the collection top to bottom — it auto-captures tokens and IDs between requests.

## Environment variables

- `DATABASE_URL`: PostgreSQL connection string
- `JWT_SECRET`: secret used to sign JWTs
- `REDIS_URL`: Redis connection string
- `LINK_CACHE_TTL_SECONDS`: TTL for hot URL cache entries
- `SHORTEN_RATE_LIMIT_WINDOW_MS`: sliding-window duration for shorten requests
- `SHORTEN_RATE_LIMIT_MAX`: max requests allowed in that window
- `ANALYTICS_FLUSH_INTERVAL_MS`: flush cadence for queued click events
- `ANALYTICS_BATCH_SIZE`: number of click events flushed per batch
- `SNOWFLAKE_NODE_ID`: node identifier for distributed ID generation

## API summary

### Auth

- `POST /api/auth/signup`
- `POST /api/auth/login`
- `GET /api/auth/me`

### Links

- `POST /api/links`
- `GET /api/links`
- `GET /api/links/:id`
- `PUT /api/links/:id`
- `DELETE /api/links/:id`
- `GET /api/links/:id/stats`

### Redirect and health

- `GET /:short_code`
- `GET /health`

## Architecture notes

### 1. Cache-aside Redis layer for hot URL lookups

Redirects follow a cache-aside flow:

1. Check Redis with key `link:{short_code}`.
2. If present, redirect immediately from cached data.
3. If absent, fetch from PostgreSQL.
4. Store the result in Redis with a TTL.

This keeps the common read path fast and reduces repeated database hits for popular links.

Cache invalidation happens on:

- `PUT /api/links/:id`
- `DELETE /api/links/:id`

That is the important discipline in the cache-aside pattern: reads populate the cache, writes clear stale entries.

### 2. Snowflake-style ID generation

Instead of relying on a single `SERIAL` counter for link IDs, the app generates IDs in-process using:

- timestamp component
- node ID component
- per-millisecond sequence component

Benefits:

- IDs can be generated without asking the database first
- avoids a single write bottleneck for identifier creation
- gives you a clean talking point for distributed systems interviews

The short code is the Base62 encoding of that generated ID.

### 3. Redis-backed rate limiting

`POST /api/links` uses a sliding-window limiter in Redis.

Key shape:

- `rate-limit:shorten:{userIdOrIp}`

Redis stores timestamps in a sorted set and the app:

1. removes expired timestamps
2. counts requests still inside the window
3. rejects if the count already exceeds the allowed limit
4. stores the new request timestamp

This works across multiple stateless app servers because the state lives in Redis, not process memory.

### 4. Async analytics write path

The redirect route no longer inserts into `link_clicks` inline. Instead it:

1. resolves the destination URL
2. enqueues the click event in memory
3. redirects immediately

A background worker flushes queued events to PostgreSQL in batches.

Why this matters:

- redirect latency stays low
- click ingestion is decoupled from the critical path
- the system is better prepared for write-heavy traffic bursts

Current limitation:

- the queue is process-local, so a crash can lose in-flight events

Production next step:

- move the queue to Redis Streams, Kafka, RabbitMQ, or SQS
- run a separate worker process for durable analytics consumption

### 5. Read/write split and future sharding plan

This project still uses a single PostgreSQL instance, but the design can evolve like this:

#### Near-term split

- writes: primary Postgres
- reads: read replicas for stats and list endpoints

#### Future sharding

Shard links by a deterministic hash of `short_code` or link ID:

- shard 0 handles `hash(short_code) % N == 0`
- shard 1 handles `hash(short_code) % N == 1`
- ...

Why by short-code hash:

- redirects are keyed by short code
- lookup routing becomes deterministic
- traffic spreads more evenly than date-based partitioning for this use case

One clean architecture would be:

- API layer computes shard from short code
- writes and reads route to the owning shard
- analytics can live in a separate write-optimized store later

## Data model

### `users`

- `id`
- `email`
- `password_hash`
- `created_at`

### `links`

- `id` (`BIGINT`, Snowflake-generated)
- `user_id`
- `short_code`
- `original_url`
- `is_active`
- `created_at`
- `updated_at`

### `link_clicks`

- `id`
- `link_id`
- `clicked_at`
- `user_agent`
- `referrer`

## Example flow

### Create a short link

`POST /api/links`

```json
{
  "original_url": "https://example.com"
}
```

Response:

```json
{
  "id": "844424930136064",
  "short_code": "N0hYB2q",
  "original_url": "https://example.com",
  "created_at": "2026-08-22T10:00:00.000Z"
}
```

### Fetch analytics

`GET /api/links/:id/stats`

Response includes:

- `total_clicks`
- `clicks_over_time`
- `top_referrers`



## Current limitations

- async analytics queue is in-memory, not durable
- no custom aliases yet
- no background dead-letter handling for failed analytics writes
- no read replicas or real shard router yet; those are documented as the next scale step