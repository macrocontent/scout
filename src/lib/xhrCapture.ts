import type { Page, Response } from 'playwright';

export type CapturedXhr = {
  url: string;
  method: string;
  status: number;
  resource_type: string;
  content_type: string | null;
  body: unknown;
  truncated: boolean;
};

export type XhrCaptureHandle = {
  items: () => CapturedXhr[];
  detach: () => void;
};

const MAX_ITEMS = 20;
const MAX_BODY_CHARS = 32_000;

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(escaped, 'i');
}

export function urlMatchesXhrPattern(url: string, pattern: string): boolean {
  const trimmed = pattern.trim();
  if (!trimmed) return false;
  try {
    return globToRegExp(trimmed).test(url);
  } catch {
    return url.toLowerCase().includes(trimmed.toLowerCase());
  }
}

async function readBody(response: Response): Promise<{ body: unknown; truncated: boolean }> {
  const contentType = (response.headers()['content-type'] || '').toLowerCase();
  try {
    const text = await response.text();
    const truncated = text.length > MAX_BODY_CHARS;
    const slice = truncated ? text.slice(0, MAX_BODY_CHARS) : text;
    if (contentType.includes('json') || slice.trim().startsWith('{') || slice.trim().startsWith('[')) {
      try {
        return { body: JSON.parse(slice), truncated };
      } catch {
        return { body: slice, truncated };
      }
    }
    return { body: slice, truncated };
  } catch {
    return { body: null, truncated: false };
  }
}

/**
 * Collect XHR/fetch responses whose URL matches `pattern` (substring or glob with *).
 */
export function attachXhrCapture(page: Page, pattern: string | undefined | null): XhrCaptureHandle {
  const captured: CapturedXhr[] = [];
  if (!pattern?.trim()) {
    return { items: () => [], detach: () => undefined };
  }

  const onResponse = async (response: Response) => {
    if (captured.length >= MAX_ITEMS) return;
    const req = response.request();
    const type = req.resourceType();
    if (type !== 'xhr' && type !== 'fetch') return;
    if (!urlMatchesXhrPattern(response.url(), pattern)) return;
    const { body, truncated } = await readBody(response);
    captured.push({
      url: response.url().slice(0, 2000),
      method: req.method(),
      status: response.status(),
      resource_type: type,
      content_type: response.headers()['content-type']?.slice(0, 200) ?? null,
      body,
      truncated,
    });
  };

  page.on('response', onResponse);
  return {
    items: () => captured.slice(),
    detach: () => {
      page.off('response', onResponse);
    },
  };
}
