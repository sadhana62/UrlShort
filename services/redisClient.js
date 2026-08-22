const { createClient } = require('redis');

let redisClient = null;
let redisReady = false;
let connectAttempted = false;

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

  redisClient = createClient({ url: redisUrl });

  redisClient.on('error', (error) => {
    redisReady = false;
    console.error('Redis error:', error.message);
  });

  redisClient.on('ready', () => {
    redisReady = true;
    console.log('Redis connection established');
  });

  redisClient.on('end', () => {
    redisReady = false;
    console.warn('Redis connection closed');
  });

  try {
    await redisClient.connect();
  } catch (error) {
    redisReady = false;
    console.error('Redis connection failed:', error.message);
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
