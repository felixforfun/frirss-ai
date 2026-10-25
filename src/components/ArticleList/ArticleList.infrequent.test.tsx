// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { Article, Subscription } from '../../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

import ArticleList from './ArticleList';
import { useFeedStore } from '../../stores/feedStore';
import { useUiStore } from '../../stores/uiStore';

// The Infrequent Sites heading used to show the unread total of the WHOLE
// reading list (15 988 on one account) while the list itself held only
// classified feeds — a count/list disagreement measured in four digits.
// These tests pin the badge to the eligible collection.

const article = (id: string): Article => ({
  id, title: id, summary: id, content: `<p>${id}</p>`, author: '', url: `https://example.com/${id}`,
  source: id, sourceId: id, published: Date.now(), read: false, starred: false, labels: [], tags: [],
});
const feeds = [
  { id: 'feed/rare', title: 'Rare' },
  { id: 'feed/bursty', title: 'Bursty' },
] as Subscription[];

const initial = { feed: useFeedStore.getState(), ui: useUiStore.getState() };

function showInfrequent(infrequentFeedIds: string[] | null) {
  useUiStore.setState({ layoutMode: 'desktop' });
  useFeedStore.setState({
    filter: 'infrequent',
    selectedFeed: null,
    loading: false,
    revalidating: false,
    articles: [article('feed/rare')],
    subscriptions: feeds,
    unreadCounts: { 'feed/rare': 2, 'feed/bursty': 15986 },
    infrequentFeedIds,
    searchQuery: '',
  });
  return render(<ArticleList />);
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  useFeedStore.setState(initial.feed, true);
  useUiStore.setState(initial.ui, true);
  localStorage.clear();
});

describe('ArticleList — Infrequent sites header count', () => {
  it('the badge sums unread counts over the eligible feeds only', () => {
    showInfrequent(['feed/rare']);
    expect(screen.getByText('2')).toBeTruthy();
    // The bursty feed's 15 986 unread articles must not appear anywhere.
    expect(screen.queryByText('15988')).toBeNull();
  });

  it('the badge waits for the classification instead of showing the reading-list total', () => {
    showInfrequent(null);
    expect(screen.queryByText('15986')).toBeNull();
    expect(screen.queryByText('15988')).toBeNull();
  });

  it('“mark all as read” is not offered: the view has no stream to empty', () => {
    // `markAllAsRead` targets the reading list when no feed is selected; from
    // this view it would empty every feed in the account while claiming to
    // touch only the infrequent collection.
    showInfrequent(['feed/rare']);
    expect(screen.queryByRole('button', { name: 'articleList.markAllRead' })).toBeNull();
  });

  it('mark-all keeps working in views backed by a real stream', () => {
    useUiStore.setState({ layoutMode: 'desktop' });
    useFeedStore.setState({
      filter: 'unread',
      selectedFeed: null,
      loading: false,
      revalidating: false,
      articles: [article('feed/rare')],
      subscriptions: feeds,
      unreadCounts: { 'feed/rare': 2, 'feed/bursty': 15986 },
      searchQuery: '',
    });
    render(<ArticleList />);
    expect(screen.getByRole('button', { name: 'articleList.markAllRead' })).toBeTruthy();
  });
});
