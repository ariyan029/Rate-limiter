/**
 * Express Server Application
 * 
 * Configures routes, middleware, Redis connection lifecycle,
 * and graceful process termination.
 */

require('dotenv').config();
const express = require('express');
const redisClient = require('./redisClient');
const rateLimiter = require('./middleware/rateLimiter');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust reverse proxies to resolve true client IP from X-Forwarded-For headers
app.set('trust proxy', true);

// Standard JSON request body parser
app.use(express.json());

/**
 * Health check endpoint (Unprotected)
 * Allows load balancers and orchestrators to verify service and Redis health.
 */
app.get('/health', async (req, res) => {
  let redisPing = false;
  try {
    if (redisClient.isOpen) {
      const pingResponse = await redisClient.ping();
      redisPing = pingResponse === 'PONG';
    }
  } catch (err) {
    redisPing = false;
  }

  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    redis: {
      connected: redisClient.isOpen,
      ping: redisPing ? 'PONG' : 'UNREACHABLE'
    },
    rateLimiter: {
      maxRequests: Number(process.env.RATE_LIMIT_MAX_REQUESTS || 5),
      windowSeconds: Number(process.env.RATE_LIMIT_WINDOW_SECONDS || 60)
    }
  });
});

/**
 * Public route (Unprotected)
 * Accessible without rate limits for comparison.
 */
app.get('/api/public', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'This is an unrestricted public endpoint.'
  });
});

/**
 * Protected data endpoint
 * Rate-limited to MAX_REQUESTS per WINDOW_SECONDS per client IP.
 */
app.get('/api/data', rateLimiter, (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Request allowed through rate limiter.',
    clientIp: req.ip || req.socket.remoteAddress,
    rateLimit: req.rateLimit
  });
});

// 404 Route Not Found handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Cannot ${req.method} ${req.path}`
  });
});

// Centralized error handling middleware
app.use((err, req, res, next) => {
  console.error('[Internal Server Error]', err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: err.message || 'An unexpected error occurred.'
  });
});

let serverInstance = null;

/**
 * Starts the HTTP server and establishes Redis connection
 */
async function startServer(port = PORT) {
  try {
    if (!redisClient.isOpen) {
      console.log('[Server] Connecting to Redis...');
      await redisClient.connect();
    }
    return new Promise((resolve) => {
      serverInstance = app.listen(port, () => {
        console.log(`[Server] Running on http://localhost:${port}`);
        console.log(`[Server] Protected route available at http://localhost:${port}/api/data`);
        resolve(serverInstance);
      });
    });
  } catch (err) {
    console.error('[Server] Startup error:', err.message || err);
    throw err;
  }
}

/**
 * Graceful shutdown handler
 */
async function gracefulShutdown(signal) {
  console.log(`\n[Server] Received ${signal}. Initiating graceful shutdown...`);
  if (serverInstance) {
    await new Promise((resolve) => serverInstance.close(resolve));
    console.log('[Server] HTTP listener closed.');
  }
  if (redisClient.isOpen) {
    await redisClient.quit();
    console.log('[Server] Redis client closed.');
  }
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Only start listening when executed directly, not when imported in test suites
if (require.main === module) {
  startServer().catch(() => process.exit(1));
}

module.exports = app;
module.exports.startServer = startServer;
