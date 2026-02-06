import axios from 'axios';
import { trackApiUsage } from './apiUsageTracker.js';

/**
 * ScraperAPI - Complete Product Data Extraction
 * Replaces PAAPI entirely for all product fields (Title, Brand, Description, Images, Price)
 * 
 * Free tier: 5,000 requests/month
 * Sign up: https://www.scraperapi.com
 */

const SCRAPER_API_BASE = 'http://api.scraperapi.com';

// Rate limiting queue to prevent 429 errors
let requestQueue = Promise.resolve();
let lastRequestTime = 0;
const MIN_REQUEST_DELAY = parseInt(process.env.SCRAPER_API_RATE_LIMIT_MS) || 2000;

/**
 * Throttle function to ensure minimum delay between API calls
 */
async function throttledRequest(requestFn) {
  return new Promise((resolve, reject) => {
    requestQueue = requestQueue.then(async () => {
      const now = Date.now();
      const timeSinceLastRequest = now - lastRequestTime;
      const delayNeeded = Math.max(0, MIN_REQUEST_DELAY - timeSinceLastRequest);
      
      if (delayNeeded > 0) {
        console.log(`[ScraperAPI] ⏱️ Rate limiting: waiting ${delayNeeded}ms...`);
        await new Promise(resolve => setTimeout(resolve, delayNeeded));
      }
      
      lastRequestTime = Date.now();
      
      try {
        const result = await requestFn();
        resolve(result);
      } catch (error) {
        reject(error);
      }
    });
  });
}

/**
 * Get API key from environment
 */
function getApiKey() {
  const key = process.env.SCRAPER_API_KEY;
  if (!key || key === 'your_api_key_here_after_signup') {
    throw new Error('SCRAPER_API_KEY environment variable not set. Please add it to .env file.');
  }
  return key;
}

/**
 * Clean text by removing invisible characters and extra whitespace
 */
function cleanText(str) {
  return (str || '')
    .replace(/[\u200e\u200f\u202a-\u202e\ufeff]/g, '')
    .replace(/Â£/g, '£')
    .replace(/Â€/g, '€')
    .replace(/Â¥/g, '¥')
    .replace(/Â/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract title from Amazon HTML
 */
function extractTitle(html, asin) {
  const selectors = [
    // Primary - most common
    /<span id="productTitle"[^>]*>([^<]+)<\/span>/i,
    // Fallbacks
    /<h1[^>]*id="title"[^>]*>([^<]+)<\/h1>/i,
    /<span[^>]*class="[^"]*product-title[^"]*"[^>]*>([^<]+)<\/span>/i,
    // Mobile layout
    /<h1[^>]*class="[^"]*product-title[^"]*"[^>]*>([^<]+)<\/h1>/i
  ];
  
  for (const selector of selectors) {
    const match = html.match(selector);
    if (match && match[1]) {
      const title = cleanText(match[1]);
      if (title.length > 5) {
        console.log(`[ScraperAPI] ✅ Title found for ${asin}: "${title.substring(0, 60)}..."`);
        return title;
      }
    }
  }
  
  console.warn(`[ScraperAPI] ⚠️ No title found for ${asin}`);
  return 'Unknown Product';
}

/**
 * Extract brand from Amazon HTML
 */
function extractBrand(html, asin) {
  const selectors = [
    // bylineInfo link - most common
    /<a id="bylineInfo"[^>]*>(?:Visit the )?([^<]+?)(?:\s+(?:Store|Storefront))?<\/a>/i,
    // Brand in product details table
    /<tr[^>]*class="[^"]*po-brand[^"]*"[\s\S]{0,200}<td[^>]*class="a-span9"[^>]*>([^<]+)<\/td>/i,
    // Inline brand
    /<span>Brand:\s*<strong>([^<]+)<\/strong><\/span>/i,
    // Meta tag
    /<meta[^>]*property="og:brand"[^>]*content="([^"]+)"/i,
    // Alternative byline format
    /<span[^>]*class="[^"]*author[^"]*"[^>]*>(?:by\s+)?([^<]+)<\/span>/i
  ];
  
  for (const selector of selectors) {
    const match = html.match(selector);
    if (match && match[1]) {
      const brand = cleanText(match[1]);
      if (brand.length > 0 && !brand.toLowerCase().includes('unknown')) {
        console.log(`[ScraperAPI] ✅ Brand found for ${asin}: "${brand}"`);
        return brand;
      }
    }
  }
  
  console.warn(`[ScraperAPI] ⚠️ No brand found for ${asin}`);
  return 'Unbranded';
}

/**
 * Extract description/features from Amazon HTML
 */
function extractDescription(html, asin) {
  const features = [];
  
  // Method 1: Feature bullets (most common)
  const featureBulletsRegex = /<div id="feature-bullets"[\s\S]*?<ul[^>]*>([\s\S]*?)<\/ul>/i;
  const bulletsMatch = html.match(featureBulletsRegex);
  
  if (bulletsMatch && bulletsMatch[1]) {
    const listItems = bulletsMatch[1].match(/<li[^>]*>[\s\S]*?<span[^>]*class="a-list-item"[^>]*>([\s\S]*?)<\/span>[\s\S]*?<\/li>/gi);
    if (listItems) {
      listItems.forEach(li => {
        const textMatch = li.match(/<span[^>]*class="a-list-item"[^>]*>([\s\S]*?)<\/span>/i);
        if (textMatch && textMatch[1]) {
          const feature = cleanText(textMatch[1].replace(/<[^>]+>/g, ''));
          if (feature.length > 5 && !feature.toLowerCase().includes('see more product details')) {
            features.push(feature);
          }
        }
      });
    }
  }
  
  // Method 2: Alternative bullet format
  if (features.length === 0) {
    const altBulletsRegex = /<div[^>]*class="[^"]*a-section[^"]*feature[^"]*"[^>]*>[\s\S]*?<ul>([\s\S]*?)<\/ul>/i;
    const altMatch = html.match(altBulletsRegex);
    if (altMatch && altMatch[1]) {
      const listItems = altMatch[1].match(/<li[^>]*>([\s\S]*?)<\/li>/gi);
      if (listItems) {
        listItems.forEach(li => {
          const feature = cleanText(li.replace(/<[^>]+>/g, ''));
          if (feature.length > 5) {
            features.push(feature);
          }
        });
      }
    }
  }
  
  // Method 3: Product description paragraph (fallback)
  if (features.length === 0) {
    const descRegex = /<div id="productDescription"[^>]*>[\s\S]*?<p>([\s\S]*?)<\/p>/i;
    const descMatch = html.match(descRegex);
    if (descMatch && descMatch[1]) {
      const desc = cleanText(descMatch[1].replace(/<[^>]+>/g, ''));
      if (desc.length > 10) {
        features.push(desc);
      }
    }
  }
  
  const description = features.join('\n');
  console.log(`[ScraperAPI] ✅ Description found for ${asin}: ${features.length} features`);
  return description || '';
}

/**
 * Extract images from Amazon HTML
 */
function extractImages(html, asin) {
  let images = [];
  
  // Method 1: Extract from 'colorImages' JSON in script tag (best quality, all gallery images)
  const colorImagesRegex = /"colorImages":\s*\{[^}]*?"initial":\s*\[([\s\S]*?)\]\s*\}/i;
  const colorMatch = html.match(colorImagesRegex);
  if (colorMatch && colorMatch[1]) {
    console.log(`[ScraperAPI] 🔍 Found colorImages JSON for ${asin}`);
    // Try hiRes first (highest quality)
    const hiResMatches = colorMatch[1].matchAll(/"hiRes":\s*"([^"]+)"/gi);
    for (const match of hiResMatches) {
      const imageUrl = match[1];
      if (imageUrl && imageUrl.startsWith('http') && !images.includes(imageUrl)) {
        images.push(imageUrl);
      }
    }
    console.log(`[ScraperAPI] 📸 Extracted ${images.length} images from hiRes`);
    
    // If no hiRes, try 'large'
    if (images.length === 0) {
      const largeMatches = colorMatch[1].matchAll(/"large":\s*"([^"]+)"/gi);
      for (const match of largeMatches) {
        const imageUrl = match[1];
        if (imageUrl && imageUrl.startsWith('http') && !images.includes(imageUrl)) {
          images.push(imageUrl);
        }
      }
      console.log(`[ScraperAPI] 📸 Extracted ${images.length} images from large`);
    }
  }
  
  // Method 2: Extract from 'imageGalleryData' JSON (newer format)
  if (images.length === 0) {
    const galleryRegex = /"imageGalleryData":\s*\[([\s\S]*?)\]/i;
    const galleryMatch = html.match(galleryRegex);
    if (galleryMatch && galleryMatch[1]) {
      console.log(`[ScraperAPI] 🔍 Found imageGalleryData JSON for ${asin}`);
      const mainUrlMatches = galleryMatch[1].matchAll(/"mainUrl":\s*"([^"]+)"/gi);
      for (const match of mainUrlMatches) {
        const imageUrl = match[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/');
        if (imageUrl && imageUrl.startsWith('http') && !images.includes(imageUrl)) {
          images.push(imageUrl);
        }
      }
      console.log(`[ScraperAPI] 📸 Extracted ${images.length} images from imageGalleryData`);
    }
  }
  
  // Method 3: Extract from altImages thumbnails with data-old-hires (image carousel)
  if (images.length === 0) {
    const altImagesRegex = /<div id="altImages"[\s\S]*?<ul[^>]*>([\s\S]*?)<\/ul>/i;
    const altImagesMatch = html.match(altImagesRegex);
    
    if (altImagesMatch && altImagesMatch[1]) {
      console.log(`[ScraperAPI] 🔍 Found altImages section for ${asin}`);
      const imageMatches = altImagesMatch[1].matchAll(/data-old-hires="([^"]+)"/gi);
      for (const match of imageMatches) {
        const imageUrl = match[1];
        if (imageUrl && imageUrl.startsWith('http') && !images.includes(imageUrl)) {
          images.push(imageUrl);
        }
      }
      console.log(`[ScraperAPI] 📸 Extracted ${images.length} images from altImages`);
    }
  }
  
  // Method 4: Extract ALL data-a-dynamic-image attributes (image gallery)
  if (images.length === 0) {
    console.log(`[ScraperAPI] 🔍 Trying data-a-dynamic-image for ${asin}`);
    const dynamicImageRegex = /data-a-dynamic-image="({[^"]+})"/gi;
    let dynamicMatch;
    const imagesByKey = new Map(); // Track unique image IDs
    
    while ((dynamicMatch = dynamicImageRegex.exec(html)) !== null) {
      try {
        const imageData = JSON.parse(dynamicMatch[1].replace(/&quot;/g, '"'));
        for (const imageUrl of Object.keys(imageData)) {
          if (imageUrl && imageUrl.startsWith('http')) {
            // Extract image ID from URL (e.g., "71ToyHTZUQL" from "...I/71ToyHTZUQL._AC_...")
            const imageIdMatch = imageUrl.match(/\/images\/I\/([A-Za-z0-9+_-]+)\./);
            if (imageIdMatch) {
              const imageId = imageIdMatch[1];
              // Only keep the first URL for each unique image ID (usually highest quality)
              if (!imagesByKey.has(imageId)) {
                imagesByKey.set(imageId, imageUrl);
              }
            }
          }
        }
      } catch (e) {
        // Skip invalid JSON
      }
    }
    
    images = Array.from(imagesByKey.values());
    console.log(`[ScraperAPI] 📸 Extracted ${images.length} unique images from data-a-dynamic-image`);
  }
  
  // Method 5: Landing image with data-old-hires
  if (images.length === 0) {
    const landingImageRegex = /<img[^>]*id="landingImage"[^>]*data-old-hires="([^"]+)"/i;
    const landingMatch = html.match(landingImageRegex);
    if (landingMatch && landingMatch[1]) {
      images.push(landingMatch[1]);
      console.log(`[ScraperAPI] 📸 Extracted 1 image from landingImage`);
    }
  }
  
  // Method 6: Alternative main image src
  if (images.length === 0) {
    const imgSrcRegex = /<img[^>]*id="landingImage"[^>]*src="([^"]+)"/i;
    const imgMatch = html.match(imgSrcRegex);
    if (imgMatch && imgMatch[1]) {
      const imgUrl = imgMatch[1];
      if (imgUrl.startsWith('http') && !imgUrl.includes('data:image')) {
        images.push(imgUrl);
        console.log(`[ScraperAPI] 📸 Extracted 1 image from landingImage src`);
      }
    }
  }
  
  // Limit to first 6 images (Amazon product pages typically show 6 main images)
  if (images.length > 6) {
    images = images.slice(0, 6);
  }
  
  console.log(`[ScraperAPI] ✅ Images found for ${asin}: ${images.length} images`);
  if (images.length === 0) {
    console.warn(`[ScraperAPI] ⚠️ No images extracted for ${asin} - HTML might have different structure`);
  } else {
    console.log(`[ScraperAPI] 🖼️ First image: ${images[0].substring(0, 80)}...`);
    if (images.length > 1) {
      console.log(`[ScraperAPI] 🖼️ Last image: ${images[images.length - 1].substring(0, 80)}...`);
    }
  }
  return images;
}

/**
 * Extract price from Amazon HTML
 * Reuses existing patterns from scraperApiPrice.js
 */
function extractPriceFromHTML(html) {
  // Price selectors (same as original)
  const selectors = [
    // Old layout
    /<span id="priceblock_ourprice"[^>]*>([^<]+)<\/span>/i,
    /<span id="priceblock_dealprice"[^>]*>([^<]+)<\/span>/i,
    /<span id="priceblock_saleprice"[^>]*>([^<]+)<\/span>/i,
    // New layout
    /<span class="a-offscreen">([^<]+)<\/span>/i,
    /<span[^>]*class="[^"]*a-price[^"]*"[^>]*>[\s\S]*?<span class="a-offscreen">([^<]+)<\/span>/i,
    // Buybox price
    /<div id="corePrice_feature_div"[\s\S]*?<span class="a-offscreen">([^<]+)<\/span>/i,
    // Desktop display
    /<div id="corePriceDisplay_desktop_feature_div"[\s\S]*?<span class="a-offscreen">([^<]+)<\/span>/i,
    // Generic price
    /<span data-a-color="price"[\s\S]*?<span class="a-offscreen">([^<]+)<\/span>/i
  ];

  for (const selector of selectors) {
    const match = html.match(selector);
    if (match && match[1]) {
      const rawPrice = cleanText(match[1]);
      // Extract just the price (remove currency symbol)
      const cleaned = rawPrice.replace(/^[^\d]+/, '').trim();
      if (cleaned && /[\d.,]+/.test(cleaned)) {
        return cleaned;
      }
    }
  }

  return null;
}

/**
 * Extract all product data from Amazon HTML
 */
function extractProductDataFromHTML(html, asin) {
  return {
    title: extractTitle(html, asin),
    brand: extractBrand(html, asin),
    description: extractDescription(html, asin),
    images: extractImages(html, asin),
    price: extractPriceFromHTML(html)
  };
}

/**
 * Main function - Scrape complete Amazon product data using ScraperAPI
 * @param {string} asin - Amazon ASIN
 * @param {string} region - Amazon region (US, UK, CA, AU)
 * @param {number} retries - Retry attempts (default: 2)
 * @returns {Promise<Object>} - Complete product data
 */
export async function scrapeAmazonProductWithScraperAPI(asin, region = 'US', retries = 2) {
  return throttledRequest(async () => {
    const SCRAPER_API_KEY = getApiKey();
    const timeout = parseInt(process.env.SCRAPER_API_TIMEOUT_MS) || 30000;
    const maxRetries = parseInt(process.env.SCRAPER_API_MAX_RETRIES) || retries;

    const regionDomains = {
      US: 'amazon.com',
      UK: 'amazon.co.uk',
      CA: 'amazon.ca',
      AU: 'amazon.com.au'
    };

    const domain = regionDomains[region] || regionDomains.US;
    const url = `https://www.${domain}/dp/${asin}`;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const startTime = Date.now();
      
      try {
        console.log(`[ScraperAPI] 🔍 Scraping ASIN: ${asin}${attempt > 1 ? ` (attempt ${attempt}/${maxRetries})` : ''}`);

        // Make request to ScraperAPI
        const response = await axios.get(SCRAPER_API_BASE, {
          params: {
            api_key: SCRAPER_API_KEY,
            url: url,
            render: 'false',
            residential: 'false'
          },
          timeout
        });

        if (response.status !== 200) {
          throw new Error(`ScraperAPI returned status ${response.status}`);
        }

        const html = response.data;
        const responseTime = Date.now() - startTime;

        // Extract all product data
        const productData = extractProductDataFromHTML(html, asin);

        // Validate critical fields
        if (!productData.price) {
          if (attempt < maxRetries) {
            console.warn(`[ScraperAPI] ⚠️ No price found for ${asin}, retrying...`);
            await new Promise(resolve => setTimeout(resolve, 2000));
            continue;
          }
          console.warn(`[ScraperAPI] ⚠️ No price found in HTML for ASIN: ${asin}`);
          throw new Error('NO_PRICE_FOUND');
        }
        
        // Debug: Save HTML snippet if no images found (for debugging)
        if (productData.images.length === 0 && process.env.NODE_ENV === 'development') {
          console.warn(`[ScraperAPI] 🐛 DEBUG: No images found for ${asin}. HTML snippet (first 2000 chars):`);
          console.log(html.substring(0, 2000));
        }

        // Track successful usage
        const extractedFields = ['price'];
        if (productData.title && productData.title !== 'Unknown Product') extractedFields.push('title');
        if (productData.brand && productData.brand !== 'Unbranded') extractedFields.push('brand');
        if (productData.description) extractedFields.push('description');
        if (productData.images.length > 0) extractedFields.push('images');

        // Track API usage (don't await to avoid blocking)
        trackApiUsage({
          service: 'ScraperAPI',
          asin,
          creditsUsed: 1,
          success: true,
          responseTime,
          extractedFields
        }).catch(err => console.error('[Usage Tracker] Failed to track:', err.message));

        console.log(`[ScraperAPI] ✅ Successfully scraped all data for ${asin} in ${responseTime}ms`);
        
        return {
          ...productData,
          rawHtml: html.substring(0, 1000) // Store first 1KB for debugging
        };
      } catch (error) {
        const responseTime = Date.now() - startTime;
        
        // Don't retry on 429 errors or NO_PRICE_FOUND (final attempt)
        if (error.response?.status === 429 || error.message === 'NO_PRICE_FOUND') {
          // Track failed usage
          trackApiUsage({
            service: 'ScraperAPI',
            asin,
            creditsUsed: 1,
            success: false,
            errorMessage: error.message,
            responseTime,
            extractedFields: []
          }).catch(err => console.error('[Usage Tracker] Failed to track:', err.message));
          
          console.error(`[ScraperAPI] ❌ Failed to scrape ASIN ${asin}:`, error.message);
          throw error;
        }
        
        // Retry on other errors
        if (attempt < maxRetries) {
          console.warn(`[ScraperAPI] ⚠️ Attempt ${attempt} failed for ${asin}: ${error.message}, retrying...`);
          await new Promise(resolve => setTimeout(resolve, 2000 * attempt)); // Exponential backoff
          continue;
        }
        
        // Track final failed attempt
        trackApiUsage({
          service: 'ScraperAPI',
          asin,
          creditsUsed: 1,
          success: false,
          errorMessage: error.message,
          responseTime,
          extractedFields: []
        }).catch(err => console.error('[Usage Tracker] Failed to track:', err.message));
        
        console.error(`[ScraperAPI] ❌ Failed to scrape ASIN ${asin}:`, error.message);
        throw error;
      }
    }
  });
}

/**
 * Batch scrape multiple ASINs (with throttling)
 * @param {Array<string>} asins - Array of ASINs to scrape
 * @param {string} region - Amazon region
 * @returns {Promise<Array>} - Array of scraped product data
 */
export async function batchScrapeAmazonProductsWithScraperAPI(asins, region = 'US') {
  console.log(`[ScraperAPI] 📦 Batch scraping ${asins.length} ASINs...`);
  
  const results = [];
  
  for (const asin of asins) {
    try {
      const data = await scrapeAmazonProductWithScraperAPI(asin, region);
      results.push({ asin, data, success: true });
    } catch (error) {
      console.error(`[ScraperAPI] ❌ Batch scrape failed for ${asin}:`, error.message);
      results.push({ asin, data: null, success: false, error: error.message });
    }
  }
  
  const successCount = results.filter(r => r.success).length;
  console.log(`[ScraperAPI] ✅ Batch complete: ${successCount}/${asins.length} successful`);
  
  return results;
}
