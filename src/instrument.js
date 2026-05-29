import dotenv from 'dotenv';
import * as Sentry from '@sentry/node';

// Load env vars first so SENTRY_DSN is available
dotenv.config();

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || 'development',

  // Only active when DSN is provided — safe to deploy without it
  enabled: !!process.env.SENTRY_DSN,
});
