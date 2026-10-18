/** Tiny in-memory sliding window rate limiter (single instance friendly). */
export function rateLimit({ windowMs = 60_000, max = 120, methods = null, keyPrefix = '' } = {}) {
  const hits = new Map();

  return function rateLimitMiddleware(req, res, next) {
    if (methods && !methods.includes(req.method)) {
      next();
      return;
    }
    const key = `${keyPrefix}${req.ip || req.socket?.remoteAddress || 'unknown'}`;
    const now = Date.now();
    const bucket = (hits.get(key) || []).filter((ts) => now - ts < windowMs);
    bucket.push(now);
    hits.set(key, bucket);

    if (bucket.length > max) {
      const retryAfter = Math.ceil((windowMs - (now - bucket[0])) / 1000);
      res.set('Retry-After', String(Math.max(retryAfter, 1)));
      res.status(429).json({
        error: { code: 'rate_limited', message: 'Too many requests, slow down a little.' },
      });
      return;
    }

    // Opportunistic cleanup so the map does not grow forever.
    if (hits.size > 5000) {
      for (const [k, v] of hits) {
        if (v.every((ts) => now - ts >= windowMs)) hits.delete(k);
      }
    }
    next();
  };
}
