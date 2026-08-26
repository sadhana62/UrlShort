const express = require('express');
const { pool } = require('../db');
const authMiddleware = require('../middleware/auth');
const { encode } = require('../utils/base62');
const { generateId } = require('../utils/snowflake');
const { isValidUrl } = require('../utils/url');
const { invalidateCachedLink } = require('../services/linkCache');
const { rateLimitShorten } = require('../middleware/rateLimit');

const router = express.Router();

router.post('/', authMiddleware, rateLimitShorten, async (req, res) => {
  const { original_url } = req.body;
  const userId = req.user.userId;

  if (!isValidUrl(original_url)) {
    return res.status(400).json({ error: 'A valid http/https URL is required' });
  }

  try {
    const existing = await pool.query(
      `SELECT id, short_code, original_url, is_active, created_at, updated_at
       FROM links
       WHERE user_id = $1 AND original_url = $2`,
      [userId, original_url]
    );

    if (existing.rows.length > 0) {
      return res.status(200).json(existing.rows[0]);
    }

    const generatedId = generateId();
    const shortCode = encode(generatedId);
    const result = await pool.query(
      `INSERT INTO links (id, user_id, short_code, original_url)
       VALUES ($1, $2, $3, $4)
       RETURNING id, short_code, original_url, is_active, created_at, updated_at`,
      [generatedId.toString(), userId, shortCode, original_url]
    );

    return res.status(201).json(result.rows[0]);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.get('/', authMiddleware, async (req, res) => {
  const userId = req.user.userId;

  try {
    const result = await pool.query(
      `SELECT id, short_code, original_url, is_active, created_at, updated_at
       FROM links
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId]
    );

    return res.json(result.rows);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.get('/:id', authMiddleware, async (req, res) => {
  const userId = req.user.userId;
  const linkId = req.params.id;

  try {
    const result = await pool.query(
      `SELECT id, short_code, original_url, is_active, created_at, updated_at
       FROM links
       WHERE id = $1 AND user_id = $2`,
      [linkId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Link not found' });
    }

    return res.json(result.rows[0]);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.put('/:id', authMiddleware, async (req, res) => {
  const userId = req.user.userId;
  const linkId = req.params.id;
  const { original_url, is_active } = req.body;

  if (original_url !== undefined && !isValidUrl(original_url)) {
    return res.status(400).json({ error: 'A valid http/https URL is required' });
  }

  try {
    const existing = await pool.query(
      `SELECT id, short_code, original_url, is_active
       FROM links
       WHERE id = $1 AND user_id = $2`,
      [linkId, userId]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Link not found' });
    }

    const current = existing.rows[0];
    const nextOriginalUrl = original_url ?? current.original_url;
    const nextIsActive = typeof is_active === 'boolean' ? is_active : current.is_active;

    const result = await pool.query(
      `UPDATE links
       SET original_url = $1, is_active = $2, updated_at = NOW()
       WHERE id = $3 AND user_id = $4
       RETURNING id, short_code, original_url, is_active, created_at, updated_at`,
      [nextOriginalUrl, nextIsActive, linkId, userId]
    );

    await invalidateCachedLink(current.short_code);

    return res.json(result.rows[0]);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', authMiddleware, async (req, res) => {
  const userId = req.user.userId;
  const linkId = req.params.id;

  try {
    const result = await pool.query(
      'DELETE FROM links WHERE id = $1 AND user_id = $2 RETURNING short_code',
      [linkId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Link not found' });
    }

    await invalidateCachedLink(result.rows[0].short_code);

    return res.status(204).send();
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.get('/:id/stats', authMiddleware, async (req, res) => {
  const userId = req.user.userId;
  const linkId = req.params.id;

  try {
    const linkResult = await pool.query(
      'SELECT id FROM links WHERE id = $1 AND user_id = $2',
      [linkId, userId]
    );

    if (linkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Link not found' });
    }

    const totalClicksResult = await pool.query(
      'SELECT COUNT(*)::int AS total_clicks FROM link_clicks WHERE link_id = $1',
      [linkId]
    );

    const clicksOverTimeResult = await pool.query(
      `SELECT DATE(clicked_at) AS date, COUNT(*)::int AS clicks
       FROM link_clicks
       WHERE link_id = $1
       GROUP BY DATE(clicked_at)
       ORDER BY DATE(clicked_at) ASC`,
      [linkId]
    );

    const topReferrersResult = await pool.query(
      `SELECT COALESCE(referrer, 'direct') AS referrer, COUNT(*)::int AS clicks
       FROM link_clicks
       WHERE link_id = $1
       GROUP BY COALESCE(referrer, 'direct')
       ORDER BY clicks DESC, referrer ASC
       LIMIT 5`,
      [linkId]
    );

    return res.json({
      total_clicks: totalClicksResult.rows[0].total_clicks,
      clicks_over_time: clicksOverTimeResult.rows.map((row) => ({
        date: row.date,
        clicks: row.clicks,
      })),
      top_referrers: topReferrersResult.rows,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

module.exports = router;
