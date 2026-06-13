import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import UserCategoryTarget from '../models/UserCategoryTarget.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const serverRoot = join(__dirname, '..', '..');

dotenv.config({ path: join(serverRoot, '.env') });

async function run() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI or MONGODB_URI is required');

  await mongoose.connect(uri);

  const collection = UserCategoryTarget.collection;
  const indexes = await collection.indexes();
  await collection.updateMany(
    { marketplace: { $exists: false } },
    { $set: { marketplace: 'US' } }
  );
  console.log('Backfilled missing marketplace values to US');

  for (const index of indexes) {
    const isOldUniqueTargetIndex = (
      index.unique
      && index.name !== '_id_'
      && index.key?.user === 1
      && index.key?.seller === 1
      && index.key?.category === 1
      && (
        index.key?.marketplace === undefined
        || index.key?.range === undefined
      )
    );

    if (isOldUniqueTargetIndex) {
      await collection.dropIndex(index.name);
      console.log(`Dropped old index: ${index.name}`);
    }
  }

  await collection.createIndex(
    { user: 1, seller: 1, marketplace: 1, category: 1, range: 1 },
    { unique: true }
  );
  console.log('Ensured user/seller/marketplace/category/range unique index');

  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect();
  process.exit(1);
});
