const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

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
