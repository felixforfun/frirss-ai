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

function tagText(item: string, tag: string): string {
  const match = item.match(new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '\\s*>', 'i'));
  return match ? decodeXml(match[1]) : '';
}

function publisherLink(description: string): string | null {
  // Techmeme's RSS descriptions include the lead story as an anchor around an image.
  const html = decodeXml(description);
  const anchors = html.match(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi) || [];
  for (const anchor of anchors) {
    if (!/<img\b/i.test(anchor)) continue;
    const href = anchor.match(/\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
    const raw = decodeXml(href?.[1] || href?.[2] || href?.[3] || '');
    try {
      const url = new URL(raw);
      if ((url.protocol === 'https:' || url.protocol === 'http:') && !TECHMEME_HOSTS.has(url.hostname.toLowerCase())) {
        return url.toString();
      }
    } catch { /* ignore malformed RSS link */ }
  }
  return null;
}

function sameTechmemeStory(a: string, b: string): boolean {
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

router.get('/resolve', async (req, res) => {
  const rawUrl = typeof req.query.url === 'string' ? req.query.url : '';
  let requested: URL;
  try { requested = new URL(rawUrl); } catch { return res.status(400).json({ url: null }); }
  if (!TECHMEME_HOSTS.has(requested.hostname.toLowerCase())
    || !/^\/(?:\d{6}\/)?p\d+$/i.test(requested.pathname)
    || (requested.protocol !== 'https:' && requested.protocol !== 'http:')) {
    return res.status(400).json({ url: null });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
  try {
    const response = await fetch(TECHMEME_FEED_URL, {
      headers: { Accept: 'application/rss+xml, application/xml, text/xml' },
      signal: controller.signal,
    });
    if (!response.ok) return res.json({ url: null });
    const reader = response.body?.getReader();
    if (!reader) return res.json({ url: null });
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_FEED_BYTES) {
          await reader.cancel().catch(() => {});
          return res.json({ url: null });
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const xml = new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
    const items = xml.match(/<item\b[\s\S]*?<\/item\s*>/gi) || [];
    for (const item of items) {
      const permalink = tagText(item, 'link');
      if (!permalink || !sameTechmemeStory(permalink, requested.toString())) continue;
      const publisher = publisherLink(tagText(item, 'description'));
      if (publisher) return res.json({ url: publisher });
    }
    return res.json({ url: null });
  } catch {
    // Resolution is best-effort; the reader should fall back to the Techmeme URL.
    return res.json({ url: null });
  } finally {
    clearTimeout(timer);
  }
});

export default router;
