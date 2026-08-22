const { pool } = require('../db');

const FLUSH_INTERVAL_MS = Number(process.env.ANALYTICS_FLUSH_INTERVAL_MS || 1000);
const BATCH_SIZE = Number(process.env.ANALYTICS_BATCH_SIZE || 100);

const queue = [];
let flushTimer = null;
let flushInProgress = false;

function enqueueClick(event) {
  queue.push({
    linkId: event.linkId,
    userAgent: event.userAgent || null,
    referrer: event.referrer || null,
    clickedAt: event.clickedAt || new Date(),
  });

  if (queue.length >= BATCH_SIZE) {
    void flushQueue();
  }
}

async function flushQueue() {
  if (flushInProgress || queue.length === 0) {
    return;
  }

  flushInProgress = true;
  const batch = queue.splice(0, BATCH_SIZE);

  try {
    const values = [];
    const placeholders = batch.map((item, index) => {
      const offset = index * 4;
      values.push(item.linkId.toString(), item.userAgent, item.referrer, item.clickedAt);
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`;
    });

    await pool.query(
      `INSERT INTO link_clicks (link_id, user_agent, referrer, clicked_at)
       VALUES ${placeholders.join(', ')}`,
      values
    );
  } catch (error) {
    console.error('Analytics flush failed:', error.message);
    queue.unshift(...batch);
  } finally {
    flushInProgress = false;
  }
}

function startAnalyticsWorker() {
  if (flushTimer) {
    return;
  }

  flushTimer = setInterval(() => {
    void flushQueue();
  }, FLUSH_INTERVAL_MS);
}

async function stopAnalyticsWorker() {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }

  await flushQueue();
}

function getAnalyticsQueueStats() {
  return {
    queuedEvents: queue.length,
    flushInProgress,
    batchSize: BATCH_SIZE,
    flushIntervalMs: FLUSH_INTERVAL_MS,
  };
}

module.exports = {
  enqueueClick,
  flushQueue,
  getAnalyticsQueueStats,
  startAnalyticsWorker,
  stopAnalyticsWorker,
};
