import { resolveTechmemeArticleUrl } from '../api/backend';
import type { Article } from '../types';

/**
 * Cible canonique d'un article Techmeme.
 *
 * Un item Techmeme porte trois identités distinctes, qu'il ne faut jamais
 * confondre :
 *  - son identité FreshRSS (`article.id`, flux `sourceId`) — l'état lu,
 *    favori et les labels restent portés par l'ITEM ;
 *  - `article.url`, le permalink Techmeme (une page « emballage ») ;
 *  - la cible canonique : l'article original chez l'éditeur, résolu depuis le
 *    fil RSS Techmeme. C'est LA cible que tout usage utilisateur de l'URL doit
 *    employer : affichage de l'attribution, titre cliquable, ouverture à la
 *    source, partage, vote.
 *
 * `canonicalUrl` est écrit sur l'objet Article par le store (`applyCanonicalUrl`)
 * après une résolution réussie ; l'échec n'écrit rien et laisse tout se
 * comporter comme avant. Les flux non-Techmeme n'évoluent pas (résolution
 * court-circuitée).
 */

export interface CanonicalArticleTarget {
  /** L'URL éditeur canonique, sans fragment. */
  url: string;
  /** Nom d'affichage (hostname éditeur, sans `www.`). */
  publisher: string;
}

const TECHMEME_HOSTS = new Set(['techmeme.com', 'www.techmeme.com']);

/** Permelien Techmeme (`/p12` ou `/YYMMDD/p12`), fragment ignoré. */
export function isTechmemePermalinkUrl(raw: string | null | undefined): boolean {
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return (url.protocol === 'https:' || url.protocol === 'http:')
      && TECHMEME_HOSTS.has(url.hostname.toLowerCase())
      && /^\/(?:\d{6}\/)?p\d+$/i.test(url.pathname);
  } catch {
    return false;
  }
}

/** Clé stable d'un permalink Techmeme : le chemin, sans fragment ni slash final. */
export function canonicalPathKey(raw: string): string | null {
  try { return new URL(raw).pathname.replace(/\/$/, ''); } catch { return null; }
}

/**
 * Résolutions déjà obtenues, indexées par chemin — pour qu'un même item
 * Techmeme ne soit jamais résolu deux fois indépendamment (mémoire + appel
 * réseau unique quel que soit le composant appelant).
 */
const resolved = new Map<string, CanonicalArticleTarget | null>();
const inFlight = new Map<string, Promise<CanonicalArticleTarget | null>>();

function displayPublisher(canonicalUrl: string): string {
  try { return new URL(canonicalUrl).hostname.replace(/^www\./, ''); } catch { return ''; }
}

export function canonicalTargetFor(url: string | null | undefined): CanonicalArticleTarget | null {
  if (!url) return null;
  const key = canonicalPathKey(url);
  if (!key) return null;
  return resolved.get(key) ?? null;
}

/** Résolution partagée : appel réseau unique par item Techmeme. */
export function resolveCanonicalArticle(
  url: string,
  fetchTechmeme: (u: string) => Promise<string | null> = resolveTechmemeArticleUrl,
): Promise<CanonicalArticleTarget | null> {
  if (!isTechmemePermalinkUrl(url)) return Promise.resolve(null);
  const key = canonicalPathKey(url)!;
  const known = resolved.get(key);
  if (known) return Promise.resolve(known);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const attempt = (async () => {
    try {
      const canonical = await fetchTechmeme(url);
      const target: CanonicalArticleTarget | null = canonical
        ? { url: canonical, publisher: displayPublisher(canonical) }
        : null;
      resolved.set(key, target);
      return target;
    } catch {
      return null; // l'article reste lisible ; l'échec n'écrit rien
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, attempt);
  return attempt;
}

/** URL cible pour tout usage utilisateur de l'article. */
export function canonicalOrSelf(article: Pick<Article, 'url' | 'canonicalUrl'>): string {
  return article.canonicalUrl || article.url || '';
}
