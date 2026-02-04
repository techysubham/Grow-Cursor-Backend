import { generateWithGemini, replacePlaceholders } from './gemini.js';
import { calculateStartPrice } from './pricingCalculator.js';
import { processImagePlaceholders } from './imageReplacer.js';
import { scrapeAmazonPriceWithScraperAPI } from './scraperApiPrice.js';

/**
 * Fetch from PAAPI with retry logic
 */
async function fetchFromPAAPI(asin, retries = 2) {
  const url = `https://amazon-helper.vercel.app/api/items?asin=${asin}`;
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, { timeout: 15000 });
      
      if (!response.ok) {
        if (attempt < retries) {
          console.log(`[ASIN: ${asin}] PAAPI attempt ${attempt} failed with ${response.status}, retrying...`);
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt)); // Exponential backoff
          continue;
        }
        throw new Error(`PAAPI returned status ${response.status}`);
      }
      
      const data = await response.json();
      const item = data.ItemsResult?.Items?.[0];
      
      if (!item) {
        throw new Error('No item found for this ASIN');
      }
      
      return item;
    } catch (error) {
      if (attempt < retries) {
        console.log(`[ASIN: ${asin}] PAAPI attempt ${attempt} error: ${error.message}, retrying...`);
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        continue;
      }
      throw error;
    }
  }
}

/**
 * Fetch Amazon product data by ASIN
 * Uses PAAPI as primary source, falls back to ScraperAPI for price if unavailable
 */
export async function fetchAmazonData(asin) {
  const item = await fetchFromPAAPI(asin);
  
  // Extract core data
  let title = item.ItemInfo?.Title?.DisplayValue || '';
  const brand = 
    item.ItemInfo?.ByLineInfo?.Brand?.DisplayValue ||
    item.ItemInfo?.ByLineInfo?.Manufacturer?.DisplayValue ||
    'Unbranded';
  
  // Remove brand from title
  if (brand && title.toLowerCase().includes(brand.toLowerCase())) {
    title = title.replace(new RegExp(brand, 'ig'), '').trim();
  }
  
  // Extract price with detailed logging - log the entire Offers structure
  console.log(`[ASIN: ${asin}] 📦 Full Offers object:`, JSON.stringify(item.Offers, null, 2));
  console.log(`[ASIN: ${asin}] 🔍 Checking price paths:`);
  console.log(`   Offers?.Listings?.[0]?.Price?.DisplayAmount: ${item.Offers?.Listings?.[0]?.Price?.DisplayAmount}`);
  console.log(`   Offers?.Listings?.[0]?.Price?.Amount: ${item.Offers?.Listings?.[0]?.Price?.Amount}`);
  console.log(`   Offers?.Summaries?.[0]?.LowestPrice?.DisplayAmount: ${item.Offers?.Summaries?.[0]?.LowestPrice?.DisplayAmount}`);
  console.log(`   Offers?.Summaries?.[0]?.HighestPrice?.DisplayAmount: ${item.Offers?.Summaries?.[0]?.HighestPrice?.DisplayAmount}`);
  
  let price = item.Offers?.Listings?.[0]?.Price?.DisplayAmount || 
              item.Offers?.Listings?.[0]?.Price?.Amount?.toString() ||
              item.Offers?.Summaries?.[0]?.LowestPrice?.DisplayAmount ||
              item.Offers?.Summaries?.[0]?.HighestPrice?.DisplayAmount || '';
  
  if (price) {
    price = price.toString().split(' ')[0]; // Extract numeric part (handle both "$49.99" and "49.99")
    console.log(`[ASIN: ${asin}] ✅ PAAPI price found: "${price}"`);
  } else {
    console.warn(`[ASIN: ${asin}] ⚠️ No price in PAAPI response, attempting ScraperAPI...`);
    
    // Fallback to ScraperAPI when PAAPI doesn't provide price
    try {
      price = await scrapeAmazonPriceWithScraperAPI(asin, 'US');
      if (price) {
        console.log(`[ASIN: ${asin}] ✅ ScraperAPI successfully retrieved price: "${price}"`);
      }
    } catch (scraperError) {
      console.error(`[ASIN: ${asin}] ❌ ScraperAPI also failed:`, scraperError.message);
      // Price remains empty string - will be caught by validation later
    }
  }
  
  const description = (item.ItemInfo?.Features?.DisplayValues || []).join('\n');
  
  // Collect images
  const images = [];
  if (item.Images?.Primary?.Large?.URL) {
    images.push(item.Images.Primary.Large.URL);
  }
  if (item.Images?.Variants?.length) {
    item.Images.Variants.forEach(img => {
      if (img.Large?.URL && !images.includes(img.Large.URL)) {
        images.push(img.Large.URL);
      }
    });
  }
  if (item.Images?.Alternate?.length) {
    item.Images.Alternate.forEach(img => {
      if (img.Large?.URL && !images.includes(img.Large.URL)) {
        images.push(img.Large.URL);
      }
    });
  }
  
  return {
    asin,
    title,
    price,
    brand,
    description,
    images,
    rawData: item
  };
}

/**
 * Apply field configurations to generate auto-fill data
 * Separates core eBay fields and custom columns
 * @param {Object} amazonData - Fetched Amazon product data
 * @param {Array} fieldConfigs - Field configuration array from template
 * @param {Object} pricingConfig - Optional pricing configuration for startPrice calculation
 * @returns {Object} { coreFields, customFields, pricingCalculation }
 */
export async function applyFieldConfigs(amazonData, fieldConfigs, pricingConfig = null) {
  const coreFields = {};
  const customFields = {};
  let pricingCalculation = null;
  
  // Placeholder data for AI prompts
  const placeholderData = {
    title: amazonData.title,
    brand: amazonData.brand,
    description: amazonData.description,
    price: amazonData.price,
    asin: amazonData.asin
  };
  
  // Separate configs by processing type for parallel execution
  const directConfigs = [];
  const aiConfigs = [];
  const disabledConfigs = [];
  
  for (const config of fieldConfigs) {
    if (!config.enabled) {
      disabledConfigs.push(config);
    } else if (config.source === 'direct') {
      // Process ALL direct mappings (both core and custom fields)
      directConfigs.push(config);
    } else if (config.source === 'ai') {
      // Process ALL AI configs (both core and custom fields)
      aiConfigs.push(config);
    }
  }
  
  // Check if pricing calculator will override startPrice field config
  const startPriceConfig = fieldConfigs.find(c => c.ebayField === 'startPrice' && c.enabled);
  if (pricingConfig?.enabled && startPriceConfig) {
    console.log(`ℹ️ [ASIN: ${amazonData.asin}] Pricing calculator enabled - will override startPrice field config (${startPriceConfig.source})`);
  }
  
  // Process disabled configs (apply default values immediately)
  for (const config of disabledConfigs) {
    if (config.defaultValue) {
      const targetObject = config.fieldType === 'custom' ? customFields : coreFields;
      targetObject[config.ebayField] = config.defaultValue;
      console.log(`Applied default value for ${config.ebayField}: ${config.defaultValue}`);
    }
  }
  
  // Process direct mapping configs (fast, no API calls)
  for (const config of directConfigs) {
    const targetObject = config.fieldType === 'custom' ? customFields : coreFields;
    
    try {
      let value = amazonData[config.amazonField];
      
      // Apply transformations
      value = applyTransform(value, config.transform);
      
      // Apply image placeholder replacement for description field
      if (config.ebayField === 'description' && typeof value === 'string') {
        value = processImagePlaceholders(value, amazonData.images);
      }
      
      targetObject[config.ebayField] = value;
      
      // Fallback to default value if mapping resulted in empty value
      if (!targetObject[config.ebayField] && config.defaultValue) {
        targetObject[config.ebayField] = config.defaultValue;
        console.log(`Used default value fallback for ${config.ebayField}: ${config.defaultValue}`);
      }
      
      const fieldLabel = config.fieldType === 'custom' ? `[Custom] ${config.ebayField}` : config.ebayField;
      console.log(`Auto-filled ${fieldLabel}: ${targetObject[config.ebayField]?.substring(0, 50)}...`);
      
    } catch (error) {
      console.error(`[ASIN: ${amazonData.asin}] Error processing direct mapping for ${config.ebayField}:`, error);
      targetObject[config.ebayField] = config.defaultValue || '';
    }
  }
  
  // Process AI configs in parallel for maximum speed
  if (aiConfigs.length > 0) {
    console.log(`[ASIN: ${amazonData.asin}] Generating ${aiConfigs.length} AI fields in parallel...`);
    
    const aiPromises = aiConfigs.map(async (config) => {
      try {
        const processedPrompt = replacePlaceholders(
          config.promptTemplate, 
          placeholderData
        );
        
        // Use higher token limit for description field to avoid truncation
        const maxTokens = config.ebayField === 'description' ? 2000 : 150;
        
        let generatedValue = await generateWithGemini(processedPrompt, { maxTokens });
        
        // Auto-truncate based on field type:
        // - Title: 80 characters
        // - Description: No limit (full HTML content)
        // - All other fields (core + custom): 60 characters
        if (config.ebayField === 'title' && generatedValue.length > 80) {
          generatedValue = generatedValue.substring(0, 80);
        } else if (config.ebayField !== 'description' && config.ebayField !== 'title' && generatedValue.length > 60) {
          generatedValue = generatedValue.substring(0, 60);
        }
        
        // Apply image placeholder replacement for description field and description-like custom fields
        if ((config.ebayField === 'description' || config.ebayField.toLowerCase().includes('description')) && typeof generatedValue === 'string') {
          generatedValue = processImagePlaceholders(generatedValue, amazonData.images);
        }
        
        return {
          config,
          value: generatedValue,
          success: true
        };
        
      } catch (error) {
        console.error(`[ASIN: ${amazonData.asin}] Error generating AI field ${config.ebayField}:`, error);
        return {
          config,
          value: config.defaultValue || '',
          success: false,
          error: error.message
        };
      }
    });
    
    // Wait for all AI generations to complete in parallel
    const aiResults = await Promise.all(aiPromises);
    
    // Apply AI results to target objects
    for (const result of aiResults) {
      const targetObject = result.config.fieldType === 'custom' ? customFields : coreFields;
      targetObject[result.config.ebayField] = result.value;
      
      // Critical check for title field (required for listing creation)
      if (result.config.ebayField === 'title' && !result.value) {
        console.error(`❌ CRITICAL [ASIN: ${amazonData.asin}]: Title generation failed - listing cannot be created`);
      }
      
      // Fallback to default value if generation resulted in empty value
      if (!targetObject[result.config.ebayField] && result.config.defaultValue) {
        targetObject[result.config.ebayField] = result.config.defaultValue;
        console.log(`[ASIN: ${amazonData.asin}] Used default value fallback for ${result.config.ebayField}: ${result.config.defaultValue}`);
      }
      
      const fieldLabel = result.config.fieldType === 'custom' ? `[Custom] ${result.config.ebayField}` : result.config.ebayField;
      const status = result.success ? '✅' : '⚠️';
      console.log(`${status} [ASIN: ${amazonData.asin}] Auto-filled ${fieldLabel}: ${targetObject[result.config.ebayField]?.substring(0, 50)}...`);
    }
  }
  
  // PRIORITY: If pricing config enabled, calculate startPrice (overrides field config)
  if (pricingConfig?.enabled) {
    console.log(`[Pricing Calculator] Enabled, Amazon price: "${amazonData.price}"`);
    
    if (!amazonData.price || amazonData.price.trim() === '') {
      console.warn(`[ASIN: ${amazonData.asin}] ⚠️ Amazon price not available - cannot calculate startPrice`);
      pricingCalculation = {
        enabled: true,
        error: 'Amazon price not available'
      };
    } else {
      try {
        // Extract numeric cost from Amazon price string (e.g., "$49.99" -> 49.99)
        const amazonCost = parseFloat(amazonData.price.replace(/[^0-9.]/g, ''));
        
        console.log(`[Pricing Calculator] Extracted numeric cost: ${amazonCost}`);
        
        if (!isNaN(amazonCost) && amazonCost > 0) {
          const result = calculateStartPrice(pricingConfig, amazonCost);
          
          // Override startPrice regardless of field configs
          coreFields.startPrice = result.price.toFixed(2);
          
          pricingCalculation = {
            enabled: true,
            amazonCost: amazonData.price,
            calculatedStartPrice: result.price.toFixed(2),
            breakdown: result.breakdown
          };
          
          // Enhanced logging with tier information
          if (result.breakdown.profitTier?.enabled) {
            console.log(`✅ [Pricing Calculator] Cost: ${amazonData.price}, Tier: ${result.breakdown.profitTier.costRange} (+${result.breakdown.profitTier.profit} INR), Start Price: $${result.price.toFixed(2)}`);
          } else {
            console.log(`✅ [Pricing Calculator] Cost: ${amazonData.price}, Calculated Start Price: $${result.price.toFixed(2)}`);
          }
        } else {
          console.warn(`[ASIN: ${amazonData.asin}] ⚠️ Invalid price value: "${amazonData.price}" (extracted: ${amazonCost})`);
          pricingCalculation = {
            enabled: true,
            error: `Invalid price value: ${amazonData.price}`
          };
        }
      } catch (error) {
        console.error(`[ASIN: ${amazonData.asin}] ❌ [Pricing Calculator] Error:`, error.message);
        // Fall back to regular field config processing for startPrice
        pricingCalculation = {
          enabled: true,
          error: error.message
        };
      }
    }
  }
  
  return { coreFields, customFields, pricingCalculation };
}

/**
 * Apply transformations to values
 */
function applyTransform(value, transform) {
  if (!value) return '';
  
  switch (transform) {
    case 'pipeSeparated':
      return Array.isArray(value) ? value.join(' | ') : value;
      
    case 'removeSymbol':
      return typeof value === 'string' ? value.replace(/[$€£¥]/g, '') : value;
      
    case 'truncate80':
      return typeof value === 'string' ? value.substring(0, 80) : value;
      
    case 'truncate60':
      return typeof value === 'string' ? value.substring(0, 60) : value;
      
    case 'htmlFormat':
      // Convert plain text to simple HTML
      if (typeof value === 'string') {
        const lines = value.split('\n').filter(l => l.trim());
        return `<ul>${lines.map(l => `<li>${l}</li>`).join('')}</ul>`;
      }
      return value;
      
    case 'none':
    default:
      return value;
  }
}
