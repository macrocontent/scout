import type { Page } from 'playwright';
import { pageEvaluate } from '../browser/playwrightEvaluate';

export type FileLink = {
  href: string;
  text: string;
  extension: string | null;
  mime_hint: string | null;
};

const FILE_EXT = /\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|csv|tsv|txt|rtf|odt|ods|odp|epub|mp3|mp4|webm|gz|tgz)(?:[?#]|$)/i;

export async function collectFileLinks(page: Page): Promise<FileLink[]> {
  return pageEvaluate(page, (extSource) => {
    const re = new RegExp(extSource, 'i');
    const out: FileLink[] = [];
    const seen = new Set<string>();
    document.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute('href') || '';
      let absolute = href;
      try {
        absolute = new URL(href, location.href).toString();
      } catch {
        return;
      }
      const match = absolute.match(re);
      if (!match) return;
      if (seen.has(absolute)) return;
      seen.add(absolute);
      const ext = (match[1] || '').toLowerCase();
      out.push({
        href: absolute,
        text: (a.textContent || '').trim().slice(0, 200),
        extension: ext || null,
        mime_hint: ext === 'pdf' ? 'application/pdf' : null,
      });
    });
    return out.slice(0, 200);
  }, FILE_EXT.source);
}

export async function extractPdfTextFromUrl(pdfUrl: string, maxPages = 20): Promise<{
  url: string;
  page_count: number | null;
  text: string;
  truncated: boolean;
  error: string | null;
}> {
  try {
    const res = await fetch(pdfUrl, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      return {
        url: pdfUrl,
        page_count: null,
        text: '',
        truncated: false,
        error: `HTTP ${res.status}`,
      };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    // Prefer pdf-parse when available
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pdfParse = require('pdf-parse') as (b: Buffer) => Promise<{
        text: string;
        numpages: number;
      }>;
      const parsed = await pdfParse(buf);
      const pages = parsed.numpages ?? null;
      let text = parsed.text || '';
      let truncated = false;
      if (pages && pages > maxPages) {
        // pdf-parse gives full text; truncate by char budget instead
        const limit = maxPages * 4000;
        if (text.length > limit) {
          text = text.slice(0, limit);
          truncated = true;
        }
      }
      if (text.length > 80_000) {
        text = text.slice(0, 80_000);
        truncated = true;
      }
      return {
        url: pdfUrl,
        page_count: pages,
        text,
        truncated,
        error: null,
      };
    } catch (err) {
      // Fallback: extract readable strings from PDF bytes (no OCR)
      const raw = buf.toString('latin1');
      const chunks: string[] = [];
      const re = /\((?:\\.|[^\\)]){3,}\)|\((?:\\.|[^\\)])*\)\s*Tj/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(raw)) && chunks.length < 2000) {
        const inner = m[0].replace(/^\(|\)\s*Tj?$/g, '').replace(/\\([nrt\\()])/g, (_, c) => {
          if (c === 'n') return '\n';
          if (c === 'r') return '\r';
          if (c === 't') return '\t';
          return c;
        });
        if (/[A-Za-zÄÖÜäöüß0-9]/.test(inner)) chunks.push(inner);
      }
      let text = chunks.join(' ').replace(/\s+/g, ' ').trim();
      let truncated = false;
      if (text.length > 80_000) {
        text = text.slice(0, 80_000);
        truncated = true;
      }
      return {
        url: pdfUrl,
        page_count: null,
        text,
        truncated,
        error: text
          ? `pdf-parse unavailable (${err instanceof Error ? err.message : String(err)}); used naive extract`
          : err instanceof Error
            ? err.message
            : String(err),
      };
    }
  } catch (err) {
    return {
      url: pdfUrl,
      page_count: null,
      text: '',
      truncated: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
