const express = require('express');
const { pool } = require('../db');
const { getCachedLink, setCachedLink } = require('../services/linkCache');
const { enqueueClick } = require('../services/analyticsQueue');

const router = express.Router();

router.get('/:short_code', async (req, res) => {
  try {
    const shortCode = req.params.short_code;
    let link = await getCachedLink(shortCode);

    if (!link) {
      const result = await pool.query(
        `SELECT id, short_code, original_url, is_active
         FROM links
         WHERE short_code = $1`,
        [shortCode]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Short link not found' });
      }

      link = result.rows[0];
      await setCachedLink(shortCode, link);
    }

    if (!link.is_active) {
      return res.status(410).json({ error: 'Short link is disabled' });
    }

    enqueueClick({
      linkId: BigInt(link.id),
      userAgent: req.get('user-agent'),
      referrer: req.get('referer'),
      clickedAt: new Date(),
    });

    return res.redirect(link.original_url);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
