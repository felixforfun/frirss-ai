import { createHash } from 'node:crypto';
import { parseHTML } from 'linkedom';

export const MAX_ARTICLE_TEXT_CHARS = 60_000;

export function normalizeAiEndpoint(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 2048) throw new Error('Invalid endpoint');
  const trimmed = raw.trim().replace(/\/+$/, '');
  let url: URL;
  try { url = new URL(trimmed); } catch { throw new Error('Invalid endpoint'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error('Invalid endpoint');
  }
  return url.toString().replace(/\/$/, '');
}

export function cleanArticleHtml(html: string): string {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  document.querySelectorAll('script, style, noscript, iframe, object, embed').forEach((node) => node.remove());
  document.querySelectorAll('br').forEach((node) => node.replaceWith(document.createTextNode('\n')));
  document.querySelectorAll('p, div, li, article, section, h1, h2, h3, h4, h5, h6, blockquote, tr').forEach((node) => {
    node.prepend(document.createTextNode('\n'));
    node.append(document.createTextNode('\n'));
  });
  return (document.body?.textContent ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[\t\r\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_ARTICLE_TEXT_CHARS);
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function aiContentHash(input: { title: string; url: string; content: string }): string {
  // Title and URL are sent to the model too, so changes to either invalidate the result.
  return digest(JSON.stringify(input));
}

export function aiConfigHash(input: { model: string; prompt: string; temperature: number }): string {
  return digest(JSON.stringify(input));
}
