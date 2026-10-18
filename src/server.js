import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { AppError } from './errors.js';
import { logger } from './logger.js';
import { rateLimit } from './rateLimit.js';
import apiRouter from './routes/api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(value);
  }
  return out;
}

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');

app.use((req, _res, next) => {
  req.cookies = parseCookies(req.headers.cookie);
  next();
});

app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

app.get(['/healthz', '/api/health'], (_req, res) => {
  res.json({ ok: true, service: 'github-text-updater', uptime: Math.round(process.uptime()) });
});

app.use('/api', rateLimit({ windowMs: config.rateLimit.windowMs, max: config.rateLimit.max }));
app.use(
  '/api',
  rateLimit({
    windowMs: config.rateLimit.windowMs,
    max: config.rateLimit.writeMax,
    methods: ['POST', 'PUT', 'PATCH', 'DELETE'],
    keyPrefix: 'write:',
  }),
);
app.use('/api', apiRouter);

app.use(
  express.static(publicDir, {
    index: 'index.html',
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
      else res.setHeader('Cache-Control', 'public, max-age=3600');
    },
  }),
);

app.use('/api', (_req, res) => {
  res.status(404).json({ error: { code: 'not_found', message: 'Unknown API route.' } });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  const code = err.code || 'internal_error';
  const message = status === 500 ? 'Unexpected server error.' : err.message;

  if (status >= 500) logger.error('unhandled error', { code, message: err.message, stack: err.stack });
  else logger.debug('request error', { code, message: err.message, status });

  res.status(status).json({ error: { code, message, details: err.details } });
});

const server = app.listen(config.port, '0.0.0.0', () => {
  logger.info('listening', { port: config.port, env: config.isProduction ? 'production' : 'development' });
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    logger.info('shutting down', { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

export default app;
