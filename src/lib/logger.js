import winston from 'winston';
import { Logtail } from '@logtail/node';
import { LogtailTransport } from '@logtail/winston';

const { combine, timestamp, errors, json, colorize, simple } = winston.format;

const isProduction = process.env.NODE_ENV === 'production';

// Build transports array — always log to console, add BetterStack when token is present
const transports = [
  isProduction
    ? new winston.transports.Console({ format: combine(timestamp(), errors({ stack: true }), json()) })
    : new winston.transports.Console({ format: combine(colorize(), simple()) }),
];

if (process.env.BETTERSTACK_TOKEN) {
  const logtail = new Logtail(process.env.BETTERSTACK_TOKEN);
  transports.push(new LogtailTransport(logtail));
}

const logger = winston.createLogger({
  level: isProduction ? 'info' : 'debug',
  format: combine(timestamp(), errors({ stack: true }), json()),
  transports,
});

export default logger;
