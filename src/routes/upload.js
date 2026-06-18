import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

// Ensure uploads directory exists
const uploadDir = path.join(process.cwd(), 'public/uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // Sanitize filename and add timestamp
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, uniqueSuffix + ext);
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

/**
 * @swagger
 * /upload:
 *   post:
 *     tags: [Upload]
 *     summary: Upload image files
 *     description: >
 *       Accepts up to **5 files** in a single request via `multipart/form-data` using the
 *       field name `files`. Each file must be ≤ 5 MB. Returns an array of absolute URLs
 *       pointing to the uploaded files served from `/uploads/`.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [files]
 *             properties:
 *               files:
 *                 type: array
 *                 maxItems: 5
 *                 items:
 *                   type: string
 *                   format: binary
 *                 description: Image files to upload (max 5, 5 MB each)
 *     responses:
 *       200:
 *         description: Upload successful — returns public URLs for each uploaded file
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 urls:
 *                   type: array
 *                   items:
 *                     type: string
 *                     format: uri
 *                   example:
 *                     - https://api.example.com/uploads/1716300000000-123456789.jpg
 *       400:
 *         description: No files provided
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Server error during upload
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/', requireAuth, upload.array('files', 5), (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const fileUrls = req.files.map(file => {
      // Return absolute URL
      const protocol = req.headers['x-forwarded-proto'] || req.protocol;
      const host = req.get('host');
      return `${protocol}://${host}/uploads/${file.filename}`;
    });

    res.json({ urls: fileUrls });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'File upload failed' });
  }
});

export default router;
