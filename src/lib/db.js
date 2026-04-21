import mongoose from 'mongoose';

export async function connectToDatabase() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set');

  const dbName = process.env.MONGODB_DB || undefined;
  const options = {
    autoIndex: true,
    // Fail fast if primary cannot be selected
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 45000,
    family: 4,
    dbName,
  };

  try {
    await mongoose.connect(uri, options);
    return mongoose.connection;
  } catch (err) {
    console.error('MongoDB connection error:');
    // Log helpful topology info when available
    if (err?.reason) console.error('Reason:', err.reason);
    console.error(err);
    throw err;
  }
}


