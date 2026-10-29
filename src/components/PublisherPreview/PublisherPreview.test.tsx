// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import PublisherPreview from './PublisherPreview';

// Text under test is the i18n KEY: copy coverage is guarded by i18nCoverage.test.ts.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock('../../stores/feedStore', () => {
  const subscriptions: unknown[] = [];
  const selectView = vi.fn();
  const markAwaitingFirstArticles = vi.fn();
  return {
    useFeedStore: Object.assign(
      (selector: (s: unknown) => unknown) => selector({ subscriptions, selectView, markAwaitingFirstArticles }),
      { getState: () => ({ subscriptions, selectView, markAwaitingFirstArticles }) },
    ),
  };
});
vi.mock('../../stores/uiStore', () => ({
  useUiStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ pushToast: vi.fn() }),
    { getState: () => ({}) },
  ),
}));
vi.mock('../../stores/previewStore', () => {
  const state = {
    publisher: { name: 'The New Stack', siteUrl: 'https://thenewstack.io/', feedUrl: 'https://thenewstack.io/feed' },
    status: 'ready',
    errorKey: null,
    feed: { kind: 'rss', title: 'The New Stack', siteUrl: 'https://thenewstack.io/', feedUrl: 'https://thenewstack.io/feed', selfUrl: '', iconUrl: '', description: '' },
    articles: [
      { id: 'a', title: 'GitHub saw 7.4B commits', url: 'https://thenewstack.io/a', published: 1_800_000_000_000, summary: '<p>hello</p>', author: '' },
      { id: 'b', title: 'AI agents', url: 'https://thenewstack.io/b', published: 1_799_000_000_000, summary: '', author: '' },
    ],
    discoveryOptions: [],
    candidates: [],
    openFeed: vi.fn(),
    loadFeed: vi.fn(),
    navigateToSubscription: vi.fn(async () => true),
    retry: vi.fn(),
    close: vi.fn(),
  };
  return { usePreviewStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector(state),
    { getState: () => state },
  ) };
});
vi.mock('../../lib/copyLink', () => ({ copyLink: vi.fn(async () => 'copied') }));
vi.mock('../FeedFavicon', () => ({
  default: ({ title }: { title?: string }) => <div data-testid="favicon">{title}</div>,
  LetterAvatar: ({ title }: { title?: string }) => <div data-testid="letter-avatar">{title}</div>,
}));
vi.mock('../Sidebar/AddFeedDialog', () => ({
  default: ({ initialUrl, initialTitle, onAdded, onClose }: { initialUrl?: string; initialTitle?: string; onAdded?: () => void; onClose?: () => void }) => (
    <div data-testid="add-feed-dialog" data-initial-url={initialUrl ?? ''} data-initial-title={initialTitle ?? ''}>
      <button data-testid="dialog-added" onClick={() => { onAdded?.(); onClose?.(); }}>added</button>
    </div>
  ),
}));

import { usePreviewStore } from '../../stores/previewStore';
import { matchPublication } from '../../lib/publisherMatch';
vi.mock('../../lib/publisherMatch', () => ({
  matchPublication: vi.fn(() => ({ siteCandidates: [] })),
}));

const storeState = () => usePreviewStore.getState() as unknown as {
  articles: { id: string; url: string }[];
  navigateToSubscription: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.mocked(matchPublication).mockReturnValue({ siteCandidates: [] });
});

afterEach(() => {
  vi.clearAllMocks();
  cleanup();
});

describe('PublisherPreview', () => {
  it('shows the publisher header, the preview badge and the banner', () => {
    render(<PublisherPreview />);
    expect(screen.getAllByText('The New Stack').length).toBeGreaterThan(0);
    expect(screen.getByTestId("preview-subscribe")).toBeTruthy();
    expect(screen.getByText("preview.banner")).toBeTruthy();
  });

  it('renders preview articles in READ-ONLY form: only copy/share controls, no state-changing actions', () => {
    const { container } = render(<PublisherPreview />);
    expect(screen.getByText('GitHub saw 7.4B commits')).toBeTruthy();
    // Each preview row offers only two buttons: copy the link, share.
    const rows = container.querySelectorAll('[data-preview-article]');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.querySelectorAll('button')).toHaveLength(2);
      // No FreshRSS state mutation: no read ✓, no star, no vote.
      expect(row.textContent?.match(/mark|star|later|vote/i)).toBeNull();
    }
    // And the store received NOTHING to mutate: no FreshRSS identity shown.
    expect(container.querySelector('[data-article-id]')).toBeNull();
  });

  it('opens the original article in a NEW TAB from the title link', () => {
    render(<PublisherPreview />);
    const links = screen.getAllByRole('link', { name: 'GitHub saw 7.4B commits' });
    expect(links.length).toBeGreaterThan(0);
    expect(links[0].getAttribute('href')).toBe('https://thenewstack.io/a');
    expect(links[0].getAttribute('target')).toBe('_blank');
    expect(links[0].getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('the subscribe button opens the dialog prefilled with the resolved feed URL and publisher name', async () => {
    render(<PublisherPreview />);
    fireEvent.click(screen.getByTestId('preview-subscribe'));
    const dialog = await screen.findByTestId('add-feed-dialog');
    expect(dialog.getAttribute('data-initial-url')).toBe('https://thenewstack.io/feed');
    expect(dialog.getAttribute('data-initial-title')).toBe('The New Stack');
  });

  it('after a successful add it navigates to the real feed and closes the preview', async () => {
    render(<PublisherPreview />);
    fireEvent.click(screen.getByTestId('preview-subscribe'));
    fireEvent.click(await screen.findByTestId('dialog-added'));
    await waitFor(() => expect(storeState().navigateToSubscription).toHaveBeenCalledWith('https://thenewstack.io/feed'));
  });

  it('hides the Subscribe button when the feed is already subscribed (reconciliation)', () => {
    vi.mocked(matchPublication).mockReturnValue({ exact: { id: 'n', title: 'n', url: 'https://thenewstack.io/feed' } } as ReturnType<typeof matchPublication>);
    render(<PublisherPreview />);
    expect(screen.queryByTestId('preview-subscribe')).not.toBeTruthy();
    expect(screen.queryByText('preview.banner')).not.toBeTruthy();
  });

  it('offers the retry action on error', () => {
    (usePreviewStore.getState() as unknown as { status: string }).status = 'error';
    (usePreviewStore.getState() as unknown as { errorKey: string }).errorKey = 'preview.errorLoad';
    (usePreviewStore.getState() as unknown as { articles: [] }).articles = [];
    render(<PublisherPreview />);
    fireEvent.click(screen.getByText('preview.retry'));
    expect(storeState().retry).toHaveBeenCalled();
  });

  it('closes the preview from the header cross', () => {
    render(<PublisherPreview />);
    fireEvent.click(screen.getByLabelText('preview.back'));
    expect(storeState().close).toHaveBeenCalled();
  });

  // Regression: with `publisher: null` (identity not resolvable, e.g. the
  // article's source feed matches no subscription) the component used to
  // render null — a blank pane. The error state must stay recoverable.
  it('renders the recoverable error view even when no publisher was resolved (errorUnresolved)', () => {
    const s = usePreviewStore.getState() as unknown as { publisher: unknown; status: string; errorKey: string | null };
    const savedPublisher = s.publisher;
    s.publisher = null;
    s.status = 'error';
    s.errorKey = 'preview.errorUnresolved';
    render(<PublisherPreview />);
    expect(screen.getByText('preview.errorUnresolved')).toBeTruthy();
    fireEvent.click(screen.getByText('preview.retry'));
    expect(storeState().retry).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'preview.back' }));
    expect(storeState().close).toHaveBeenCalled();
    // restore the shared mock state for the following tests
    s.publisher = savedPublisher;
    s.status = 'ready';
    s.errorKey = null;
  });

  it('shows a skeleton while resolving (no publisher yet, no error)', () => {
    const s = usePreviewStore.getState() as unknown as { publisher: unknown; status: string };
    const savedPublisher = s.publisher;
    s.publisher = null;
    s.status = 'resolving';
    render(<PublisherPreview />);
    expect(screen.queryByTestId('preview-subscribe')).not.toBeTruthy();
    expect(screen.queryByText('preview.errorUnresolved')).not.toBeTruthy();
    s.publisher = savedPublisher;
    s.status = 'ready';
  });
});
