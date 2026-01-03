import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import ColumnPreset from '../models/ColumnPreset.js';

const router = Router();

// GET all presets (shared across all users)
router.get('/', requireAuth, async (req, res) => {
  try {
    const presets = await ColumnPreset.find().sort({ name: 1 });
    res.json(presets);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// CREATE a new preset
router.post('/', requireAuth, async (req, res) => {
  const { name, columns } = req.body || {};
  if (!name || !columns) {
    return res.status(400).json({ error: 'name and columns required' });
  }
  try {
    const preset = await ColumnPreset.create({
      name,
      columns,
      createdBy: req.user._id
    });
    res.json(preset);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// DELETE a preset
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await ColumnPreset.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

export default router;
