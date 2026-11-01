import type { Article } from '../types';
import { resolveHackerNewsDiscussionUrl } from '../api/backend';

/**
 * Lien de discussion Hacker News d'un article.
 *
 * Le flux FreshRSS « Hacker News » (news.ycombinator.com/rss) publie des items
 * sans identifiant HN explicite : FreshRSS sert
 *
 *  - `article.url` = le lien du story chez l'éditeur (parfois l'item HN
 *    lui-même, p. ex. les self-posts) ;
 *  - `article.content` = la description du flux, qui n'est qu'une ancre
 *    `<a href="https://news.ycombinator.com/item?id=…">Comments</a>`.
 *    ATTENTION : quand l'extension FreshRSS `af-readability` a extrait la
 *    page de l'éditeur à l'insertion, cette ancre est PEERDUE — le contenu
 *    porte alors l'article complet, sans trace de l'item HN.
 *
 * L'identifiant ne peut donc venir que de deux sources déjà reçues du flux :
 * l'`url` (quand l'item pointe lui-même vers HN) ou le contenu (quand l'ancre
 * a survécu). Aucune des deux ne peut être devinée : sans identifiant fiable,
 * `hackerNewsDiscussionUrl` renvoie `null` et l'interface ne rend RIEN — c'est
 * la règle de secours assumée (pas de héros, pas d'appel réseau supplémentaire).
 */

const HN_ITEM_URL = /^https?:\/\/(?:www\.)?news\.ycombinator\.com\/item\?id=(\d+)$/;
/** URL d'item HN dans du HTML (l'ancre « Comments » du flux ; préfixe, pas URL complète). */
const HN_ITEM_URL_IN_HTML = /https?:\/\/(?:www\.)?news\.ycombinator\.com\/item\?id=(\d+)/i;

/** Identifiant numérique d'un item HN porté par une URL `item?id=…`, où `null`. */
export function hackerNewsItemIdFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = HN_ITEM_URL.exec(url.trim());
  return match ? match[1] : null;
}

/** Identifiant d'item HN porté par le contenu de l'article, où `null`. */
export function hackerNewsItemIdFromContent(content: string | null | undefined): string | null {
  if (!content) return null;
  const match = HN_ITEM_URL_IN_HTML.exec(content);
  return match ? match[1] : null;
}

/**
 * L'article vient-il du flux Hacker News ? Deux signes, définis par les
 * métadonnées du flux : le nom de la source (le titre du flux) ou une `url`
 * qui pointe elle-même vers news.ycombinator.com.
 */
export function isHackerNewsArticle(article: Pick<Article, 'source' | 'url'>): boolean {
  return /hacker\s*news/i.test(article.source) || hackerNewsItemIdFromUrl(article.url) !== null;
}

/**
 * URL officielle de la discussion HN (`https://news.ycombinator.com/item?id=…`),
 * jamais dérivée d'une autre URL ni devinée : hors du flux HN, ou sans
 * identifiant fiable, `null` — l'appelant ne rend alors RIEN.
 *
 * L'identifiant peut aussi avoir été RÉSOLU par le serveur (mapping persistant
 * URL éditeur → item HN, voir `resolveDiscussion`) : le store l'écrit alors
 * dans `article.hnDiscussionUrl`, qui prime ici.
 */
export function hackerNewsDiscussionUrl(article: Pick<Article, 'source' | 'url' | 'content' | 'hnDiscussionUrl'>): string | null {
  if (!isHackerNewsArticle(article)) return null;
  const id = hackerNewsItemIdFromUrl(article.url) ?? hackerNewsItemIdFromContent(article.content);
  if (id) return `https://news.ycombinator.com/item?id=${id}`;
  return article.hnDiscussionUrl ?? null;
}

// ── Résolution serveur (URL éditeur → discussion HN) ─────────────────
//
// L'ancre « Comments » porteuse de l'identifiant est perdue dès que
// `af-readability` a extrait la page éditeur à l'insertion — la majorité des
// items du flux. Le store résout alors ces articles une fois (voir
// `primeHackerNewsDiscussion`), le serveur répond depuis son mapping
// persistant, et le résultat est écrit sur `article.hnDiscussionUrl`.

/** Résolutions déjà obtenues, par URL story — jamais deux appels réseau. */
const resolved = new Map<string, string | null>();
const inFlight = new Map<string, Promise<string | null>>();

function storyKey(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    // Paramètres de suivi ignorés (voir le même filtre côté serveur) : pure
    // tracking, jamais porteurs d'identité de story.
    const pairs = [...url.searchParams.entries()]
      .filter(([name]) => !/^(?:utm|gclid|fbclid|mc_cid|mc_eid|ref_src|igshid|spm)/i.test(name))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const search = pairs.map(([k, v]) => `${k}=${v}`).join('&');
    return `${host}${path}${search ? `?${search}` : ''}`;
  } catch {
    return null;
  }
}

/**
 * Résolution partagée : un appel réseau par story, quel que soit le nombre de
 * composants qui demandent l'URL. Un échec reste mémorisé pour la session —
 * l'utilisateur force la main en rechargeant la page.
 */
export function resolveDiscussion(
  url: string,
  fetchDiscussion: (u: string) => Promise<string | null> = resolveHackerNewsDiscussionUrl,
): Promise<string | null> {
  const key = storyKey(url);
  if (!key) return Promise.resolve(null);
  if (resolved.has(key)) return Promise.resolve(resolved.get(key)!);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const attempt = (async () => {
    try {
      const discussion = await fetchDiscussion(url);
      resolved.set(key, discussion);
      return discussion;
    } catch {
      resolved.set(key, null);
      return null; // l'article reste lisible ; l'échec n'écrit rien
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, attempt);
  return attempt;
}
