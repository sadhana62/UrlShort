const { getRedisClient, isRedisReady } = require('./redisClient');

const DEFAULT_TTL_SECONDS = Number(process.env.LINK_CACHE_TTL_SECONDS || 300);

function cacheKey(shortCode) {
  return `link:${shortCode}`;
}

async function getCachedLink(shortCode) {
  if (!isRedisReady()) {
    return null;
  }

  const redis = getRedisClient();
  const value = await redis.get(cacheKey(shortCode));
  return value ? JSON.parse(value) : null;
}

async function setCachedLink(shortCode, payload, ttlSeconds = DEFAULT_TTL_SECONDS) {
  if (!isRedisReady()) {
    return false;
  }

  const redis = getRedisClient();
  await redis.set(cacheKey(shortCode), JSON.stringify(payload), { EX: ttlSeconds });
  return true;
}

async function invalidateCachedLink(shortCode) {
  if (!isRedisReady()) {
    return false;
  }

  const redis = getRedisClient();
  await redis.del(cacheKey(shortCode));
  return true;
}

module.exports = {
  getCachedLink,
  invalidateCachedLink,
  setCachedLink,
};
