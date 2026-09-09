const { Pool } = require('pg');
require('dotenv').config();


const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function ensureLinksSchema() {
  await pool.query('ALTER TABLE link_clicks DROP CONSTRAINT IF EXISTS link_clicks_link_id_fkey');
  await pool.query('ALTER TABLE links DROP CONSTRAINT IF EXISTS links_user_id_fkey');

  await pool.query('ALTER TABLE users ALTER COLUMN id TYPE BIGINT');
  await pool.query('ALTER TABLE links ALTER COLUMN id TYPE BIGINT USING id::bigint');
  await pool.query('ALTER TABLE links ALTER COLUMN user_id TYPE BIGINT USING user_id::bigint');
  await pool.query('ALTER TABLE links ADD COLUMN IF NOT EXISTS short_code TEXT');
  await pool.query('ALTER TABLE links ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE');
  await pool.query('ALTER TABLE links ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW()');
  await pool.query('ALTER TABLE links ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW()');
  await pool.query('ALTER TABLE link_clicks ALTER COLUMN link_id TYPE BIGINT USING link_id::bigint');

  await pool.query('UPDATE links SET short_code = id::text WHERE short_code IS NULL');
  await pool.query('ALTER TABLE links ALTER COLUMN short_code SET NOT NULL');

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'links_short_code_key'
      ) THEN
        ALTER TABLE links ADD CONSTRAINT links_short_code_key UNIQUE (short_code);
      END IF;
    END $$;
  `);

  await pool.query(`
    ALTER TABLE links
    ADD CONSTRAINT links_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  `).catch((error) => {
    if (error.code !== '42710') {
      throw error;
    }
  });

  await pool.query(`
    ALTER TABLE link_clicks
    ADD CONSTRAINT link_clicks_link_id_fkey
    FOREIGN KEY (link_id) REFERENCES links(id) ON DELETE CASCADE
  `).catch((error) => {
    if (error.code !== '42710') {
      throw error;
    }
  });
}

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS links (
      id BIGINT PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      short_code TEXT NOT NULL UNIQUE,
      original_url TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await ensureLinksSchema();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS link_clicks (
      id BIGSERIAL PRIMARY KEY,
      link_id BIGINT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
      clicked_at TIMESTAMP NOT NULL DEFAULT NOW(),
      user_agent TEXT,
      referrer TEXT
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_links_user_created_at
    ON links (user_id, created_at DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_link_clicks_link_clicked_at
    ON link_clicks (link_id, clicked_at DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_link_clicks_referrer
    ON link_clicks (link_id, referrer)
  `);
}

module.exports = { pool, initializeDatabase };
