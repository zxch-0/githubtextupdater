/** Application error carrying an HTTP status + machine readable code for the UI. */
export class AppError extends Error {
  constructor(status, code, message, details, retryAfter) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfter = retryAfter;
  }

  static badRequest(code, message, details) {
    return new AppError(400, code, message, details);
  }

  static unauthorized(code, message, details) {
    return new AppError(401, code, message, details);
  }

  static forbidden(code, message, details) {
    return new AppError(403, code, message, details);
  }

  static notFound(code, message, details) {
    return new AppError(404, code, message, details);
  }

  static conflict(code, message, details) {
    return new AppError(409, code, message, details);
  }

  static tooMany(code, message, details, retryAfter) {
    return new AppError(429, code, message, details, retryAfter);
  }
}

/** Error returned by the GitHub REST API. */
export class GitHubError extends Error {
  constructor(status, message, { code = 'github_error', body, docsUrl, resetAt, retryAfterSeconds } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.code = code;
    this.body = body;
    this.docsUrl = docsUrl;
    this.resetAt = resetAt;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const GITHUB_MESSAGES = {
  401: 'GitHub rejected the token (401). It is invalid, expired or revoked.',
  403: 'GitHub refused the request (403). The token is missing the "Contents" and "Pull requests" write permissions, or the repo requires SSO authorisation.',
  404: 'Not found on GitHub (404). Check the repository name and that the token can see it. Fine-grained tokens must be granted access to this repository explicitly.',
  405: 'GitHub refused the operation (405).',
  409: 'Conflict with the current state of the repository (409).',
  422: 'GitHub rejected the payload (422).',
};

/** Translate a GitHubError into a friendly AppError (kept for consistent UI wording). */
export function toAppError(err) {
  if (err instanceof AppError) return err;
  if (!(err instanceof GitHubError)) return err;

  const status = err.status;
  if (err.code === 'rate_limited') {
    const when = err.resetAt ? new Date(err.resetAt).toUTCString() : 'soon';
    const retryAfter =
      err.retryAfterSeconds ?? (err.resetAt ? Math.max(1, Math.ceil((err.resetAt - Date.now()) / 1000)) : undefined);
    return AppError.tooMany(
      'github_rate_limited',
      `GitHub rate limit reached. Resets at ${when}. Wait before retrying, or use a token with more quota.`,
      { resetAt: err.resetAt },
      retryAfter,
    );
  }
  if (status === 0) {
    return new AppError(502, 'github_unavailable', `Could not reach GitHub (${err.message}).`);
  }
  if (status === 401) return AppError.unauthorized('github_unauthorized', GITHUB_MESSAGES[401]);
  if (status === 403) return AppError.forbidden('github_forbidden', GITHUB_MESSAGES[403], { body: err.body });
  if (status === 404) return AppError.notFound('github_not_found', GITHUB_MESSAGES[404], { body: err.body });
  if (status === 409) return AppError.conflict('github_conflict', err.message, { body: err.body });
  if (status === 422) return AppError.badRequest('github_unprocessable', err.message, { body: err.body });
  if (status >= 500) return new AppError(502, 'github_unavailable', 'GitHub is temporarily unavailable. Try again in a moment.');
  return new AppError(status >= 400 ? status : 500, 'github_error', err.message);
}
