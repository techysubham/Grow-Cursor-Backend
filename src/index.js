import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { connectToDatabase } from './lib/db.js';
import User from './models/User.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import platformRoutes from './routes/platforms.js';
import storeRoutes from './routes/stores.js';
import taskRoutes from './routes/tasks.js';
import rangeRoutes from './routes/ranges.js';
import categoryRoutes from './routes/categories.js';
import subcategoryRoutes from './routes/subcategories.js';

import assignmentsRouter from './routes/assignments.js';
import compatibilityRoutes from './routes/compatibility.js';
import listingCompletionsRoutes from './routes/listingCompletions.js';

import ebayRoutes from './routes/ebay.js';
import sellersRoutes from './routes/sellers.js';
import employeeProfilesRoutes from './routes/employeeProfiles.js';


dotenv.config();

const app = express();

app.use(helmet());
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use(morgan('dev'));

app.get('/health', (req, res) => {
  res.json({ ok: true });
});



app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/platforms', platformRoutes);
app.use('/api/stores', storeRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/ranges', rangeRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/subcategories', subcategoryRoutes);
app.use('/api/assignments', assignmentsRouter);
app.use('/api/compatibility', compatibilityRoutes);
app.use('/api/listing-completions', listingCompletionsRoutes);

app.use('/api/ebay', ebayRoutes);
app.use('/api/sellers', sellersRoutes);
app.use('/api/employee-profiles', employeeProfilesRoutes);


const port = process.env.PORT || 5000;

connectToDatabase()
  .then(async () => {
    // Ensure email index is sparse unique to allow multiple nulls
    try {
      // Drop existing non-sparse unique index if present
      await User.collection.dropIndex('email_1');
    } catch (e) {
      // Ignore if index does not exist
    }
    try {
      await User.collection.createIndex({ email: 1 }, { unique: true, sparse: true });
    } catch (e) {
      console.error('Failed to create sparse unique index on email:', e?.message || e);
    }

    app.listen(port, () => {
      console.log(`API listening on :${port}`);
    });
  })
  .catch((err) => {
    console.error('Failed to start server', err);
    process.exit(1);
  });


