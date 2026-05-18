import express from 'express';
import { validate } from '../utils/validate.js';
import { createIdeaSchema, addIdeaCommentSchema } from '../schemas/index.js';
import Idea from '../models/Idea.js';
import { parsePagination, paginateQuery } from '../utils/paginate.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Ideas
 *   description: Internal idea and ticket tracking
 */

router.use(requireAuth);

/**
 * @swagger
 * /ideas:
 *   get:
 *     tags: [Ideas]
 *     summary: List all ideas with pagination and filters
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: query, name: status, schema: { type: string, enum: [open, in_progress, completed, rejected] } }
 *       - { in: query, name: priority, schema: { type: string, enum: [low, medium, high] } }
 *       - { in: query, name: type, schema: { type: string } }
 *       - { in: query, name: sortBy, schema: { type: string, default: createdAt } }
 *       - { in: query, name: sortOrder, schema: { type: string, enum: [asc, desc], default: desc } }
 *       - { in: query, name: page, schema: { type: integer, default: 1 } }
 *       - { in: query, name: limit, schema: { type: integer, default: 20 } }
 *     responses:
 *       200: { description: Paginated list of ideas }
 *       401: { description: Unauthorized }
 */
router.get('/', async (req, res) => {
  try {
    const { status, priority, type, sortBy = 'createdAt', sortOrder = 'desc' } = req.query;

    const query = {};
    if (status) query.status = status;
    if (priority) query.priority = priority;
    if (type) query.type = type;

    const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 50 });
    const sort = { [sortBy]: sortOrder === 'asc' ? 1 : -1 };

    const { data: ideas, pagination } = await paginateQuery(Idea, query, { page, limit, skip, sort });

    res.json({
      ideas,
      total: pagination.total,
      page: pagination.page,
      totalPages: pagination.totalPages,
      limit: pagination.limit
    });
  } catch (err) {
    console.error('Error fetching ideas:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get single idea by ID
// PUBLIC ROUTE
/**
 * @swagger
 * /ideas/{id}:
 *   get:
 *     tags: [Ideas]
 *     summary: Get a single idea by ID
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Idea object }
 *       404: { description: Idea not found }
 *       401: { description: Unauthorized }
 */
router.get('/:id', async (req, res) => {
  try {
    const idea = await Idea.findById(req.params.id).lean();
    if (!idea) {
      return res.status(404).json({ error: 'Idea not found' });
    }
    res.json(idea);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create new idea/ticket
// PUBLIC ROUTE - Anyone can submit
/**
 * @swagger
 * /ideas:
 *   post:
 *     tags: [Ideas]
 *     summary: Create a new idea or ticket
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title]
 *             properties:
 *               title: { type: string }
 *               description: { type: string }
 *               type: { type: string }
 *               priority: { type: string, enum: [low, medium, high] }
 *               submittedBy: { type: string }
 *     responses:
 *       201: { description: Created idea }
 *       400: { description: Validation error }
 *       401: { description: Unauthorized }
 */
router.post('/', validate(createIdeaSchema), async (req, res) => {
  try {
    const { title, description, type, priority, createdBy, completeByDate } = req.body;

    const newIdea = await Idea.create({
      title,
      description,
      type: type || 'idea',
      priority: priority || 'medium',
      createdBy,
      status: 'open',
      completeByDate: completeByDate || undefined
    });

    res.status(201).json(newIdea);
  } catch (err) {
    console.error('Error creating idea:', err);
    res.status(500).json({ error: err.message });
  }
});

// Update idea (status, priority, assignee, etc.)
// PUBLIC ROUTE - But you might want to restrict this later
/**
 * @swagger
 * /ideas/{id}:
 *   patch:
 *     tags: [Ideas]
 *     summary: Update idea fields
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               status: { type: string, enum: [open, in_progress, completed, rejected] }
 *               priority: { type: string, enum: [low, medium, high] }
 *               assignedTo: { type: string }
 *               pickedUpBy: { type: string, nullable: true }
 *               completeByDate: { type: string, format: date }
 *               notes: { type: string }
 *               resolvedBy: { type: string }
 *     responses:
 *       200: { description: Updated idea }
 *       404: { description: Idea not found }
 *       401: { description: Unauthorized }
 */
router.patch('/:id', async (req, res) => {
  try {
    const { status, priority, assignedTo, pickedUpBy, resolvedBy, completeByDate, notes } = req.body;
    
    console.log('PATCH /ideas/:id', { id: req.params.id, pickedUpBy });
    
    const updateData = {};
    if (status) updateData.status = status;
    if (priority) updateData.priority = priority;
    if (assignedTo) updateData.assignedTo = assignedTo;
    if (pickedUpBy !== undefined) updateData.pickedUpBy = pickedUpBy || null;
    if (completeByDate !== undefined) updateData.completeByDate = completeByDate;
    if (notes !== undefined) updateData.notes = notes;
    
    console.log('Update data:', updateData);
    
    if (status === 'completed' && !req.body.resolvedAt) {
      updateData.resolvedAt = new Date();
      if (resolvedBy) updateData.resolvedBy = resolvedBy;
    }

    const idea = await Idea.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    );

    if (!idea) {
      return res.status(404).json({ error: 'Idea not found' });
    }

    console.log('Updated idea pickedUpBy:', idea.pickedUpBy);
    res.json(idea);
  } catch (err) {
    console.error('Error updating idea:', err);
    res.status(500).json({ error: err.message });
  }
});

// Add comment to an idea
// PUBLIC ROUTE
/**
 * @swagger
 * /ideas/{id}/comments:
 *   post:
 *     tags: [Ideas]
 *     summary: Add a comment to an idea
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [text, commentedBy]
 *             properties:
 *               text: { type: string }
 *               commentedBy: { type: string }
 *     responses:
 *       200: { description: Updated idea with new comment }
 *       404: { description: Idea not found }
 *       401: { description: Unauthorized }
 */
router.post('/:id/comments', validate(addIdeaCommentSchema), async (req, res) => {
  try {
    const { text, commentedBy } = req.body;

    if (!text || !commentedBy) {
      return res.status(400).json({ error: 'Text and commentedBy are required' });
    }

    const idea = await Idea.findById(req.params.id);
    if (!idea) {
      return res.status(404).json({ error: 'Idea not found' });
    }

    idea.comments.push({
      text,
      commentedBy,
      commentedAt: new Date()
    });

    await idea.save();
    res.json(idea);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete idea
// PUBLIC ROUTE - But you might want to restrict this to admins only
/**
 * @swagger
 * /ideas/{id}:
 *   delete:
 *     tags: [Ideas]
 *     summary: Delete an idea
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Deletion confirmation }
 *       404: { description: Idea not found }
 *       401: { description: Unauthorized }
 */
router.delete('/:id', async (req, res) => {
  try {
    const idea = await Idea.findByIdAndDelete(req.params.id);
    if (!idea) {
      return res.status(404).json({ error: 'Idea not found' });
    }
    res.json({ message: 'Idea deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get statistics
// PUBLIC ROUTE
/**
 * @swagger
 * /ideas/stats/summary:
 *   get:
 *     tags: [Ideas]
 *     summary: Get idea board summary statistics
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200: { description: Counts by status and priority }
 *       401: { description: Unauthorized }
 */
router.get('/stats/summary', async (req, res) => {
  try {
    const [total, open, inProgress, completed, byPriority] = await Promise.all([
      Idea.countDocuments(),
      Idea.countDocuments({ status: 'open' }),
      Idea.countDocuments({ status: 'in-progress' }),
      Idea.countDocuments({ status: 'completed' }),
      Idea.aggregate([
        { $group: { _id: '$priority', count: { $sum: 1 } } }
      ])
    ]);

    const priorityMap = byPriority.reduce((acc, item) => {
      acc[item._id] = item.count;
      return acc;
    }, {});

    res.json({
      total,
      byStatus: { open, inProgress, completed },
      byPriority: {
        low: priorityMap.low || 0,
        medium: priorityMap.medium || 0,
        high: priorityMap.high || 0
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
