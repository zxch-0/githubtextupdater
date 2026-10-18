import process from 'node:process';

const DEV_FALLBACK_SECRET = 'github-text-updater-dev-secret-do-not-use-in-production';

const isProduction = process.env.NODE_ENV === 'production' || Boolean(process.env.RENDER);

function requiredInProd(value, name, fallback) {
  if (value && value.length > 0) return value;
  if (isProduction) {
    // eslint-disable-next-line no-console
    console.warn(`[config] WARNING: ${name} is not set, falling back to an insecure default.`);
  }
  return fallback;
}

export const config = {
  isProduction,
  port: Number(process.env.PORT || 3000),
  sessionSecret: requiredInProd(process.env.SESSION_SECRET, 'SESSION_SECRET', DEV_FALLBACK_SECRET),
  sessionTtlMs: Number(process.env.SESSION_TTL_MS || 8 * 60 * 60 * 1000), // 8h
  logLevel: (process.env.LOG_LEVEL || 'info').toLowerCase(),
  githubApiBase: process.env.GITHUB_API_BASE || 'https://api.github.com',
  githubTimeoutMs: Number(process.env.GITHUB_TIMEOUT_MS || 30_000),

  // Limits for the pasted specification.
  limits: {
    specBytes: Number(process.env.MAX_SPEC_BYTES || 4 * 1024 * 1024), // 4 MiB of pasted text
    files: Number(process.env.MAX_FILES || 200),
    fileBytes: Number(process.env.MAX_FILE_BYTES || 1024 * 1024), // 1 MiB per file body
    blobInlineBytes: 900 * 1024, // above this we push a blob first instead of inlining in the tree
  },

  rateLimit: {
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000),
    max: Number(process.env.RATE_LIMIT_MAX || 240),
    writeMax: Number(process.env.RATE_LIMIT_WRITE_MAX || 60),
  },
};

export const COOKIE_NAME = 'gtu_session';
