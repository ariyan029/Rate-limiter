/**
 * Redis Client Connection Module
 * 
 * Configures and manages the connection to the Redis 7 in-memory key-value store.
 * Includes connection lifecycle listeners, reconnect strategy, and graceful termination.
 */

const { createClient } = require('redis');
require('dotenv').config();

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const client = createClient({
  url: REDIS_URL,
  socket: {
    reconnectStrategy: (retries) => {
      // Reconnect with exponential backoff capped at 3 seconds
      if (retries > 10) {
        console.error('[Redis Client] Max reconnection attempts reached.');
        return new Error('Max reconnection attempts reached');
      }
      return Math.min(retries * 100, 3000);
    }
  }
});

// Event listeners for monitoring Redis connection state
client.on('error', (err) => {
  console.error('[Redis Client Error]', err.message || err);
});

client.on('connect', () => {
  console.log('[Redis Client] Initiated connection to Redis server');
});

client.on('ready', () => {
  console.log('[Redis Client] Connection established and ready to accept commands');
});

client.on('reconnecting', () => {
  console.warn('[Redis Client] Reconnecting to Redis...');
});

client.on('end', () => {
  console.log('[Redis Client] Redis connection closed');
});

/**
 * Connect to Redis if not already connected
 */
async function connectRedis() {
  if (!client.isOpen) {
    await client.connect();
  }
  return client;
}

/**
 * Gracefully disconnect from Redis
 */
async function closeRedis() {
  if (client.isOpen) {
    await client.quit();
  }
}

module.exports = client;
module.exports.connectRedis = connectRedis;
module.exports.closeRedis = closeRedis;
