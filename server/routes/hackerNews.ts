import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import db from '../db.js';

const router = Router();
router.use(requireAuth);

const ALGOLIA_SEARCH_URL = 'https://hn.algolia.com/api/v1/search';
const ALGOLIA_TIMEOUT_MS = 5_000;
const MAX_ALGOLIA_BYTES = 2_000_000;
const ALGOLIA_HITS_PER_PAGE = 50;
/** Une discussion peut être soumise PLUS TARD : un résultat négatif expire. */
const NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Résolution de la discussion Hacker News d'un article.
 *
 * Le flux FreshRSS « Hacker News » publie des items SANS identifiant HN :
 * `article.url` est le lien éditeur, et l'ancre « Comments » qui portait
 * l'identifiant est perdue dès que `af-readability` a extrait la page éditeur
 * à l'insertion (voir `src/lib/hackerNews.ts`). La correspondance
 * (URL éditeur → item HN) est stable, donc résolue ICI une seule fois via
 * l'API Algolia HN Search — JAMAIS devinée : une réponse ne vaut que si l'URL
 * du hit retourné EST l'URL demandée, à équivalence stricte près (protocole
 * http/https, sous-domaine `www.`, slash final, fragment). Sans hit exact,
 * l'absence est mémorisée (négatif) avec expiration — une discussion peut
 * être soumise plus tard.
 */

/** Clé d'identité d'une URL story : hôte normalisé + chemin + query triée.
 * Les paramètres de suivi (utm_*, gclid…) sont ignorés : pure tracking, jamais
 * porteurs d'identité — l'URL demandée et l'URL du hit Algolia doivent malgré
 * leurs variantes de suivi désigner le même story. */
export function storyKey(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const pairs = [...url.searchParams.entries()]
      .filter(([name]) => !TRACKING_PARAMS.test(name))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const search = pairs.map(([k, v]) => `${k}=${v}`).join('&');
    return `${host}${path}${search ? `?${search}` : ''}`;
  } catch {
    return null;
  }
}

/** Deux URLs désignent-elles le même story ? (voir `storyKey`) */
export function sameStoryUrl(a: string, b: string): boolean {
  const keyA = storyKey(a);
  const keyB = storyKey(b);
  return keyA !== null && keyA === keyB;
}

/** L'URL demandée est-elle résolvable ? Un item HN lui-même n'a rien à résoudre. */
export function isResolvableStoryUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return !/(^|\.)news\.ycombinator\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
}

interface AlgoliaHit {
  objectID?: string;
  url?: string | null;
}

/** Paramètres de suivi — jamais porteurs d'identité de story (voir `storyKey`). */
const TRACKING_PARAMS = /^(?:utm|gclid|fbclid|mc_cid|mc_eid|ref_src|igshid|spm)/i;

/**
 * Recherche Algolia HN par URL d'éditeur. `fetchAlgolia` est injectable :
 * la route passe `fetch` lui-même, les tests passent un stub.
 */
export async function resolveFromAlgolia(
  requestedUrl: string,
  fetchAlgolia: typeof fetch = fetch,
): Promise<string | null> {
  const endpoint = `${ALGOLIA_SEARCH_URL}?query=${encodeURIComponent(requestedUrl)}`
    + `&restrictSearchableAttributes=url&tags=story&hitsPerPage=${ALGOLIA_HITS_PER_PAGE}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ALGOLIA_TIMEOUT_MS);
  try {
    const response = await fetchAlgolia(endpoint, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      console.warn('[hackerNews] Algolia fetch failed with HTTP', response.status);
      throw new Error('algolia-unavailable');
    }
    const text = await response.text();
    if (text.length > MAX_ALGOLIA_BYTES) throw new Error('algolia-response-too-large');
    let payload: { hits?: AlgoliaHit[] };
    try {
      payload = JSON.parse(text) as { hits?: AlgoliaHit[] };
    } catch {
      throw new Error('algolia-invalid-json');
    }
    const hits = Array.isArray(payload.hits) ? payload.hits : [];
    for (const hit of hits) {
      if (typeof hit.objectID !== 'string' || !/^\d+$/.test(hit.objectID)) continue;
      if (typeof hit.url !== 'string' || !hit.url) continue;
      if (sameStoryUrl(hit.url, requestedUrl)) {
        return `https://news.ycombinator.com/item?id=${hit.objectID}`;
      }
    }
    console.warn('[hackerNews] resolve miss: no Algolia hit carries the exact story URL');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Une même URL demandée en rafale (plusieurs lignes rendues en même temps)
// ne doit déclencher qu'UNE résolution : les appels concurrents partagent
// la promesse en vol.
const inFlight = new Map<string, Promise<{ url: string | null; cached: boolean }>>();

async function resolveAndCache(key: string, requestedUrl: string): Promise<{ url: string | null; cached: boolean }> {
  let discussionUrl: string | null;
  try {
    discussionUrl = await resolveFromAlgolia(requestedUrl);
  } catch {
    // Indisponibilité transitoire : RIEN n'est écrit — un échec réseau ne
    // doit jamais être confondu avec « pas de discussion ».
    throw new Error('resolver-unavailable');
  }
  db.prepare(
    'INSERT INTO hn_discussions (url, item_id, resolved_at) VALUES (?, ?, datetime(\'now\')) ' +
    'ON CONFLICT(url) DO UPDATE SET item_id = excluded.item_id, resolved_at = excluded.resolved_at'
  ).run(key, discussionUrl ? new URL(discussionUrl).searchParams.get('id') : null);
  return { url: discussionUrl, cached: false };
}

router.get('/resolve', async (req, res) => {
  const rawUrl = typeof req.query.url === 'string' ? req.query.url : '';
  if (!isResolvableStoryUrl(rawUrl)) {
    return res.status(400).json({ url: null });
  }
  const key = storyKey(rawUrl)!;

  // Mapping persistant d'abord : un item quitte la première page du flux
  // rapidement, mais la discussion existe toujours. Les positifs vivent sans
  // limite ; les négatifs expirent — une discussion peut être soumise plus tard.
  const cached = db.prepare('SELECT item_id, resolved_at FROM hn_discussions WHERE url = ?').get(key) as { item_id: string | null; resolved_at: string } | undefined;
  if (cached && (cached.item_id !== null || Date.now() - Date.parse(cached.resolved_at.replace(' ', 'T') + 'Z') < NEGATIVE_TTL_MS)) {
    return res.json({
      url: cached.item_id ? `https://news.ycombinator.com/item?id=${cached.item_id}` : null,
      cached: true,
    });
  }

  const attempt = inFlight.get(key) ?? resolveAndCache(key, rawUrl).finally(() => { inFlight.delete(key); });
  if (!inFlight.has(key)) inFlight.set(key, attempt);
  try {
    return res.json(await attempt);
  } catch {
    return res.status(503).json({ url: null, error: 'resolver-unavailable' });
  }
});

export default router;
