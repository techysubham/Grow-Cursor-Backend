import Redis from 'ioredis';

let client = null;

if (process.env.REDIS_URL) {
  client = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    connectTimeout: 5000,
    lazyConnect: true,
    enableOfflineQueue: false,
  });

  client.on('connect', () => console.log('[Redis] Connected'));
  client.on('error', (err) => console.warn('[Redis] Connection error:', err.message));
}

/**
 * Get a cached value by key. Returns parsed JSON or null on miss/error.
 */
export async function getCache(key) {
  if (!client) return null;
  try {
    const val = await client.get(key);
    return val ? JSON.parse(val) : null;
  } catch {
    return null;
  }
}

/**
 * Store a value in cache with a TTL in seconds (default 5 minutes).
 */
export async function setCache(key, value, ttlSeconds = 300) {
  if (!client) return;
  try {
    await client.setex(key, ttlSeconds, JSON.stringify(value));
  } catch {
    // Cache failures must never crash the app
  }
}

/**
 * Delete one or more cache keys.
 */
export async function delCache(...keys) {
  if (!client) return;
  try {
    if (keys.length > 0) await client.del(...keys);
  } catch {
    // swallow
  }
}

export default client;
