const express = require('express');
const authRoutes = require('./routes/auth');
const linkRoutes = require('./routes/links');
const redirectRoutes = require('./routes/redirect');
const { initializeDatabase, pool } = require('./db');
const { initializeRedis, isRedisReady, closeRedis } = require('./services/redisClient');
const { getAnalyticsQueueStats, startAnalyticsWorker, stopAnalyticsWorker } = require('./services/analyticsQueue');
require('dotenv').config();

const app = express();
const port = Number(process.env.PORT || 3000);

app.use(express.json());
app.use(express.static('public'));
app.use('/api/auth', authRoutes);

app.use('/api/links', linkRoutes);
app.get('/health', async (_req, res) => {
  let databaseHealthy = true;

  try {
    await pool.query('SELECT 1');
  } catch (error) {
    databaseHealthy = false;
  }

  const redisHealthy = isRedisReady();
  const analytics = getAnalyticsQueueStats();
  const statusCode = databaseHealthy ? 200 : 503;

  return res.status(statusCode).json({
    status: databaseHealthy ? 'ok' : 'degraded',
    database: databaseHealthy ? 'up' : 'down',
    redis: redisHealthy ? 'up' : 'degraded',
    analytics,
  });
});
app.use('/', redirectRoutes);

initializeDatabase()
  .then(async () => {
    await initializeRedis();
    startAnalyticsWorker();
    app.listen(port, () => console.log(`Server running on port ${port}`));
  })
  .catch((err) => {
     console.error('Database initialization failed:',  err.stack || err);
    process.exit(1);
  });

async function shutdown() {
  await stopAnalyticsWorker();
  await closeRedis();
  await pool.end();
  process.exit(0);
}

process.on('SIGINT', () => {
  void shutdown();
});

process.on('SIGTERM', () => {
  void shutdown();
});
