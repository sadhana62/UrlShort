const { getRedisClient, isRedisReady } = require('../services/redisClient');

const WINDOW_MS = Number(process.env.SHORTEN_RATE_LIMIT_WINDOW_MS || 60000);
const MAX_REQUESTS = Number(process.env.SHORTEN_RATE_LIMIT_MAX || 10);

function resolveClientKey(req) {
  return req.user?.userId || req.ip || 'anonymous';
}

async function rateLimitShorten(req, res, next) {
  if (!isRedisReady()) {
    return next();
  }

  const redis = getRedisClient();
  const now = Date.now();
  const windowStart = now - WINDOW_MS;
  const key = `rate-limit:shorten:${resolveClientKey(req)}`;

  try {
    const pipeline = redis.multi();
    pipeline.zRemRangeByScore(key, 0, windowStart);
    pipeline.zCard(key);
    pipeline.zAdd(key, { score: now, value: `${now}-${Math.random().toString(36).slice(2)}` });
    pipeline.expire(key, Math.ceil(WINDOW_MS / 1000));

    const [, currentCount] = await pipeline.exec();
    const requestCount = Number(currentCount);

    if (requestCount >= MAX_REQUESTS) {
      return res.status(429).json({
        error: 'Rate limit exceeded for link creation',
        retry_after_ms: WINDOW_MS,
      });
    }

    return next();
  } catch (error) {
    console.error('Rate limiter failed open:', error.message);
    return next();
  }
}

module.exports = {
  rateLimitShorten,
};
