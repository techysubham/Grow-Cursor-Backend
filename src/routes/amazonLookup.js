import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import AmazonProduct from '../models/AmazonProduct.js';

const router = express.Router();

// Fetch Amazon data and optionally save to database
router.post('/', requireAuth, async (req, res) => {
  try {
    const { asin, sellerId, productUmbrellaId } = req.body;

    if (!asin || !productUmbrellaId) {
      return res.status(400).json({ error: 'ASIN and Product Umbrella are required' });
    }

    const url = `https://amazon-helper.vercel.app/api/items?asin=${asin}`;
    
    const response = await fetch(url);
    
    if (!response.ok) {
      return res.status(response.status).json({ 
        error: 'Failed to fetch Amazon data' 
      });
    }

    const data = await response.json();
    const item = data.ItemsResult?.Items?.[0];

    if (!item) {
      return res.status(404).json({ error: 'No item found for this ASIN' });
    }

    // Extract and format the data
    let title = item.ItemInfo?.Title?.DisplayValue || '';
    const brand = 
      item.ItemInfo?.ByLineInfo?.Brand?.DisplayValue ||
      item.ItemInfo?.ByLineInfo?.Manufacturer?.DisplayValue ||
      'Unbranded';

    // Remove brand from title if it's included
    if (brand && title.toLowerCase().includes(brand.toLowerCase())) {
      title = title.replace(new RegExp(brand, 'ig'), '').trim();
    }

    let price = item.Offers?.Listings?.[0]?.Price?.DisplayAmount || '';
    price = price.split(' ')[0];

    const description = (item.ItemInfo?.Features?.DisplayValues || []).join('\n');

    // Collect all images
    const allImages = [];
    if (item.Images?.Primary?.Large?.URL) {
      allImages.push(item.Images.Primary.Large.URL);
    }
    if (item.Images?.Variants?.length) {
      item.Images.Variants.forEach(img => {
        if (img.Large?.URL && !allImages.includes(img.Large.URL)) {
          allImages.push(img.Large.URL);
        }
      });
    }
    if (item.Images?.Alternate?.length) {
      item.Images.Alternate.forEach(img => {
        if (img.Large?.URL && !allImages.includes(img.Large.URL)) {
          allImages.push(img.Large.URL);
        }
      });
    }

    const productData = {
      asin,
      title,
      price,
      brand,
      description,
      images: allImages,
      rawData: item
    };

    // If sellerId and productUmbrellaId are provided, save to database
    if (productUmbrellaId) {
      const amazonProductData = {
        ...productData,
        productUmbrellaId,
        createdBy: req.user.userId
      };
      
      // Only add sellerId if it's provided
      if (sellerId) {
        amazonProductData.sellerId = sellerId;
      }

      const amazonProduct = new AmazonProduct(amazonProductData);

      await amazonProduct.save();
      await amazonProduct.populate({ path: 'sellerId', populate: { path: 'user', select: 'username email' } });
      await amazonProduct.populate('productUmbrellaId', 'name');
      await amazonProduct.populate('createdBy', 'name email');

      return res.json({
        ...productData,
        saved: true,
        _id: amazonProduct._id,
        seller: amazonProduct.sellerId,
        productUmbrella: amazonProduct.productUmbrellaId
      });
    }

    // Return data without saving
    res.json({
      ...productData,
      saved: false
    });

  } catch (error) {
    console.error('Amazon lookup error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get all saved Amazon products
router.get('/', requireAuth, async (req, res) => {
  try {
    const { sellerId, productUmbrellaId } = req.query;
    const filter = {};
    
    if (sellerId) filter.sellerId = sellerId;
    if (productUmbrellaId) filter.productUmbrellaId = productUmbrellaId;

    const products = await AmazonProduct.find(filter)
      .populate({ path: 'sellerId', populate: { path: 'user', select: 'username email' } })
      .populate('productUmbrellaId', 'name')
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 });

    res.json(products);
  } catch (error) {
    console.error('Error fetching Amazon products:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get single Amazon product by ID
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const product = await AmazonProduct.findById(req.params.id)
      .populate({ path: 'sellerId', populate: { path: 'user', select: 'username email' } })
      .populate('productUmbrellaId', 'name')
      .populate('createdBy', 'name email');

    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.json(product);
  } catch (error) {
    console.error('Error fetching Amazon product:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete Amazon product
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const product = await AmazonProduct.findByIdAndDelete(req.params.id);

    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.json({ message: 'Product deleted successfully' });
  } catch (error) {
    console.error('Error deleting Amazon product:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
