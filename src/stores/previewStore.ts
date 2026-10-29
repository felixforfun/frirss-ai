import { create } from 'zustand';
import { useFeedStore } from './feedStore';
import type { Article, Subscription } from '../types';
import { sanitizeHtml } from '../utils/sanitizeHtml';
import { isTechmemePermalinkUrl, resolveCanonicalArticle } from '../lib/canonicalArticle';
import { matchPublication, normalizeFeedUrl } from '../lib/publisherMatch';
import { fetchPublisherPreview, discoverPublisherFeed, type PreviewArticle, type PreviewFeed } from '../api/publisherPreview';

/**
 * "Publisher preview" navigation state.
 *
 * Two possible outcomes from clicking a publisher name:
 *  - the publisher is already subscribed (normalized URL, else a single
 *    same-site candidate) → normal FEED navigation via `selectView` — no
 *    preview;
 *  - it is not → a dedicated READ-ONLY view, fed by `/api/publisher/preview`
 *    (public metadata, never FreshRSS state).
 */

export interface PreviewPublisher {
  name: string;
  siteUrl: string;
  /** Feed URL resolved up front (e.g. the source subscription), else null. */
  feedUrl: string | null;
}

export type PreviewStatus = 'idle' | 'resolving' | 'loading' | 'choose' | 'ready' | 'error';

export interface PublisherPreviewState {
  publisher: PreviewPublisher | null;
  status: PreviewStatus;
  /** i18n key of the error, for a recoverable message. */
  errorKey: string | null;
  feed: PreviewFeed | null;
  articles: PreviewArticle[];
  /** Feeds discovered when the site declares several (`choose` state). */
  discoveryOptions: { href: string; title: string }[];
  /** Same-site subscriptions, when a choice is worth offering. */
  candidates: Subscription[];
  openPublisher: (article: Article) => Promise<void>;
  /** Loads (and awaits) the preview of a specific feed. Exposed for the feed chooser. */
  loadFeed: (feedUrl: string, label?: string) => Promise<void>;
  openFeed: (feedUrl: string, label?: string) => void;
  /** After a successful add from the dialog: switch to the real feed. */
  navigateToSubscription: (feedUrl: string) => Promise<boolean>;
  retry: () => void;
  /** Back to the normal view. */
  close: () => void;
}

/** In-flight fetches, indexed by URL — never awaited twice. */
const inFlight = new Map<string, Promise<{ feed: PreviewFeed; articles: PreviewArticle[] } | null>>();

/** The article that triggered the preview: the basis of a retry. */
let lastTriggerArticle: Article | null = null;

interface ResolvedPublisher extends PreviewPublisher {
  candidates: Subscription[];
  exactMatch: Subscription | null;
}

/**
 * Publisher identity for ONE article:
 *  - resolved Techmeme item → the canonical publisher (name = host without
 *    `www.`, site = origin), reusing the existing `resolveCanonicalArticle`
 *    (session memory + in-flight dedup per permalink);
 *  - item of a direct subscription → the source subscription IS the
 *    publisher, its URL already counts as an exact match.
 */
async function resolvePublisherIdentity(article: Article): Promise<ResolvedPublisher | null> {
  const subs = useFeedStore.getState().subscriptions;

  if (isTechmemePermalinkUrl(article.url)) {
    const target = await resolveCanonicalArticle(article.url);
    if (target) {
      try {
        const u = new URL(target.url);
        const siteUrl = u.origin;
        const match = matchPublication(subs, null, siteUrl);
        return {
          name: target.publisher || u.hostname.replace(/^www\./, ''),
          siteUrl,
          feedUrl: null,
          candidates: match.siteCandidates,
          exactMatch: match.exact ?? null,
        };
      } catch { /* unreadable canonical target — fall back to the feed */ }
    }
  }

  const sourceUrl = article.sourceId?.startsWith('feed/') ? article.sourceId.slice('feed/'.length) : null;
  const sourceSub = sourceUrl ? subs.find((s) => s.url === sourceUrl) : undefined;
  if (!sourceSub) return null;
  const match = matchPublication(subs, sourceSub.url, sourceSub.htmlUrl);
  return {
    name: sourceSub.title,
    siteUrl: sourceSub.htmlUrl ?? '',
    feedUrl: sourceSub.url ?? null,
    candidates: match.siteCandidates.filter((s) => s.id !== sourceSub.id),
    exactMatch: match.exact ?? sourceSub,
  };
}

export const usePreviewStore = create<PublisherPreviewState>((set, get) => ({
  publisher: null,
  status: 'idle',
  errorKey: null,
  feed: null,
  articles: [],
  discoveryOptions: [],
  candidates: [],

  openPublisher: async (article) => {
    lastTriggerArticle = article;
    set({ status: 'resolving', errorKey: null, publisher: null });
    const resolved = await resolvePublisherIdentity(article);
    if (!resolved) {
      set({ status: 'error', errorKey: 'preview.errorUnresolved' });
      return;
    }
    // 1) Exact match → normal feed view, WITHOUT a subscribe button.
    if (resolved.exactMatch) {
      useFeedStore.getState().selectView(resolved.exactMatch);
      get().close();
      return;
    }
    // 2) A single same-site candidate → same conclusion, no redundant
    //    preview. This fallback also holds when the publisher's feed URL is
    //    unknown (Techmeme): the site matches, a subscribed feed exists on it.
    const [only] = resolved.candidates;
    if (resolved.candidates.length === 1 && only) {
      useFeedStore.getState().selectView(only);
      get().close();
      return;
    }
    if (resolved.candidates.length > 1) {
      // Several feeds from the same site: ambiguous — NO arbitrary choice.
      // The preview continues and the view lists these candidates as chips
      // (`PublisherPreview` renders them); the user decides or ignores them.
    }
    // 3) Preview.
    set({
      status: 'loading',
      publisher: resolved,
      candidates: resolved.candidates,
      feed: null,
      articles: [],
    });
    if (resolved.feedUrl && resolved.feedUrl !== '') {
      await get().loadFeed(resolved.feedUrl);
      return;
    }
    // Discovery on the canonical site.
    let links: { href: string; title: string }[] = [];
    try {
      links = (await discoverPublisherFeed(resolved.siteUrl)).map((l) => ({ href: l.href, title: l.title }));
    } catch {
      set({ status: 'error', errorKey: 'preview.errorResolveFailed' });
      return;
    }
    const siteHostOf = (u: string) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
    const siteHostWanted = siteHostOf(resolved.siteUrl);
    const sameHost = links.filter((l) => siteHostOf(l.href) === siteHostWanted);
    const chosen = sameHost.length === 1 ? sameHost[0] : links.length === 1 ? links[0] : null;
    if (!chosen) {
      if (links.length === 0) {
        // Nothing declared: no fabricated URL — the failure is recoverable.
        set({ status: 'error', errorKey: 'preview.errorResolveFailed' });
        return;
      }
      set({ status: 'choose', discoveryOptions: sameHost.length ? sameHost : links });
      return;
    }
    await get().loadFeed(chosen.href, chosen.title);
  },

  loadFeed: async (feedUrl: string, label?: string) => {
    const pub = get().publisher;
    if (!pub) return;
    set({ status: 'loading', errorKey: null });
    const key = feedUrl;
    const pending = inFlight.get(key);
    const task = pending ?? (async () => {
      try {
        const { feed, articles } = await fetchPublisherPreview(feedUrl);
        // Feed summaries are re-sanitized by the existing sanitizer before
        // any rendering — the feed provides no trusted HTML.
        return { feed, articles: articles.map((a) => ({ ...a, summary: sanitizeHtml(a.summary) })) };
      } catch {
        return null;
      } finally {
        inFlight.delete(key);
      }
    })();
    if (!pending) inFlight.set(key, task);
    const result = await task;
    // The view may have been left (close, navigation) while the request was
    // in flight.
    if (get().publisher !== pub) return;
    if (!result) {
      set({ status: 'error', errorKey: 'preview.errorLoad' });
      return;
    }
    set({ status: 'ready', articles: result.articles, feed: result.feed });
    void label;
  },

  openFeed: (feedUrl: string, label?: string) => {
    if (!get().publisher) return;
    void get().loadFeed(feedUrl, label);
  },

  navigateToSubscription: async (feedUrl) => {
    const subs = useFeedStore.getState().subscriptions;
    const norm = normalizeFeedUrl(feedUrl);
    const target = subs.find((s) => norm && normalizeFeedUrl(s.url) === norm);
    if (!target) return false;
    // Normal feed view + waiting-for-first-scan state: FreshRSS usually has
    // nothing yet — the empty screen announces the promised arrival, not
    // "no articles".
    useFeedStore.getState().markAwaitingFirstArticles(target.id);
    useFeedStore.getState().selectView(target);
    get().close();
    return true;
  },

  retry: () => {
    const article = lastTriggerArticle;
    if (!article) return;
    void get().openPublisher(article);
  },

  close: () => {
    set({ publisher: null, status: 'idle', errorKey: null, feed: null, articles: [], discoveryOptions: [], candidates: [] });
  },
}));
