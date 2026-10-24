import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const TECHMEME_FEED_URL = 'https://www.techmeme.com/feed.xml?x=1';
const TECHMEME_HOSTS = new Set(['techmeme.com', 'www.techmeme.com']);
const FEED_TIMEOUT_MS = 5_000;
const MAX_FEED_BYTES = 2_000_000;

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .trim();
}

export function tagText(item: string, tag: string): string {
  const match = item.match(new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '\\s*>', 'i'));
  return match ? decodeXml(match[1]) : '';
}

function hrefOf(anchor: string): string | null {
  const match = anchor.match(/\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
  if (!match) return null;
  const url = nonTechmemeUrl(decodeXml(match[1] ?? match[2] ?? match[3] ?? ''));
  return url;
}

function nonTechmemeUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if ((url.protocol === 'https:' || url.protocol === 'http:') && !TECHMEME_HOSTS.has(url.hostname.toLowerCase())) {
      return url.toString();
    }
  } catch { /* ignore malformed RSS link */ }
  return null;
}

export function publisherLink(description: string): string | null {
  // Techmeme's RSS descriptions carry the lead publisher URL in one of two places.
  // Items with a lead photo wrap it in an anchor around an image; items without
  // one (paywalled outlets, social sources) only carry it inside the bold
  // headline anchor, so that structure is the fallback — without it, roughly a
  // fifth of the feed's items resolve to nothing and silently fall back to the
  // Techmeme wrapper page.
  const html = decodeXml(description);
  const anchors = html.match(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi) || [];
  for (const anchor of anchors) {
    if (!/<img\b/i.test(anchor)) continue;
    const found = hrefOf(anchor);
    if (found) return found;
  }
  const bolds = html.match(/<b\b[^>]*>([\s\S]*?)<\/b\s*>/gi) || [];
  for (const bold of bolds) {
    const headlineAnchors = bold.match(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi) || [];
    for (const anchor of headlineAnchors) {
      const found = hrefOf(anchor);
      if (found) return found;
    }
  }
  return null;
}

export function sameTechmemeStory(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    left.hash = '';
    right.hash = '';
    return TECHMEME_HOSTS.has(left.hostname.toLowerCase())
      && TECHMEME_HOSTS.has(right.hostname.toLowerCase())
      && left.pathname.replace(/\/$/, '') === right.pathname.replace(/\/$/, '');
  } catch {
    return false;
  }
}

export function isTechmemePermalink(rawUrl: string): URL | null {
  let requested: URL;
  try { requested = new URL(rawUrl); } catch { return null; }
  if (!TECHMEME_HOSTS.has(requested.hostname.toLowerCase())
    || !/^\/(?:\d{6}\/)?p\d+$/i.test(requested.pathname)
    || (requested.protocol !== 'https:' && requested.protocol !== 'http:')) {
    return null;
  }
  return requested;
}

/**
 * Resolve a validated Techmeme permalink against the live RSS feed by reading
 * the response the caller supplies: `fetchUpstream` returns the Response — the
 * route passes `fetch` itself, tests pass a stub.
 */
export async function resolveFromFeed(requested: URL, upstreamFeed: typeof fetch = fetch): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
  try {
    const response = await upstreamFeed(TECHMEME_FEED_URL, {
      headers: { Accept: 'application/rss+xml, application/xml, text/xml' },
      signal: controller.signal,
    });
    if (!response.ok) {
      console.warn('[techmeme] feed fetch failed with HTTP', response.status);
      return null;
    }
    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_FEED_BYTES) {
          await reader.cancel().catch(() => {});
          return null;
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const xml = new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
    const items = xml.match(/<item\b[\s\S]*?<\/item\s*>/gi) || [];
    let storyInFeed = false;
    for (const item of items) {
      const permalink = tagText(item, 'link');
      if (!permalink || !sameTechmemeStory(permalink, requested.toString())) continue;
      storyInFeed = true;
      const publisher = publisherLink(tagText(item, 'description'));
      if (publisher) return publisher;
    }
    // Diagnostics for misses, logged path-free: the access log deliberately
    // keeps URLs out of the journal, and this console line should too.
    console.warn(storyInFeed
      ? '[techmeme] resolve miss: RSS item has no publisher link'
      : '[techmeme] resolve miss: story not in feed');
    return null;
  } catch {
    // Resolution is best-effort; the reader should fall back to the Techmeme URL.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

router.get('/resolve', async (req, res) => {
  const rawUrl = typeof req.query.url === 'string' ? req.query.url : '';
  const requested = isTechmemePermalink(rawUrl);
  if (!requested) return res.status(400).json({ url: null });
  return res.json({ url: await resolveFromFeed(requested) });
});

export default router;
