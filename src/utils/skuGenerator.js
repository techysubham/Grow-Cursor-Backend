/**
 * Generates SKU using company format: GRW25 + last 5 chars of ASIN
 * @param {string} asin - Amazon Standard Identification Number
 * @returns {string} Generated SKU (e.g., 'GRW25WRWNW')
 */
export const generateSKUFromASIN = (asin) => {
  if (!asin || typeof asin !== 'string') return '';
  
  const cleanASIN = asin.trim().toUpperCase();
  
  if (cleanASIN.length < 5) {
    console.warn(`ASIN "${asin}" is too short for SKU generation`);
    return cleanASIN; // Return as-is if too short
  }
  
  return 'GRW25' + cleanASIN.slice(-5);
};

/**
 * Validates if a string is a valid ASIN format
 * @param {string} asin - String to validate
 * @returns {boolean} True if valid ASIN format
 */
export const isValidASIN = (asin) => {
  if (!asin || typeof asin !== 'string') return false;
  const clean = asin.trim().toUpperCase();
  return clean.length === 10 && clean.startsWith('B0');
};
