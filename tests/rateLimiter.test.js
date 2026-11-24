/**
 * Automated Test Suite for Rate Limiter
 * 
 * Uses Node.js native test runner (node:test) and assertions (node:assert/strict).
 * Tests all required assessment criteria:
 * 1. First request is allowed (HTTP 200, remaining = 4).
 * 2. Requests 2-5 are allowed (remaining decrements to 0).
 * 3. Request 6 is blocked with HTTP 429 Too Many Requests.
 * 4. Subsequent requests remain blocked during the same window.
 * 5. Requests become allowed after window expires.
 * 6. Different IP addresses maintain independent counters.
 * 7. Redis connection errors are handled gracefully (503 fail-closed / degraded fail-open).
 * 8. Race condition prevention & concurrent request handling.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createRateLimiter } = require('../src/middleware/rateLimiter');

/**
 * Creates an in-memory Mock Redis Client that faithfully implements
 * the Redis 7 atomic Lua script and transaction behavior for deterministic testing.
 */
function createMockRedisClient() {
  const store = new Map();

  return {
    isOpen: true,
    async connect() {
      this.isOpen = true;
    },
    async quit() {
      this.isOpen = false;
    },
    async ping() {
      if (!this.isOpen) throw new Error('Connection is closed');
      return 'PONG';
    },
    async eval(script, { keys, arguments: args }) {
      if (!this.isOpen) throw new Error('Redis connection lost');
      const key = keys[0];
      const windowSeconds = Number(args[0]);
      const now = Date.now();

      let item = store.get(key);
      if (item && now >= item.expiresAt) {
        store.delete(key);
        item = null;
      }

      if (!item) {
        item = {
          count: 1,
          expiresAt: now + (windowSeconds * 1000)
        };
        store.set(key, item);
      } else {
        item.count += 1;
      }

      const remainingTtl = Math.max(1, Math.ceil((item.expiresAt - now) / 1000));
      return [item.count, remainingTtl];
    },
    // Helper to simulate time travel in tests
    _advanceTime(ms) {
      for (const [key, item] of store.entries()) {
        item.expiresAt -= ms;
      }
    },
    _clear() {
      store.clear();
    }
  };
}

/**
 * Helper to dispatch simulated HTTP requests through Express middleware
 */
function mockRequest(middleware, { ip = '127.0.0.1', headers = {} } = {}) {
  return new Promise((resolve) => {
    const req = {
      ip,
      headers: { ...headers },
      socket: { remoteAddress: ip }
    };

    const res = {
      statusCode: 200,
      headers: {},
      body: null,
      setHeader(name, value) {
        this.headers[name] = value;
      },
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(data) {
        this.body = data;
        resolve({ status: this.statusCode, headers: this.headers, body: this.body });
      }
    };

    const next = (err) => {
      if (err) {
        resolve({ status: 500, error: err });
      } else {
        resolve({ status: res.statusCode, headers: res.headers, rateLimit: req.rateLimit, allowed: true });
      }
    };

    middleware(req, res, next);
  });
}

describe('Fixed Window Counter Rate Limiter Tests', () => {
  let mockRedis;
  let limiter;

  beforeEach(() => {
    mockRedis = createMockRedisClient();
    limiter = createRateLimiter({
      maxRequests: 5,
      windowSizeInSeconds: 60,
      redis: mockRedis,
      failOpen: false
    });
  });

  it('Test 1: First request is allowed with HTTP 200 and remaining = 4', async () => {
    const res = await mockRequest(limiter, { ip: '192.168.1.10' });

    assert.equal(res.allowed, true);
    assert.equal(res.status, 200);
    assert.equal(res.headers['X-RateLimit-Limit'], 5);
    assert.equal(res.headers['X-RateLimit-Remaining'], 4);
    assert.ok(res.headers['X-RateLimit-Reset'] > 0);
  });

  it('Test 2: Requests 2 through 5 are allowed and decrement remaining to 0', async () => {
    const ip = '192.168.1.11';
    for (let i = 1; i <= 5; i++) {
      const res = await mockRequest(limiter, { ip });
      assert.equal(res.allowed, true);
      assert.equal(res.status, 200);
      assert.equal(res.headers['X-RateLimit-Remaining'], 5 - i);
    }
  });

  it('Test 3: Request 6 is blocked with HTTP 429 Too Many Requests', async () => {
    const ip = '192.168.1.12';
    // Consume 5 allowed requests
    for (let i = 1; i <= 5; i++) {
      await mockRequest(limiter, { ip });
    }

    // 6th request should be blocked
    const res = await mockRequest(limiter, { ip });
    assert.equal(res.status, 429);
    assert.equal(res.body.error, 'Too Many Requests');
    assert.equal(res.headers['X-RateLimit-Remaining'], 0);
    assert.ok(Number(res.headers['Retry-After']) > 0);
    assert.ok(res.body.retryAfterSeconds > 0);
  });

  it('Test 4: Subsequent requests (7, 8, etc.) remain blocked in the same window', async () => {
    const ip = '192.168.1.13';
    for (let i = 1; i <= 5; i++) {
      await mockRequest(limiter, { ip });
    }

    const res7 = await mockRequest(limiter, { ip });
    assert.equal(res7.status, 429);

    const res8 = await mockRequest(limiter, { ip });
    assert.equal(res8.status, 429);
    assert.equal(res8.body.error, 'Too Many Requests');
  });

  it('Test 5: Requests become allowed again after window expires', async () => {
    const ip = '192.168.1.14';
    for (let i = 1; i <= 5; i++) {
      await mockRequest(limiter, { ip });
    }

    // Blocked on 6th
    const blockedRes = await mockRequest(limiter, { ip });
    assert.equal(blockedRes.status, 429);

    // Fast-forward mock clock past window (61 seconds)
    mockRedis._advanceTime(61 * 1000);

    // Should now be allowed in the new window
    const newWindowRes = await mockRequest(limiter, { ip });
    assert.equal(newWindowRes.allowed, true);
    assert.equal(newWindowRes.status, 200);
    assert.equal(newWindowRes.headers['X-RateLimit-Remaining'], 4);
  });

  it('Test 6: Different IP addresses maintain independent counters', async () => {
    const ipA = '10.0.0.1';
    const ipB = '10.0.0.2';

    // Exhaust IP A
    for (let i = 1; i <= 5; i++) {
      await mockRequest(limiter, { ip: ipA });
    }
    const resA = await mockRequest(limiter, { ip: ipA });
    assert.equal(resA.status, 429);

    // IP B must still have full quota allowed
    const resB = await mockRequest(limiter, { ip: ipB });
    assert.equal(resB.allowed, true);
    assert.equal(resB.status, 200);
    assert.equal(resB.headers['X-RateLimit-Remaining'], 4);
  });

  it('Test 7: Handles Redis unavailability (Fail-closed vs Fail-open)', async () => {
    const failingRedis = {
      isOpen: false,
      async connect() {
        throw new Error('Connection refused to redis:6379');
      }
    };

    // 1. Fail-closed (default: returns HTTP 503)
    const failClosedLimiter = createRateLimiter({
      redis: failingRedis,
      failOpen: false
    });
    const closedRes = await mockRequest(failClosedLimiter, { ip: '127.0.0.1' });
    assert.equal(closedRes.status, 503);
    assert.equal(closedRes.body.error, 'Service Unavailable');

    // 2. Fail-open (returns 200 with degraded header)
    const failOpenLimiter = createRateLimiter({
      redis: failingRedis,
      failOpen: true
    });
    const openRes = await mockRequest(failOpenLimiter, { ip: '127.0.0.1' });
    assert.equal(openRes.allowed, true);
    assert.equal(openRes.headers['X-RateLimit-Degraded'], 'true');
  });

  it('Test 8: Concurrent requests are atomic and do not cause race conditions', async () => {
    const ip = '192.168.1.99';
    // Fire 10 concurrent requests simultaneously
    const requests = Array.from({ length: 10 }, () => mockRequest(limiter, { ip }));
    const responses = await Promise.all(requests);

    const allowed = responses.filter(r => r.allowed === true);
    const blocked = responses.filter(r => r.status === 429);

    assert.equal(allowed.length, 5, 'Exactly 5 requests must be allowed');
    assert.equal(blocked.length, 5, 'Exactly 5 requests must be blocked');
  });
});

describe('Express HTTP End-to-End Integration Tests', () => {
  let app;
  let mockRedis;

  function dispatch(targetApp, { method = 'GET', url = '/api/data', ip = '127.0.0.1' } = {}) {
    return new Promise((resolve) => {
      const req = {
        method,
        url,
        ip,
        headers: { host: 'localhost' },
        socket: { remoteAddress: ip }
      };

      const res = {
        statusCode: 200,
        headers: {},
        body: null,
        setHeader(name, value) {
          this.headers[name.toLowerCase()] = String(value);
        },
        getHeader(name) {
          return this.headers[name.toLowerCase()];
        },
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(data) {
          this.body = data;
          resolve({ status: this.statusCode, headers: this.headers, body: this.body });
        },
        end(data) {
          resolve({ status: this.statusCode, headers: this.headers, body: data });
        }
      };

      targetApp.handle(req, res);
    });
  }

  beforeEach(() => {
    mockRedis = createMockRedisClient();
    app = express();
    app.set('trust proxy', true);
    app.use(express.json());

    const rateLimiter = createRateLimiter({
      maxRequests: 5,
      windowSizeInSeconds: 60,
      redis: mockRedis
    });

    app.get('/health', (req, res) => {
      res.status(200).json({ status: 'healthy', redisConnected: mockRedis.isOpen });
    });

    app.get('/api/public', (req, res) => {
      res.status(200).json({ success: true, message: 'public' });
    });

    app.get('/api/data', rateLimiter, (req, res) => {
      res.status(200).json({
        success: true,
        message: 'Request allowed through rate limiter.',
        remaining: req.rateLimit.remaining
      });
    });
  });

  it('Test 9: End-to-End HTTP requests (1-5 allowed, 6-7 rejected with 429)', async () => {
    // Requests 1 to 5: Must return HTTP 200
    for (let i = 1; i <= 5; i++) {
      const res = await dispatch(app, { url: '/api/data' });
      assert.equal(res.status, 200, `Request ${i} must return 200`);
      assert.equal(res.headers['x-ratelimit-limit'], '5');
      assert.equal(res.headers['x-ratelimit-remaining'], String(5 - i));
      assert.equal(res.body.success, true);
    }

    // Request 6: Must return HTTP 429
    const res6 = await dispatch(app, { url: '/api/data' });
    assert.equal(res6.status, 429, 'Request 6 must be blocked with 429');
    assert.equal(res6.headers['x-ratelimit-remaining'], '0');
    assert.ok(Number(res6.headers['retry-after']) > 0);
    assert.equal(res6.body.error, 'Too Many Requests');

    // Request 7: Must also return HTTP 429
    const res7 = await dispatch(app, { url: '/api/data' });
    assert.equal(res7.status, 429, 'Request 7 must remain blocked with 429');
    assert.equal(res7.body.error, 'Too Many Requests');
  });

  it('Test 10: Unprotected routes (/health, /api/public) are not rate-limited', async () => {
    const healthRes = await dispatch(app, { url: '/health' });
    assert.equal(healthRes.status, 200);
    assert.equal(healthRes.body.status, 'healthy');

    // Verify /api/public can be called 10 times without getting 429
    for (let i = 0; i < 10; i++) {
      const pubRes = await dispatch(app, { url: '/api/public' });
      assert.equal(pubRes.status, 200);
      assert.equal(pubRes.body.success, true);
    }
  });
});

