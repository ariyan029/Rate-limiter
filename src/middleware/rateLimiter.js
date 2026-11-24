/**
 * Fixed Window Counter Rate Limiter Middleware
 * 
 * Implements the Fixed Window Counter algorithm backed by Redis.
 * Uses an atomic Redis Lua script to guarantee that counter increments
 * and TTL expirations are executed atomically, completely eliminating race conditions.
 */

const defaultRedisClient = require('../redisClient');

// Lua script to atomically increment the counter and set expiration ONLY on key creation.
// This prevents race conditions and ensures subsequent requests do not reset or extend TTL.
const FIXED_WINDOW_LUA_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
local ttl = redis.call('TTL', KEYS[1])
if ttl == -1 then
    redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
    ttl = tonumber(ARGV[1])
end
return { current, ttl }
`;

/**
 * Extracts and normalizes the client IP address from the request.
 * Handles reverse proxies, IPv6 loopback, and standard socket addresses.
 * 
 * @param {import('express').Request} req 
 * @returns {string} normalized IP
 */
function getClientIp(req) {
  let ip = req.ip ||
           (req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : null) ||
           req.socket?.remoteAddress ||
           '127.0.0.1';

  // Normalize IPv6 loopback and IPv4-mapped IPv6 addresses
  if (ip === '::1' || ip === '::ffff:127.0.0.1') {
    ip = '127.0.0.1';
  } else if (ip.startsWith('::ffff:')) {
    ip = ip.substring(7);
  }
  return ip;
}

/**
 * Factory function to create configurable rate limiting middleware.
 * 
 * @param {Object} [options]
 * @param {number} [options.maxRequests] Maximum allowed requests per window (default: 5)
 * @param {number} [options.windowSizeInSeconds] Time window duration in seconds (default: 60)
 * @param {string} [options.keyPrefix] Redis key namespace prefix (default: 'ratelimit')
 * @param {boolean} [options.failOpen] Whether to allow traffic when Redis is unavailable (default: false)
 * @param {Object} [options.redis] Optional custom or mocked Redis client for testing
 * @returns {import('express').RequestHandler} Express middleware
 */
function createRateLimiter(options = {}) {
  const maxRequests = Number(options.maxRequests ?? process.env.RATE_LIMIT_MAX_REQUESTS ?? 5);
  const windowSizeInSeconds = Number(options.windowSizeInSeconds ?? process.env.RATE_LIMIT_WINDOW_SECONDS ?? 60);
  const keyPrefix = options.keyPrefix || 'ratelimit';
  const failOpen = options.failOpen !== undefined 
    ? options.failOpen 
    : (process.env.RATE_LIMIT_FAIL_OPEN === 'true');
  const client = options.redis || defaultRedisClient;

  return async function rateLimiter(req, res, next) {
    try {
      // Ensure Redis client is connected
      if (!client.isOpen && typeof client.connect === 'function') {
        await client.connect();
      }

      const clientIp = getClientIp(req);
      const nowInSeconds = Math.floor(Date.now() / 1000);
      const windowId = Math.floor(nowInSeconds / windowSizeInSeconds);
      const redisKey = `${keyPrefix}:${clientIp}:${windowId}`;

      let count;
      let ttl;

      // Execute atomic Lua script
      if (typeof client.eval === 'function') {
        const result = await client.eval(FIXED_WINDOW_LUA_SCRIPT, {
          keys: [redisKey],
          arguments: [String(windowSizeInSeconds)]
        });
        count = Number(result[0]);
        ttl = Number(result[1]);
      } else if (typeof client.multi === 'function') {
        // Fallback pipeline if eval is unavailable
        const multi = client.multi();
        multi.incr(redisKey);
        multi.expire(redisKey, windowSizeInSeconds, 'NX');
        multi.ttl(redisKey);
        const results = await multi.exec();
        count = Number(results[0]);
        ttl = Number(results[2] ?? windowSizeInSeconds);
      } else {
        throw new Error('Redis client does not support atomic operations (eval or multi)');
      }

      // Calculate reset time and remaining requests
      const resetEpoch = (windowId + 1) * windowSizeInSeconds;
      const remainingSeconds = ttl > 0 ? ttl : Math.max(1, resetEpoch - nowInSeconds);
      const remainingRequests = Math.max(0, maxRequests - count);

      // Attach standard rate limit headers to all responses
      res.setHeader('X-RateLimit-Limit', maxRequests);
      res.setHeader('X-RateLimit-Remaining', remainingRequests);
      res.setHeader('X-RateLimit-Reset', resetEpoch);

      // Context object for downstream middleware and route handlers
      req.rateLimit = {
        limit: maxRequests,
        count: count,
        remaining: remainingRequests,
        resetEpoch: resetEpoch,
        retryAfterSeconds: remainingSeconds
      };

      // Check if limit exceeded
      if (count <= maxRequests) {
        return next();
      }

      // Rate limit exceeded: return HTTP 429 Too Many Requests
      res.setHeader('Retry-After', remainingSeconds);
      return res.status(429).json({
        error: 'Too Many Requests',
        message: `Rate limit of ${maxRequests} requests per ${windowSizeInSeconds}s exceeded. Please try again later.`,
        limit: maxRequests,
        remaining: 0,
        retryAfterSeconds: remainingSeconds,
        resetTime: new Date(resetEpoch * 1000).toISOString()
      });

    } catch (error) {
      console.error('[Rate Limiter Middleware Error]', error.message || error);

      if (failOpen) {
        console.warn('[Rate Limiter] Fail-open active: allowing request despite Redis outage.');
        res.setHeader('X-RateLimit-Degraded', 'true');
        return next();
      }

      return res.status(503).json({
        error: 'Service Unavailable',
        message: 'Rate limiting service is temporarily unavailable. Downstream protection active.'
      });
    }
  };
}

// Default middleware instance using environment defaults
const defaultRateLimiter = createRateLimiter();

module.exports = defaultRateLimiter;
module.exports.createRateLimiter = createRateLimiter;
module.exports.getClientIp = getClientIp;
module.exports.FIXED_WINDOW_LUA_SCRIPT = FIXED_WINDOW_LUA_SCRIPT;
