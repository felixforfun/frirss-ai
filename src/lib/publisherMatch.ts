import type { Subscription } from '../types';

/**
 * Matching a publisher against the subscriptions of the ACTIVE context.
 *
 * The whole module is PURE: no user data crosses servers — the caller passes
 * the `subscriptions` of the active FreshRSS server, period.
 *
 * Normalization is CONSERVATIVE: it must never merge two genuinely different
 * feeds. It ignores:
 *  - the http/https scheme (the same feed is often served under both);
 *  - a trailing slash, and a default port;
 *  - the case of the hostname.
 * It NEVER touches the real path (…/feed, …/atom.xml) or query parameters:
 * two different paths or query strings remain two different feeds.
 */

export function normalizeFeedUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  // Lowercased host, default port dropped, scheme dropped, trailing slash dropped.
  const host = url.hostname.toLowerCase();
  const defaultPort = (url.protocol === 'https:' && url.port === '443')
    || (url.protocol === 'http:' && url.port === '80');
  const port = url.port && !defaultPort ? `:${url.port}` : '';
  const path = url.pathname.replace(/\/+$/, '');
  return `//${host}${port}${path}${url.search}${url.hash}`;
}

/** Strict normalized matching — no more, no less. */
export function feedUrlsEquivalent(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeFeedUrl(a);
  const nb = normalizeFeedUrl(b);
  return !!na && !!nb && na === nb;
}

/** Hostname without `www.`, for the site-level fallback match. */
export function siteHost(raw: string | null | undefined): string {
  if (!raw) return '';
  try { return new URL(raw.trim()).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

export interface PublicationMatch {
  /** Exact normalized-URL match — the only firm proof. */
  exact?: Subscription;
  /**
   * Fallback "same site": subscriptions whose publishing site (`htmlUrl`)
   * matches. The caller decides: one credible candidate → navigation;
   * several → offer a choice or the preview.
   */
  siteCandidates: Subscription[];
}

/**
 * Compares a publisher's resolved (feed URL, site URL) pair against the
 * subscriptions of the active context.
 */
export function matchPublication(
  subscriptions: Subscription[],
  feedUrl: string | null | undefined,
  siteUrl: string | null | undefined,
): PublicationMatch {
  // BOTH inputs go through their own normalization at the same level: a
  // pre-normalized (scheme-less) string re-normalized would be wrongly
  // rejected — `new URL('//host/path')` throws.
  const host = siteHost(siteUrl);
  const siteCandidates = host
    ? subscriptions.filter((s) => siteHost(s.htmlUrl) === host)
    : [];
  if (!normalizeFeedUrl(feedUrl)) return { siteCandidates };
  const exact = subscriptions.find((s) => feedUrlsEquivalent(s.url, feedUrl));
  return { exact: exact ?? undefined, siteCandidates };
}
