import mongoose from 'mongoose';

const CONNECTION_OPTIONS = {
  autoIndex: true,
  maxPoolSize: 10,
  minPoolSize: 2,
  serverSelectionTimeoutMS: 5000,
  heartbeatFrequencyMS: 10000,
  socketTimeoutMS: 45000,
};

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 3000;

let retryCount = 0;

function registerConnectionEvents() {
  const conn = mongoose.connection;

  conn.on('connected', () => {
    retryCount = 0;
    console.log('[DB] MongoDB connected');
  });

  conn.on('disconnected', () => {
    console.warn('[DB] MongoDB disconnected — attempting reconnect...');
    scheduleReconnect();
  });

  conn.on('error', (err) => {
    console.error('[DB] MongoDB connection error:', err.message);
  });
}

function scheduleReconnect() {
  if (retryCount >= MAX_RETRIES) {
    console.error(`[DB] Max reconnect attempts (${MAX_RETRIES}) reached. Giving up.`);
    return;
  }
  retryCount += 1;
  const delay = RETRY_DELAY_MS * retryCount;
  console.warn(`[DB] Reconnect attempt ${retryCount}/${MAX_RETRIES} in ${delay}ms...`);
  setTimeout(async () => {
    try {
      await mongoose.connect(process.env.MONGODB_URI, CONNECTION_OPTIONS);
    } catch (err) {
      console.error('[DB] Reconnect failed:', err.message);
    }
  }, delay);
}

export async function connectToDatabase() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set');
  registerConnectionEvents();
  await mongoose.connect(uri, CONNECTION_OPTIONS);
  return mongoose.connection;
}


