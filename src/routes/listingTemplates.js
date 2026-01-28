import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import ListingTemplate from '../models/ListingTemplate.js';

const router = express.Router();

// Get custom Action field for template
router.get('/action-field/:templateId', requireAuth, async (req, res) => {
  try {
    const { templateId } = req.params;
    
    const template = await ListingTemplate.findById(templateId);
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    res.json({ 
      actionField: template.customActionField || '*Action(SiteID=US|Country=US|Currency=USD|Version=1193)',
      source: 'template'
    });
  } catch (error) {
    console.error('Error fetching action field:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update custom Action field for template
router.put('/action-field/:templateId', requireAuth, async (req, res) => {
  try {
    const { templateId } = req.params;
    const { actionField } = req.body;
    
    // Basic validation - just check it's not empty
    if (!actionField || !actionField.trim()) {
      return res.status(400).json({ error: 'Action field cannot be empty' });
    }
    
    const template = await ListingTemplate.findByIdAndUpdate(
      templateId,
      { 
        customActionField: actionField.trim(),
        updatedAt: Date.now()
      },
      { new: true }
    );
    
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    res.json({ 
      message: 'Action field updated successfully',
      actionField: template.customActionField
    });
  } catch (error) {
    console.error('Error updating action field:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get all templates
router.get('/', requireAuth, async (req, res) => {
  try {
    const templates = await ListingTemplate.find()
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 });
    
    res.json(templates);
  } catch (error) {
    console.error('Error fetching templates:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get single template by ID
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const template = await ListingTemplate.findById(req.params.id)
      .populate('createdBy', 'name email');
    
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    res.json(template);
  } catch (error) {
    console.error('Error fetching template:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create new template
router.post('/', requireAuth, async (req, res) => {
  try {
    const { name, description, category, ebayCategory, customColumns, asinAutomation, pricingConfig, coreFieldDefaults } = req.body;
    
    if (!name) {
      return res.status(400).json({ error: 'Template name is required' });
    }
    
    const templateData = {
      name,
      description,
      category,
      ebayCategory,
      customColumns: customColumns || [],
      asinAutomation: asinAutomation || { enabled: false, fieldConfigs: [] },
      pricingConfig: pricingConfig || { enabled: false },
      createdBy: req.user.userId
    };
    
    // Add coreFieldDefaults if provided
    if (coreFieldDefaults !== undefined) {
      templateData.coreFieldDefaults = coreFieldDefaults;
    }
    
    const template = new ListingTemplate(templateData);
    
    await template.save();
    await template.populate('createdBy', 'name email');
    
    res.status(201).json(template);
  } catch (error) {
    console.error('Error creating template:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update template
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const { name, description, category, ebayCategory, customColumns, asinAutomation, pricingConfig, coreFieldDefaults } = req.body;
    
    const updateData = { 
      name, 
      description,
      category,
      ebayCategory,
      customColumns: customColumns || [],
      asinAutomation: asinAutomation || { enabled: false, fieldConfigs: [] },
      pricingConfig: pricingConfig || { enabled: false },
      updatedAt: Date.now()
    };
    
    // Add coreFieldDefaults if provided
    if (coreFieldDefaults !== undefined) {
      updateData.coreFieldDefaults = coreFieldDefaults;
    }
    
    const template = await ListingTemplate.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    ).populate('createdBy', 'name email');
    
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    res.json(template);
  } catch (error) {
    console.error('Error updating template:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete template
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const template = await ListingTemplate.findByIdAndDelete(req.params.id);
    
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    // Note: You might want to also delete associated listings
    // await TemplateListing.deleteMany({ templateId: req.params.id });
    
    res.json({ message: 'Template deleted successfully' });
  } catch (error) {
    console.error('Error deleting template:', error);
    res.status(500).json({ error: error.message });
  }
});

// Add custom column to template
router.post('/:id/columns', requireAuth, async (req, res) => {
  try {
    const { name, displayName, dataType, defaultValue, isRequired, placeholder } = req.body;
    
    if (!name || !displayName) {
      return res.status(400).json({ error: 'Column name and display name are required' });
    }
    
    const template = await ListingTemplate.findById(req.params.id);
    
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    // Calculate next order number
    const maxOrder = template.customColumns.length > 0 
      ? Math.max(...template.customColumns.map(col => col.order))
      : 38;
    
    template.customColumns.push({
      name,
      displayName,
      dataType: dataType || 'text',
      defaultValue: defaultValue || '',
      isRequired: isRequired || false,
      order: maxOrder + 1,
      placeholder: placeholder || ''
    });
    
    await template.save();
    await template.populate('createdBy', 'name email');
    
    res.json(template);
  } catch (error) {
    console.error('Error adding column:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update custom column
router.put('/:id/columns/:columnName', requireAuth, async (req, res) => {
  try {
    const { displayName, dataType, defaultValue, isRequired, placeholder } = req.body;
    
    const template = await ListingTemplate.findById(req.params.id);
    
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    const columnIndex = template.customColumns.findIndex(
      col => col.name === req.params.columnName
    );
    
    if (columnIndex === -1) {
      return res.status(404).json({ error: 'Column not found' });
    }
    
    if (displayName) template.customColumns[columnIndex].displayName = displayName;
    if (dataType) template.customColumns[columnIndex].dataType = dataType;
    if (defaultValue !== undefined) template.customColumns[columnIndex].defaultValue = defaultValue;
    if (isRequired !== undefined) template.customColumns[columnIndex].isRequired = isRequired;
    if (placeholder !== undefined) template.customColumns[columnIndex].placeholder = placeholder;
    
    await template.save();
    await template.populate('createdBy', 'name email');
    
    res.json(template);
  } catch (error) {
    console.error('Error updating column:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete custom column
router.delete('/:id/columns/:columnName', requireAuth, async (req, res) => {
  try {
    const template = await ListingTemplate.findById(req.params.id);
    
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    template.customColumns = template.customColumns.filter(
      col => col.name !== req.params.columnName
    );
    
    await template.save();
    await template.populate('createdBy', 'name email');
    
    res.json(template);
  } catch (error) {
    console.error('Error deleting column:', error);
    res.status(500).json({ error: error.message });
  }
});

// Reorder custom columns
router.post('/:id/columns/reorder', requireAuth, async (req, res) => {
  try {
    const { columnOrders } = req.body; // Array of { name, order }
    
    const template = await ListingTemplate.findById(req.params.id);
    
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    columnOrders.forEach(({ name, order }) => {
      const column = template.customColumns.find(col => col.name === name);
      if (column) {
        column.order = order;
      }
    });
    
    await template.save();
    await template.populate('createdBy', 'name email');
    
    res.json(template);
  } catch (error) {
    console.error('Error reordering columns:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
