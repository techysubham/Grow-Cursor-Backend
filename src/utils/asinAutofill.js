import { generateWithGemini, replacePlaceholders } from './gemini.js';
import { calculateStartPrice } from './pricingCalculator.js';
import { processImagePlaceholders } from './imageReplacer.js';

/**
 * Fetch Amazon product data by ASIN
 */
export async function fetchAmazonData(asin) {
  const url = `https://amazon-helper.vercel.app/api/items?asin=${asin}`;
  const response = await fetch(url);
  
  if (!response.ok) {
    throw new Error('Failed to fetch Amazon data');
  }
  
  const data = await response.json();
  const item = data.ItemsResult?.Items?.[0];
  
  if (!item) {
    throw new Error('No item found for this ASIN');
  }
  
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
  
  let price = item.Offers?.Listings?.[0]?.Price?.DisplayAmount || '';
  price = price.split(' ')[0]; // Extract numeric part
  
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
  
  for (const config of fieldConfigs) {
    const targetObject = config.fieldType === 'custom' ? customFields : coreFields;
    
    // Apply default value if config is disabled
    if (!config.enabled) {
      if (config.defaultValue) {
        targetObject[config.ebayField] = config.defaultValue;
        console.log(`Applied default value for ${config.ebayField}: ${config.defaultValue}`);
      }
      continue;
    }
    
    try {
      if (config.source === 'direct' && config.fieldType === 'core') {
        // Direct mapping only available for core fields
        let value = amazonData[config.amazonField];
        
        // Apply transformations
        value = applyTransform(value, config.transform);
        
        // Apply image placeholder replacement for description field
        if (config.ebayField === 'description' && typeof value === 'string') {
          value = processImagePlaceholders(value, amazonData.images);
        }
        
        targetObject[config.ebayField] = value;
        
      } else if (config.source === 'ai') {
        // AI generation for both core and custom fields
        const processedPrompt = replacePlaceholders(
          config.promptTemplate, 
          placeholderData
        );
        
        // Use higher token limit for description field to avoid truncation
        const maxTokens = config.ebayField === 'description' ? 1000 : 150;
        
        let generatedValue = await generateWithGemini(processedPrompt, { maxTokens });
        
        // Auto-truncate titles to 80 chars (only for core title field)
        if (config.fieldType === 'core' && config.ebayField === 'title' && generatedValue.length > 80) {
          generatedValue = generatedValue.substring(0, 80);
        }
        
        // Apply image placeholder replacement for description field and description-like custom fields
        if ((config.ebayField === 'description' || config.ebayField.toLowerCase().includes('description')) && typeof generatedValue === 'string') {
          generatedValue = processImagePlaceholders(generatedValue, amazonData.images);
        }
        
        targetObject[config.ebayField] = generatedValue;
      }
      
      // Fallback to default value if generation/mapping resulted in empty value
      if (!targetObject[config.ebayField] && config.defaultValue) {
        targetObject[config.ebayField] = config.defaultValue;
        console.log(`Used default value fallback for ${config.ebayField}: ${config.defaultValue}`);
      }
      
      const fieldLabel = config.fieldType === 'custom' ? `[Custom] ${config.ebayField}` : config.ebayField;
      console.log(`Auto-filled ${fieldLabel}: ${targetObject[config.ebayField]?.substring(0, 50)}...`);
      
    } catch (error) {
      console.error(`Error processing ${config.ebayField}:`, error);
      // Use default value as fallback on error
      targetObject[config.ebayField] = config.defaultValue || '';
    }
  }
  
  // PRIORITY: If pricing config enabled, calculate startPrice (overrides field config)
  if (pricingConfig?.enabled && amazonData.price) {
    try {
      // Extract numeric cost from Amazon price string (e.g., "$49.99" -> 49.99)
      const amazonCost = parseFloat(amazonData.price.replace(/[^0-9.]/g, ''));
      
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
          console.log(`[Pricing Calculator] Cost: ${amazonData.price}, Tier: ${result.breakdown.profitTier.costRange} (${result.breakdown.profitTier.profit} INR), Start Price: $${result.price.toFixed(2)}`);
        } else {
          console.log(`[Pricing Calculator] Cost: ${amazonData.price}, Calculated Start Price: $${result.price.toFixed(2)}`);
        }
      }
    } catch (error) {
      console.error('[Pricing Calculator] Error:', error.message);
      // Fall back to regular field config processing for startPrice
      pricingCalculation = {
        enabled: true,
        error: error.message
      };
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
