export type ScoutErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHORIZED'
  | 'RATE_LIMITED'
  | 'DOMAIN_NOT_VERIFIED'
  | 'DOMAIN_VERIFY_EXPIRED'
  | 'STEALTH_TIER_NOT_ALLOWED'
  | 'ROBOTS_BLOCKED'
  | 'INVALID_URL'
  | 'PRIVATE_NETWORK_BLOCKED'
  | 'DNS_FAILED'
  | 'TIMEOUT'
  | 'NAVIGATION_FAILED'
  | 'HTTP_FORBIDDEN'
  | 'HTTP_TOO_MANY_REQUESTS'
  | 'HTTP_ERROR'
  | 'SELECTOR_NOT_FOUND'
  | 'CAPTCHA_DETECTED'
  | 'CAPTCHA_SOLVER_UNAVAILABLE'
  | 'CAPTCHA_SOLVE_FAILED'
  | 'BROWSER_UNAVAILABLE'
  | 'TEMPLATE_NOT_FOUND'
  | 'CREDITS_EXHAUSTED'
  | 'LICENSE_INVALID'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'INTERNAL_ERROR';

export type ScoutErrorBody = {
  error: string;
  code: ScoutErrorCode;
  retryable: boolean;
  details?: Record<string, unknown>;
  captcha_detected?: boolean;
};

const RETRYABLE: Partial<Record<ScoutErrorCode, boolean>> = {
  RATE_LIMITED: true,
  TIMEOUT: true,
  DNS_FAILED: true,
  NAVIGATION_FAILED: true,
  HTTP_TOO_MANY_REQUESTS: true,
  HTTP_ERROR: true,
  BROWSER_UNAVAILABLE: true,
  CAPTCHA_SOLVE_FAILED: true,
  INTERNAL_ERROR: true,
};

export class ScoutError extends Error {
  readonly code: ScoutErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;
  readonly captchaDetected?: boolean;

  constructor(
    code: ScoutErrorCode,
    message: string,
    options?: { status?: number; details?: Record<string, unknown>; captchaDetected?: boolean },
  ) {
    super(message);
    this.name = 'ScoutError';
    this.code = code;
    this.status = options?.status ?? defaultStatus(code);
    this.details = options?.details;
    this.captchaDetected = options?.captchaDetected;
  }

  toJSON(): ScoutErrorBody {
    return {
      error: this.message,
      code: this.code,
      retryable: RETRYABLE[this.code] ?? false,
      details: this.details,
      captcha_detected: this.captchaDetected,
    };
  }
}

function defaultStatus(code: ScoutErrorCode): number {
  switch (code) {
    case 'VALIDATION_FAILED':
    case 'INVALID_URL':
    case 'ROBOTS_BLOCKED':
    case 'SELECTOR_NOT_FOUND':
      return 400;
    case 'UNAUTHORIZED':
      return 401;
    case 'DOMAIN_NOT_VERIFIED':
    case 'DOMAIN_VERIFY_EXPIRED':
    case 'STEALTH_TIER_NOT_ALLOWED':
    case 'FORBIDDEN':
      return 403;
    case 'NOT_FOUND':
    case 'TEMPLATE_NOT_FOUND':
      return 404;
    case 'RATE_LIMITED':
    case 'HTTP_TOO_MANY_REQUESTS':
      return 429;
    case 'CREDITS_EXHAUSTED':
      return 402;
    case 'CAPTCHA_DETECTED':
      return 422;
    case 'TIMEOUT':
      return 504;
    case 'BROWSER_UNAVAILABLE':
    case 'DNS_FAILED':
    case 'NAVIGATION_FAILED':
    case 'HTTP_FORBIDDEN':
    case 'HTTP_ERROR':
    case 'PRIVATE_NETWORK_BLOCKED':
      return 502;
    default:
      return 500;
  }
}

export function classifyThrownError(err: unknown): ScoutError {
  if (err instanceof ScoutError) return err;

  if (err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string') {
    const e = err as { code: string; message?: string; status?: number; hostname?: string };
    const code = (e.code as ScoutErrorCode) || 'INTERNAL_ERROR';
    return new ScoutError(code, e.message || 'Request failed', {
      status: e.status,
      details: e.hostname ? { hostname: e.hostname } : undefined,
    });
  }

  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  if (
    message.includes("Executable doesn't exist")
    || message.includes('browserType.launch')
    || message.includes('chrome-headless-shell')
  ) {
    return new ScoutError(
      'BROWSER_UNAVAILABLE',
      'Scout browser unavailable (Playwright Chromium not installed). Run: pnpm --filter macro-scout browser:install',
    );
  }
  if (lower.includes('robots.txt')) {
    return new ScoutError('ROBOTS_BLOCKED', message, { status: 400 });
  }
  if (lower.includes('domain verification expired')) {
    return new ScoutError('DOMAIN_VERIFY_EXPIRED', message, { status: 403 });
  }
  if (lower.includes('domain not verified')) {
    return new ScoutError('DOMAIN_NOT_VERIFIED', message, { status: 403 });
  }
  if (lower.includes('not allowed') || lower.includes('private') || lower.includes('ssrf')) {
    return new ScoutError('PRIVATE_NETWORK_BLOCKED', message, { status: 400 });
  }
  if (lower.includes('invalid url')) {
    return new ScoutError('INVALID_URL', message, { status: 400 });
  }
  if (lower.includes('timeout') || lower.includes('timed out')) {
    return new ScoutError('TIMEOUT', message, { status: 504 });
  }
  if (lower.includes('net::err_name_not_resolved') || lower.includes('enotfound') || lower.includes('dns')) {
    return new ScoutError('DNS_FAILED', message, { status: 502 });
  }
  if (lower.includes('403') || lower.includes('forbidden')) {
    return new ScoutError('HTTP_FORBIDDEN', message, { status: 502 });
  }
  if (lower.includes('429') || lower.includes('too many requests')) {
    return new ScoutError('HTTP_TOO_MANY_REQUESTS', message, { status: 429 });
  }
  if (lower.includes('selector') && (lower.includes('not found') || lower.includes('waiting for'))) {
    return new ScoutError('SELECTOR_NOT_FOUND', message, { status: 400 });
  }
  if (lower.includes('navigation') || lower.includes('net::')) {
    return new ScoutError('NAVIGATION_FAILED', message, { status: 502 });
  }

  return new ScoutError('INTERNAL_ERROR', message.slice(0, 240), { status: 502 });
}

export function sendScoutError(res: { status: (n: number) => { json: (b: unknown) => void } }, err: unknown): void {
  const scoutErr = classifyThrownError(err);
  res.status(scoutErr.status).json(scoutErr.toJSON());
}
