import mongoose from 'mongoose';

const DEFAULT_MAX_POOL_SIZE = 5;
const DEFAULT_MIN_POOL_SIZE = 1;

function readPoolSizeEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

const CONNECTION_OPTIONS = {
  autoIndex: true,
  maxPoolSize: readPoolSizeEnv('MONGO_MAX_POOL_SIZE', DEFAULT_MAX_POOL_SIZE),
  minPoolSize: readPoolSizeEnv('MONGO_MIN_POOL_SIZE', DEFAULT_MIN_POOL_SIZE),
  serverSelectionTimeoutMS: 10000,
  heartbeatFrequencyMS: 10000,
  socketTimeoutMS: 45000,
};

let connectionPromise = null;
let eventsRegistered = false;

function registerConnectionEvents() {
  if (eventsRegistered) return;
  eventsRegistered = true;

  const conn = mongoose.connection;

  conn.on('connected', () => {
    console.log('[DB] MongoDB connected');
  });

  conn.on('disconnected', () => {
    console.warn('[DB] MongoDB disconnected. The MongoDB driver will retry automatically.');
  });

  conn.on('error', (err) => {
    console.error('[DB] MongoDB connection error:', err.message);
  });
}

export async function connectToDatabase() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set');

  registerConnectionEvents();

  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  if (connectionPromise) {
    await connectionPromise;
    return mongoose.connection;
  }

  connectionPromise = mongoose.connect(uri, CONNECTION_OPTIONS)
    .catch((err) => {
      connectionPromise = null;
      throw err;
    });

  await connectionPromise;
  return mongoose.connection;
}
