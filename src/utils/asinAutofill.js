import { generateWithGemini, replacePlaceholders } from './gemini.js';

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
 */
export async function applyFieldConfigs(amazonData, fieldConfigs) {
  const autoFilledData = {};
  
  // Placeholder data for AI prompts
  const placeholderData = {
    title: amazonData.title,
    brand: amazonData.brand,
    description: amazonData.description,
    price: amazonData.price,
    asin: amazonData.asin
  };
  
  for (const config of fieldConfigs) {
    if (!config.enabled) continue;
    
    try {
      if (config.source === 'direct') {
        // Direct mapping from Amazon field
        let value = amazonData[config.amazonField];
        
        // Apply transformations
        value = applyTransform(value, config.transform);
        
        autoFilledData[config.ebayField] = value;
        
      } else if (config.source === 'ai') {
        // AI generation using prompt template
        const processedPrompt = replacePlaceholders(
          config.promptTemplate, 
          placeholderData
        );
        
        let generatedValue = await generateWithGemini(processedPrompt);
        
        // Auto-truncate titles to 80 chars
        if (config.ebayField === 'title' && generatedValue.length > 80) {
          generatedValue = generatedValue.substring(0, 80);
        }
        
        autoFilledData[config.ebayField] = generatedValue;
      }
      
      console.log(`Auto-filled ${config.ebayField}: ${autoFilledData[config.ebayField]?.substring(0, 50)}...`);
      
    } catch (error) {
      console.error(`Error processing ${config.ebayField}:`, error);
      autoFilledData[config.ebayField] = '';
    }
  }
  
  return autoFilledData;
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
