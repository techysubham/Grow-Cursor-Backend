import NodeCache from 'node-cache';

/**
 * ASIN Data Cache
 * Caches Amazon product data to avoid redundant ScraperAPI calls
 * 
 * Benefits:
 * - Instant results for repeated ASINs
 * - Reduces ScraperAPI quota usage
 * - Improves performance during testing/revisions
 */

// Cache TTL from environment (default: 1 hour = 3600 seconds)
const CACHE_TTL = parseInt(process.env.ASIN_CACHE_TTL) || 3600;
const CACHE_ENABLED = process.env.ENABLE_ASIN_CACHE !== 'false'; // Enabled by default

// Initialize cache
const asinCache = new NodeCache({
  stdTTL: CACHE_TTL,           // Standard TTL for all keys
  checkperiod: 120,             // Check for expired keys every 2 minutes
  useClones: false,             // Don't clone objects (faster for large data)
  maxKeys: 10000                // Maximum 10k ASINs in cache
});

console.log(`[ASIN Cache] 🗄️ Initialized: ${CACHE_ENABLED ? 'ENABLED' : 'DISABLED'} (TTL: ${CACHE_TTL}s, Max: 10k ASINs)`);

/**
 * Get cached ASIN data
 * @param {string} asin - Amazon ASIN
 * @returns {Object|null} - Cached data or null if not found
 */
export function getCachedAsinData(asin) {
  if (!CACHE_ENABLED) return null;
  
  const cached = asinCache.get(`asin:${asin}`);
  if (cached) {
    console.log(`[ASIN Cache] ✅ HIT: ${asin}`);
  }
  return cached || null;
}

/**
 * Store ASIN data in cache
 * @param {string} asin - Amazon ASIN
 * @param {Object} data - Product data to cache
 */
export function setCachedAsinData(asin, data) {
  if (!CACHE_ENABLED) return;
  
  const success = asinCache.set(`asin:${asin}`, data);
  if (success) {
    console.log(`[ASIN Cache] 💾 STORED: ${asin}`);
  }
}

/**
 * Invalidate cache for specific ASIN
 * @param {string} asin - Amazon ASIN
 */
export function invalidateAsinCache(asin) {
  const deleted = asinCache.del(`asin:${asin}`);
  if (deleted) {
    console.log(`[ASIN Cache] 🗑️ INVALIDATED: ${asin}`);
  }
  return deleted > 0;
}

/**
 * Clear entire cache
 */
export function clearAsinCache() {
  asinCache.flushAll();
  console.log(`[ASIN Cache] 🧹 CLEARED: All cached data removed`);
}

/**
 * Get cache statistics
 * @returns {Object} - Cache stats
 */
export function getAsinCacheStats() {
  const stats = asinCache.getStats();
  const keys = asinCache.keys();
  
  return {
    enabled: CACHE_ENABLED,
    ttl: CACHE_TTL,
    keys: keys.length,
    hits: stats.hits,
    misses: stats.misses,
    hitRate: stats.hits > 0 ? ((stats.hits / (stats.hits + stats.misses)) * 100).toFixed(2) : 0,
    ksize: stats.ksize,
    vsize: stats.vsize
  };
}

/**
 * Warm cache with commonly used ASINs (optional)
 * @param {Array<{asin: string, data: Object}>} asinDataList
 */
export function warmAsinCache(asinDataList) {
  if (!CACHE_ENABLED) return;
  
  let warmed = 0;
  asinDataList.forEach(({ asin, data }) => {
    if (asinCache.set(`asin:${asin}`, data)) {
      warmed++;
    }
  });
  
  console.log(`[ASIN Cache] 🔥 WARMED: ${warmed} ASINs preloaded`);
  return warmed;
}

// Export cache instance for advanced usage
export default asinCache;
