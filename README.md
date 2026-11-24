# Unstructured Database Rate Limiter (UDB)

A production-grade, modular Node.js & Express backend implementing a **Fixed Window Counter Rate Limiter** backed by a **Redis 7** in-memory NoSQL Key-Value database.

This project fulfills the practical implementation requirements for the **Unstructured Database Continuous Assessment (CSE13202)**.

---

## Table of Contents

- [Project Overview](#project-overview)
- [Problem Statement](#problem-statement)
- [Technology Stack](#technology-stack)
- [System Architecture](#system-architecture)
- [Algorithm: Fixed Window Counter](#algorithm-fixed-window-counter)
- [Redis NoSQL Data Model](#redis-nosql-data-model)
  - [Why Redis Key-Value Model Fits](#why-redis-key-value-model-fits)
  - [Key-Value Schema & Concrete Examples](#key-value-schema--concrete-examples)
  - [Race Condition Prevention & Lua Script Atomicity](#race-condition-prevention--lua-script-atomicity)
- [Project Structure](#project-structure)
- [Prerequisites](#prerequisites)
- [Installation & Setup](#installation--setup)
- [Running the Application](#running-the-application)
  - [Step 1: Start Redis using Docker](#step-1-start-redis-using-docker)
  - [Step 2: Start Express Server](#step-2-start-express-server)
  - [Step 3: Stopping Redis](#step-3-stopping-redis)
- [API Endpoints](#api-endpoints)
- [Testing & Validation](#testing--validation)
  - [Automated Test Suite](#automated-test-suite)
  - [Manual PowerShell Test Script (Windows 11)](#manual-powershell-test-script-windows-11)
  - [Manual Bash Test Script (Linux / macOS / Git Bash)](#manual-bash-test-script-linux--macos--git-bash)
- [Example Responses](#example-responses)
  - [1. Successful Request (HTTP 200 OK)](#1-successful-request-http-200-ok)
  - [2. Rate Limit Exceeded (HTTP 429 Too Many Requests)](#2-rate-limit-exceeded-http-429-too-many-requests)
  - [3. Service Health Check (HTTP 200 OK)](#3-service-health-check-http-200-ok)
- [Fault Tolerance Strategies (Fail-Open vs Fail-Closed)](#fault-tolerance-strategies-fail-open-vs-fail-closed)
- [Known Limitations](#known-limitations)
- [Git & GitHub Submission Instructions](#git--github-submission-instructions)

---

## Project Overview

In distributed computing and web backend architectures, APIs are susceptible to overwhelming traffic spikes, accidental infinite loops in client applications, and malicious Denial-of-Service (DoS) attacks. A **rate limiter** functions as an intelligent barrier in front of core application logic, regulating the rate of incoming requests per client.

This repository implements a high-performance rate limiter middleware built on top of Express.js and backed by Redis 7, strictly conforming to the parameters:
- **Maximum Requests Allowed**: 5 requests
- **Time Window Duration**: 60 seconds (1 minute fixed window)
- **Client Identification**: Normalized client IP address (supporting reverse proxy headers)
- **Allowed Response**: HTTP 200 OK with remaining quota headers
- **Blocked Response**: HTTP 429 Too Many Requests with retry-after header
- **Database Engine**: Redis 7 NoSQL Key-Value Store

---

## Problem Statement

A web service provides computational or data-intensive API endpoints. Without traffic regulation:
1. Malicious clients or runaway automated scripts can exhaust CPU, memory, and database connections, starving legitimate users.
2. High-concurrency environments experience **race conditions** if rate checks are implemented using naive `GET` then `SET` operations.
3. Disk-bound relational databases introduce 10–25ms of latency per request, making them unsuitable for per-request rate limiting.

**Objective**: Implement a distributed-ready, atomic, sub-millisecond rate limiter using an unstructured database (Redis) and the Fixed Window Counter algorithm to ensure fairness, system stability, and predictable performance.

---

## Technology Stack

- **Runtime**: [Node.js](https://nodejs.org/) (v18+)
- **Web Framework**: [Express.js](https://expressjs.com/) (v4.21+)
- **Database**: [Redis 7](https://redis.io/) (NoSQL In-Memory Key-Value Data Store)
- **Redis Driver**: Official [`redis`](https://www.npmjs.com/package/redis) client (v4.7+)
- **Containerization**: [Docker](https://www.docker.com/) & [Docker Compose](https://docs.docker.com/compose/)
- **Configuration**: [`dotenv`](https://www.npmjs.com/package/dotenv)
- **Test Runner**: Node.js Native Test Runner (`node:test` & `node:assert`)

---

## System Architecture

The following diagram illustrates how incoming client requests flow through the Express HTTP pipeline, interact with the Redis rate limiting middleware, and either reach the protected route or get rejected:

```
[Client / Browser / curl / PowerShell]
                 |
                 | HTTP GET /api/data
                 v
       +--------------------+
       |  Express.js Server |
       +--------------------+
                 |
                 v
   +----------------------------+
   | Rate Limiter Middleware    |
   | - Extract Client IP        |
   | - Compute Window ID        |
   | - Construct Redis Key      |
   +----------------------------+
                 |
                 | Atomic EVAL (Lua Script)
                 v
       +--------------------+
       |   Redis 7 Engine   |
       | - INCR key         |
       | - Check TTL        |
       | - EXPIRE if new    |
       | - Return count+TTL |
       +--------------------+
                 |
                 v
        [Is count <= 5?]
              /     \
             /       \
      YES   /         \   NO
           v           v
  +----------------+  +-------------------------------+
  | HTTP 200 OK    |  | HTTP 429 Too Many Requests    |
  | X-RateLimit-   |  | X-RateLimit-Remaining: 0      |
  | Remaining: 4..0|  | Retry-After: <seconds>        |
  | Execute Route  |  | Drop Request Immediately      |
  +----------------+  +-------------------------------+
```

---

## Algorithm: Fixed Window Counter

The **Fixed Window Counter** algorithm partitions time into static, discrete windows of uniform size (e.g., 60 seconds).

1. **Epoch Window Calculation**:
   The current window coordinate is deterministically derived from the Unix timestamp:
   $$\text{windowId} = \left\lfloor \frac{\text{currentTimeInSeconds}}{\text{windowSizeInSeconds}} \right\rfloor$$
   For a 60-second window, any timestamp between `T` and `T + 59` yields the identical `windowId`.

2. **Key Synthesis**:
   $$\text{Key} = \text{ratelimit}:\langle \text{clientIp} \rangle:\langle \text{windowId} \rangle$$

3. **Atomic Evaluation**:
   - The counter is incremented in Redis.
   - If this is the initial request within the window, a Time-To-Live (TTL) of 60 seconds is assigned to the key.
   - If the counter is $\le 5$, the request proceeds (`next()`).
   - If the counter is $> 5$, HTTP 429 is returned with the remaining seconds in the window.

---

## Redis NoSQL Data Model

### Why Redis Key-Value Model Fits

Rate-limiting state is **ephemeral**, **scalar**, and **latency-critical**:

1. **In-Memory Speed ($<1\text{ms}$)**: The rate limiter runs on **every single request**. Querying disk-based SQL databases adds 10–25ms per request. Redis operates entirely in RAM, completing counter increments in sub-millisecond time.
2. **Key-Value Simplicity**: The data consists strictly of mapping an identity string to an integer count. Relational tables, columns, foreign keys, and indexes introduce unnecessary memory and execution overhead.
3. **Automated Volatile Expiration (TTL)**: Redis natively deletes expired keys without requiring background cron jobs or manual `DELETE` statements.
4. **Centralized Distributed State**: If multiple Node.js server instances run behind a load balancer, Redis provides a single, synchronized source of truth.

### Key-Value Schema & Concrete Examples

| Attribute | Specification |
|---|---|
| **Key Pattern** | `ratelimit:<clientIp>:<windowId>` |
| **Data Type** | Redis String (Integer storage) |
| **Value** | Number of requests received in this window (`1`, `2`, `3`, ...) |
| **TTL** | Remaining seconds in the 60-second window |

#### Concrete Redis Inspection:
```redis
# Inspect the key
127.0.0.1:6379> KEYS ratelimit:*
1) "ratelimit:127.0.0.1:29482910"

# Inspect the counter value
127.0.0.1:6379> GET ratelimit:127.0.0.1:29482910
"3"

# Inspect the remaining Time-To-Live
127.0.0.1:6379> TTL ratelimit:127.0.0.1:29482910
(integer) 42
```

### Race Condition Prevention & Lua Script Atomicity

> [!IMPORTANT]
> A common flaw in rate limiters is the **Lost Update** race condition: if two simultaneous requests execute a non-atomic `GET` then `SET`, both read the same count and both allow the request, exceeding the limit. Furthermore, blindly running `EXPIRE` on every request resets the countdown timer on every hit.

To eliminate race conditions, this project executes an **atomic Redis Lua script**:

```lua
local current = redis.call('INCR', KEYS[1])
local ttl = redis.call('TTL', KEYS[1])
if ttl == -1 then
    redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
    ttl = tonumber(ARGV[1])
end
return { current, ttl }
```

**Why this is guaranteed atomic:**
- Redis executes Lua scripts on a single-threaded event loop; no other Redis command can interleave.
- If `ttl == -1` (key was just created by `INCR`), expiration is set.
- If `ttl > 0`, the existing timer is left untouched. Subsequent requests **never** reset or extend the window.
- The script returns both the new counter and the exact TTL from Redis in a single network round-trip.

---

## Project Structure

```
D:\Rate-limiter\
├── src/
│   ├── middleware/
│   │   └── rateLimiter.js     # Fixed Window Counter middleware with atomic Lua script
│   ├── redisClient.js         # Redis 7 client configuration, reconnection & graceful quit
│   └── server.js              # Express app, /health, /api/data routes & lifecycle hooks
├── tests/
│   └── rateLimiter.test.js    # Comprehensive automated test suite (node:test)
├── docker-compose.yml         # Redis 7 Alpine container definition
├── package.json               # Node.js dependencies and scripts
├── .env.example               # Environment variables template
├── .env                       # Local active environment configuration
├── .gitignore                 # Excludes node_modules, .env, dumps, logs
├── test_rate_limit.ps1        # Windows 11 PowerShell test script
├── test_rate_limit.sh         # Linux / macOS / Git Bash test script
├── Q1_STUDY_GUIDE.md          # Theoretical study guide for written submission
└── README.md                  # Complete architectural & technical documentation
```

---

## Prerequisites

Before running the project on Windows 11:
- **Node.js**: v18.0.0 or later (Verify: `node -v`)
- **Docker Desktop**: With WSL2 backend (Verify: `docker -v`)

---

## Installation & Setup

1. Open PowerShell and navigate to the project directory:
   ```powershell
   cd D:\Rate-limiter
   ```

2. Review environment configuration:
   The `.env` file is pre-configured with default settings:
   ```ini
   PORT=3000
   REDIS_URL=redis://localhost:6379
   RATE_LIMIT_WINDOW_SECONDS=60
   RATE_LIMIT_MAX_REQUESTS=5
   RATE_LIMIT_FAIL_OPEN=false
   ```

---

## Running the Application

### Step 1: Start Redis using Docker

Ensure Docker Desktop is open and running on your system, then start the Redis 7 container:

```powershell
docker compose up -d
```

Verify that the Redis container is running healthy:
```powershell
docker compose ps
docker exec -it rate-limiter-redis redis-cli ping
# Expected output: PONG
```

### Step 2: Start Express Server

Start the backend server:
```powershell
npm start
```

Expected terminal output:
```
[Redis Client] Initiated connection to Redis server
[Redis Client] Connection established and ready to accept commands
[Server] Running on http://localhost:3000
[Server] Protected route available at http://localhost:3000/api/data
```

### Step 3: Stopping Redis

When finished with development or testing, stop the Redis container:
```powershell
docker compose down
```
To also purge stored Redis volume data:
```powershell
docker compose down -v
```

---

## API Endpoints

| Method | Endpoint | Rate-Limited? | Description |
|---|---|---|---|
| `GET` | `/health` | **No** | Server health check and Redis ping status |
| `GET` | `/api/public` | **No** | Unrestricted sample public endpoint |
| `GET` | `/api/data` | **Yes** (5 req / 60s per IP) | Rate-limited protected endpoint |

---

## Testing & Validation

### Automated Test Suite

The project includes an automated test suite verifying all 8 assessment requirements plus end-to-end integration tests using Node's built-in test runner:

```powershell
npm test
```

#### Test Cases Verified:
- **Test 1**: First request is allowed with HTTP 200 and remaining = 4.
- **Test 2**: Requests 2 through 5 are allowed and decrement remaining to 0.
- **Test 3**: Request 6 is blocked with HTTP 429 Too Many Requests and Retry-After header.
- **Test 4**: Subsequent requests (7, 8) remain blocked in the same window.
- **Test 5**: Requests become allowed again after window expires.
- **Test 6**: Different IP addresses maintain independent counters.
- **Test 7**: Handles Redis unavailability gracefully (Fail-closed 503 vs Fail-open degraded 200).
- **Test 8**: Concurrent parallel requests execute atomically without race conditions.
- **Test 9**: End-to-end Express HTTP pipeline test.
- **Test 10**: Unprotected routes are not throttled.

### Manual PowerShell Test Script (Windows 11)

While the server is running (`npm start`), open a new PowerShell terminal and run:

```powershell
powershell -ExecutionPolicy Bypass -File .\test_rate_limit.ps1
```

Or execute the rapid test one-liner:
```powershell
1..7 | ForEach-Object {
    try {
        $res = Invoke-WebRequest -Uri "http://localhost:3000/api/data" -Method Get
        Write-Host "Request #$_ Status: $($res.StatusCode) Remaining: $($res.Headers['X-RateLimit-Remaining'])" -ForegroundColor Green
    } catch {
        Write-Host "Request #$_ Status: $($_.Exception.Response.StatusCode.value__) (Blocked) Retry-After: $($_.Exception.Response.Headers['Retry-After'])s" -ForegroundColor Red
    }
}
```

### Manual Bash Test Script (Linux / macOS / Git Bash)

```bash
chmod +x test_rate_limit.sh
./test_rate_limit.sh
```

---

## Example Responses

### 1. Successful Request (HTTP 200 OK)

**Request**:
```http
GET /api/data HTTP/1.1
Host: localhost:3000
```

**Response Headers**:
```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
X-RateLimit-Limit: 5
X-RateLimit-Remaining: 4
X-RateLimit-Reset: 1732442460
```

**Response Body**:
```json
{
  "success": true,
  "message": "Request allowed through rate limiter.",
  "clientIp": "127.0.0.1",
  "rateLimit": {
    "limit": 5,
    "count": 1,
    "remaining": 4,
    "resetEpoch": 1732442460,
    "retryAfterSeconds": 48
  }
}
```

---

### 2. Rate Limit Exceeded (HTTP 429 Too Many Requests)

**Request** (6th attempt within the 60-second window):
```http
GET /api/data HTTP/1.1
Host: localhost:3000
```

**Response Headers**:
```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/json; charset=utf-8
X-RateLimit-Limit: 5
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1732442460
Retry-After: 48
```

**Response Body**:
```json
{
  "error": "Too Many Requests",
  "message": "Rate limit of 5 requests per 60s exceeded. Please try again later.",
  "limit": 5,
  "remaining": 0,
  "retryAfterSeconds": 48,
  "resetTime": "2026-11-24T10:01:00.000Z"
}
```

---

### 3. Service Health Check (HTTP 200 OK)

**Request**:
```http
GET /health HTTP/1.1
Host: localhost:3000
```

**Response Body**:
```json
{
  "status": "healthy",
  "timestamp": "2026-11-24T10:00:15.123Z",
  "redis": {
    "connected": true,
    "ping": "PONG"
  },
  "rateLimiter": {
    "maxRequests": 5,
    "windowSeconds": 60
  }
}
```

---

## Fault Tolerance Strategies (Fail-Open vs Fail-Closed)

In production, network partitions or database outages can temporarily disconnect the application from Redis. The middleware supports configurable resilience:

1. **Fail-Closed (`RATE_LIMIT_FAIL_OPEN=false`, Default)**:
   - Returns **HTTP 503 Service Unavailable**.
   - Prioritizes security and downstream system protection over availability. Recommended for paid or resource-intensive APIs.
2. **Fail-Open (`RATE_LIMIT_FAIL_OPEN=true`)**:
   - Allows the request through to the route handler and injects an `X-RateLimit-Degraded: true` header.
   - Prioritizes user availability over strict enforcement.

---

## Known Limitations

- **Boundary Burst Edge Case**: Fixed Window counters do not smooth traffic across window transitions. A client can execute 5 requests at second 59 and 5 requests at second 01, yielding 10 requests within a 2-second burst without exceeding either window's limit.
- **IP Spoofing / Shared NAT**: When multiple clients share a single corporate NAT or mobile gateway public IP, they share the same rate-limit quota. In advanced production systems, combining IP with authenticated JWT User IDs or API keys addresses this limitation.

---

## Git & GitHub Submission Instructions

### 1. Initialize Git Repository
```powershell
cd D:\Rate-limiter
git init
```

### 2. Verify `.gitignore`
Ensure `node_modules` and `.env` are excluded:
```powershell
git status
```

### 3. Stage and Commit
```powershell
git add .
git commit -m "feat: complete unstructured database rate limiter with Redis 7 and Express"
```

### 4. Push to GitHub (When Ready)
Create an empty repository on your GitHub account and run:
```powershell
git remote add origin https://github.com/<YOUR_USERNAME>/<YOUR_REPOSITORY_NAME>.git
git branch -M main
git push -u origin main
```

*(Note: Paste this GitHub URL at the end of your Q1 PDF submission under `"Github link"`).*
