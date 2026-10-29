import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFeedStore } from '../../stores/feedStore';
import { usePreviewStore } from '../../stores/previewStore';
import { useUiStore } from '../../stores/uiStore';
import { matchPublication } from '../../lib/publisherMatch';
import { extractImageFromContent } from '../../lib/articleThumbnail';
import { copyLink } from '../../lib/copyLink';
import FeedFavicon, { LetterAvatar } from '../FeedFavicon';
import AddFeedDialog from '../Sidebar/AddFeedDialog';
import type { PreviewArticle } from '../../api/publisherPreview';

/**
 * Preview view of a NON-subscribed publisher (briefing §6, reference mockup).
 *
 * Deliberately not a feed view: no FreshRSS item exists here — no
 * read/starred/vote/labels state, no `markAs*` IDs. Summaries are already
 * sanitized by the store (the existing sanitizer); the title points at the
 * ORIGINAL article — that is the whole mutable surface of the row.
 */

function PreviewRow({ article }: { article: PreviewArticle }) {
  const { t } = useTranslation();
  const pushToast = useUiStore((s) => s.pushToast);
  const thumbnail = extractImageFromContent(article.summary);
  const date = article.published ? formatPreviewDate(article.published) : '';

  async function onCopy() {
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard ?? null : null;
    if (await copyLink(article.url, clipboard) === 'copied') pushToast(t('toast.linkCopied'));
  }

  async function onShare() {
    try {
      if (navigator.share) {
        await navigator.share({ title: article.title, url: article.url });
        return;
      }
      const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard ?? null : null;
      if (await copyLink(article.url, clipboard) === 'copied') pushToast(t('toast.linkCopied'));
    } catch { /* share cancelled — do nothing */ }
  }

  return (
    <article
      className="px-4 py-3 flex gap-3"
      data-preview-article={article.id}
      style={{ borderBottom: '1px solid var(--panel-border)' }}
    >
      {thumbnail && (
        <a href={article.url} target="_blank" rel="noopener noreferrer" className="block w-20 h-16 rounded overflow-hidden flex-shrink-0" style={{ background: 'var(--panel-hover)' }}>
          <img
            src={thumbnail}
            alt=""
            loading="lazy"
            className="w-full h-full object-cover"
            onError={(e) => { const p = e.currentTarget.parentElement; if (p) p.style.display = 'none'; }}
          />
        </a>
      )}

      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 mb-0.5">
          {date && (
            <span className="text-[10px] flex-shrink-0" data-theme="list-time" style={{ color: 'var(--list-time)' }}>
              {date}
            </span>
          )}
        </div>
        <a
          dir="auto"
          href={article.url}
          target="_blank"
          rel="noopener noreferrer"
          className="article-title leading-snug mb-1 font-medium block hover:underline"
          data-theme="list-title"
          style={{ color: 'var(--list-title)', fontSize: 'var(--fs-list-title)' }}
        >
          {article.title}
        </a>
        {article.summary && (
          <p dir="auto" className="line-clamp-2 leading-relaxed" data-theme="list-summary" style={{ color: 'var(--list-summary)', fontSize: 'var(--fs-list-summary)' }}>
            {article.summary.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()}
          </p>
        )}
      </div>

      <div className="flex flex-col justify-center gap-1 flex-shrink-0">
        <button
          type="button"
          onClick={onCopy}
          title={t('readingPane.copyLink')}
          aria-label={t('readingPane.copyLink')}
          className="p-2 rounded-lg hover:bg-[var(--list-hover)] transition-colors"
          style={{ color: 'var(--list-summary)' }}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 010 5.656l-3 3a4 4 0 01-5.656-5.656l1.102-1.101m8.154-1.9l3-3a4 4 0 00-5.656-5.657l-1.1 1.102" />
          </svg>
        </button>
        <button
          type="button"
          onClick={onShare}
          title={t('preview.share')}
          aria-label={t('preview.share')}
          className="p-2 rounded-lg hover:bg-[var(--list-hover)] transition-colors"
          style={{ color: 'var(--list-summary)' }}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.684 13.342C8.886 13.983 9 14.666 9 15.375v1.5c0 .31-.032.625-.08.94a4.475 4.475 0 003.4 2.35c1.262.102 2.536.235 3.8.45h.104c2.445 0 3.176-2.48 2.09-4.665-.253-.101-1.02-.153-2.09-.153m-10.72 0c-2.44 0-3.175-2.48-2.088-4.665" />
          </svg>
        </button>
      </div>
    </article>
  );
}

function formatPreviewDate(ms: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(ms);
  } catch {
    return new Date(ms).toLocaleString();
  }
}

function SkeletonRows({ count = 4 }: { count?: number }) {
  return (
    <div role="status" aria-live="polite">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="px-4 py-3 flex gap-3" style={{ borderBottom: '1px solid var(--panel-border)' }}>
          <div className="w-20 h-16 rounded skeleton" style={{ background: 'var(--list-hover)' }} />
          <div className="flex-1 space-y-2">
            <div className="h-4 rounded skeleton" style={{ background: 'var(--list-hover)', width: '80%' }} />
            <div className="h-3 rounded skeleton" style={{ background: 'var(--list-hover)', width: '60%' }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function PublisherPreview() {
  const { t } = useTranslation();
  const publisher = usePreviewStore((s) => s.publisher);
  const status = usePreviewStore((s) => s.status);
  const errorKey = usePreviewStore((s) => s.errorKey);
  const feed = usePreviewStore((s) => s.feed);
  const articles = usePreviewStore((s) => s.articles);
  const discoveryOptions = usePreviewStore((s) => s.discoveryOptions);
  const candidates = usePreviewStore((s) => s.candidates);
  const openFeed = usePreviewStore((s) => s.openFeed);
  const retry = usePreviewStore((s) => s.retry);
  const close = usePreviewStore((s) => s.close);
  const navigateToSubscription = usePreviewStore((s) => s.navigateToSubscription);

  const subscriptions = useFeedStore((s) => s.subscriptions);
  const name = publisher?.name ?? (publisher?.siteUrl ? new URL(publisher.siteUrl).hostname.replace(/^www\./, '') : '');
  const displayFeedUrl = feed?.feedUrl || publisher?.feedUrl || '';
  const displayHost = useMemo(() => {
    const raw = displayFeedUrl || publisher?.siteUrl || '';
    try { return new URL(raw).hostname.replace(/^www\./, ''); } catch { return ''; }
  }, [displayFeedUrl, publisher?.siteUrl]);

  // Live reconciliation: a feed discovered and subscribed DURING the preview
  // is picked up here on every subscriptions re-render — no Subscribe button
  // left floating over a feed that is already subscribed.
  const alreadySubscribed = useMemo(() => {
    if (!displayFeedUrl) return false;
    return matchPublication(subscriptions, displayFeedUrl, feed?.siteUrl).exact != null;
  }, [subscriptions, displayFeedUrl, feed?.siteUrl]);

  const [subscribeOpen, setSubscribeOpen] = useState(false);
  useEffect(() => {
    // A feed that became subscribed closes the dialog left open behind it.
    if (alreadySubscribed) setSubscribeOpen(false);
  }, [alreadySubscribed]);

  if (!publisher || status === 'idle') return null;

  return (
    <div className="h-full overflow-y-auto" style={{ background: 'var(--panel-bg)' }}>
      {/* ── Publisher header ── */}
      <section
        className="flex items-center gap-3 px-4 py-4"
        style={{ borderBottom: '1px solid var(--panel-border)' }}
        data-preview-header=""
      >
        {feed?.iconUrl ? (
          <FeedFavicon iconUrl={feed.iconUrl} title={name} size={44} />
        ) : (
          <LetterAvatar title={name} size={44} />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap min-w-0">
            <h1
              className="font-bold truncate"
              data-theme="reading-title"
              style={{ color: 'var(--reading-title)', fontSize: 'var(--fs-reading-title)' }}
            >
              {name}
            </h1>
            <span
              className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded flex-shrink-0"
              style={{ color: 'var(--list-source)', border: '1px solid var(--panel-border)' }}
            >
              {t('preview.badge')}
            </span>
          </div>
          {displayHost && (
            <div className="text-xs truncate mt-0.5 flex items-center gap-1" style={{ color: 'var(--reading-meta)' }}>
              <svg className="w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M10.81 15.312a4.5 4.5 0 01-1.242-7.244l4.5-4.5a4.5 4.5 0 016.364 6.364l-1.757 1.757" />
              </svg>
              {displayHost}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => { close(); }}
          title={t('preview.back')}
          aria-label={t('preview.back')}
          className="p-2 rounded-lg hover:bg-[var(--list-hover)] transition-colors flex-shrink-0"
          style={{ color: 'var(--list-summary)' }}
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
        {!alreadySubscribed && (
          <button
            type="button"
            onClick={() => setSubscribeOpen(true)}
            disabled={status !== 'ready' || !displayFeedUrl}
            data-testid="preview-subscribe"
            className="px-4 py-2 text-sm font-semibold rounded-lg inline-flex items-center gap-2 transition-colors disabled:opacity-50 flex-shrink-0"
            style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            {t('preview.subscribe')}
          </button>
        )}
      </section>

      {/* ── Bandeau d'information ── */}
      {status === 'ready' && !alreadySubscribed && (
        <div className="flex items-center gap-2 px-4 py-2.5" style={{ borderBottom: '1px solid var(--panel-border)', background: 'var(--panel-hover)' }}>
          <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} style={{ color: 'var(--reading-meta)' }}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="text-xs flex-1 min-w-0" style={{ color: 'var(--reading-meta)' }}>
            {t('preview.banner')}
          </p>
        </div>
      )}

      {/* ── Existing subscription choice (same-site feeds) ── */}
      {candidates.length > 1 && (
        <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--panel-border)' }}>
          <p className="text-xs mb-2" style={{ color: 'var(--reading-meta)' }}>
            {t('preview.existingFeeds')}
          </p>
          <div className="flex flex-wrap gap-2">
            {candidates.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => { void navigateToSubscription(c.url ?? ''); }}
                className="px-3 py-1.5 text-xs rounded-lg border transition-colors hover:border-[var(--accent)]"
                style={{ borderColor: 'var(--panel-border)', color: 'var(--list-title)' }}
              >
                {c.title}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Discovered feed choice (several declared candidates) ── */}
      {status === 'choose' && (
        <div className="px-4 py-4" role="listbox" aria-label={t('preview.chooseFeed')}>
          <p className="text-xs mb-2" style={{ color: 'var(--reading-meta)' }}>
            {t('preview.chooseFeed')}
          </p>
          {discoveryOptions.map((l) => (
            <button
              key={l.href}
              type="button"
              onClick={() => openFeed(l.href, l.title)}
              className="block w-full text-left px-3 py-2.5 rounded-lg border mb-2 transition-colors hover:border-[var(--accent)]"
              style={{ borderColor: 'var(--panel-border)', color: 'var(--list-title)' }}
            >
              <span className="text-sm font-medium truncate block">{l.title || l.href}</span>
              <span className="text-xs truncate block" style={{ color: 'var(--reading-meta)' }}>{l.href}</span>
            </button>
          ))}
        </div>
      )}

      {/* ── Chargement ── */}
      {status === 'loading' && <SkeletonRows />}

      {/* ── Erreur recoverable ── */}
      {status === 'error' && (
        <div className="px-4 py-10 text-center">
          <p className="text-sm mb-3" style={{ color: 'var(--reading-meta)' }}>
            {t(errorKey ?? 'preview.errorLoad')}
          </p>
          <div className="flex justify-center gap-2">
            <button
              type="button"
              onClick={retry}
              className="px-4 py-2 text-sm rounded-lg transition-colors"
              style={{ border: '1px solid var(--panel-border)', color: 'var(--list-title)' }}
            >
              {t('preview.retry')}
            </button>
            {publisher.siteUrl && (
              <a
                href={publisher.siteUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="px-4 py-2 text-sm rounded-lg transition-colors inline-block"
                style={{ border: '1px solid var(--panel-border)', color: 'var(--list-title)' }}
              >
                {t('preview.openSite')}
              </a>
            )}
          </div>
        </div>
      )}

      {/* ── Liste des articles ── */}
      {status === 'ready' && articles.length === 0 && (
        <div className="px-4 py-10 text-center" style={{ color: 'var(--reading-meta)' }}>
          {t('preview.emptyFeed')}
        </div>
      )}
      {status === 'ready' && articles.length > 0 && (
        <div role="list">
          {articles.map((a) => (
            <PreviewRow key={a.id || a.url} article={a} />
          ))}
        </div>
      )}

      {subscribeOpen && !alreadySubscribed && (
        <AddFeedDialog
          onClose={() => setSubscribeOpen(false)}
          initialUrl={displayFeedUrl || undefined}
          initialTitle={name || undefined}
          onAdded={() => {
            // addFeed already reloaded the subscriptions — live
            // reconciliation hides the button and the banner, and switches
            // to the normal feed view.
            void navigateToSubscription(displayFeedUrl);
          }}
        />
      )}
    </div>
  );
}
