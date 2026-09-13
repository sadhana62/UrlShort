const { createClient } = require('redis');

let redisClient = null;
let redisReady = false;
let connectAttempted = false;

function logRedisTarget(redisUrl) {
  try {
    const parsed = new URL(redisUrl);
    console.log(
      'Redis URL parsed OK ->',
      `protocol=${parsed.protocol}`,
      `host=${parsed.hostname}`,
      `port=${parsed.port}`,
      `username=${parsed.username || '(none)'}`,
      `password=${parsed.password ? '(set, ' + parsed.password.length + ' chars)' : '(none)'}`
    );
    return true;
  } catch (urlError) {
    console.error('Redis URL is INVALID and failed to parse:', urlError.message);
    console.error('Value of REDIS_URL (redacted):', redisUrl.replace(/:\/\/[^@]*@/, '://<redacted>@'));
    return false;
  }
}

async function initializeRedis() {
  if (connectAttempted) {
    return redisClient;
  }

  connectAttempted = true;

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    console.warn('REDIS_URL not configured. Redis-backed features will run in degraded mode.');
    return null;
  }

  const urlIsValid = logRedisTarget(redisUrl);
  if (!urlIsValid) {
    // Bail out here so we don't even attempt createClient() with a bad URL.
    return null;
  }

  redisClient = createClient({ url: redisUrl });

  redisClient.on('error', (error) => {
    redisReady = false;
    console.error(
      'Redis error ->',
      `name=${error.name}`,
      `code=${error.code || '(none)'}`,
      `message=${error.message}`
    );
  });

  redisClient.on('ready', () => {
    redisReady = true;
    console.log('Redis connection established');
  });

  redisClient.on('end', () => {
    redisReady = false;
    console.warn('Redis connection closed');
  });

  redisClient.on('reconnecting', () => {
    console.warn('Redis client is attempting to reconnect...');
  });

  try {
    await redisClient.connect();
  } catch (error) {
    redisReady = false;
    console.error(
      'Redis connection failed ->',
      `name=${error.name}`,
      `code=${error.code || '(none)'}`,
      `message=${error.message}`
    );
  }

  return redisClient;
}

function getRedisClient() {
  return redisClient;
}

function isRedisReady() {
  return redisReady && !!redisClient?.isOpen;
}

async function closeRedis() {
  if (redisClient?.isOpen) {
    await redisClient.quit();
  }
}

module.exports = {
  closeRedis,
  getRedisClient,
  initializeRedis,
  isRedisReady,
};