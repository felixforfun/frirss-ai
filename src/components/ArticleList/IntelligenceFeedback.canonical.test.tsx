// @vitest-environment jsdom
//
// Le vote porte l'identité canonique : pour un item Techmeme déjà résolu, la
// ligne sauvegardée référence l'article éditeur (les signaux externes et les
// rapprochements s'indexent par URL), tandis que la clé du vote reste
// l'identifiant FreshRSS — un vote par article, jamais de doublon.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { Article } from '../../types';

vi.mock('../../api/intelligence', () => ({
  getArticleFeedback: vi.fn(() => Promise.resolve([])),
  setArticleFeedback: vi.fn(() => Promise.resolve()),
  removeArticleFeedback: vi.fn(() => Promise.resolve()),
}));

import { setArticleFeedback, getArticleFeedback } from '../../api/intelligence';
import IntelligenceFeedback from './IntelligenceFeedback';

const setFeedback = vi.mocked(setArticleFeedback);
const getFeedback = vi.mocked(getArticleFeedback);

const base: Article = {
  id: '1792826086801102',
  title: 'AWS sold capacity through 2028, Jassy says',
  summary: 'AWS capacity briefing',
  content: '<p>AWS capacity briefing</p>',
  author: '',
  url: 'https://www.techmeme.com/261023/p27#a261023p27',
  source: 'Techmeme',
  sourceId: 'feed/398',
  published: Date.now(),
  read: true,
  starred: false,
  labels: [],
  tags: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  getFeedback.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
});

describe('IntelligenceFeedback vote payload', () => {
  it('votes with the canonical publisher URL when the item is resolved', async () => {
    render(<IntelligenceFeedback article={{ ...base, id: 'vote-canonical-1', canonicalUrl: 'https://www.theinformation.com/briefings/aws-sold-capacity-2028-jassy-says' }} />);
    fireEvent.click(screen.getByLabelText('This article is interesting'));
    await waitFor(() => expect(setFeedback).toHaveBeenCalled());
    expect(setFeedback.mock.calls[0]?.[0]).toMatchObject({
      articleId: 'vote-canonical-1',
      url: 'https://www.theinformation.com/briefings/aws-sold-capacity-2028-jassy-says',
    });
  });

  it('votes with the FreshRSS item URL when no canonical target exists', async () => {
    render(<IntelligenceFeedback article={{ ...base, id: 'vote-raw-2' }} />);
    fireEvent.click(screen.getByLabelText('This article is interesting'));
    await waitFor(() => expect(setFeedback).toHaveBeenCalled());
    expect(setFeedback.mock.calls[0]?.[0]).toMatchObject({
      articleId: 'vote-raw-2',
      url: 'https://www.techmeme.com/261023/p27#a261023p27',
    });
  });

  it('passes ordinary articles through unchanged', async () => {
    render(<IntelligenceFeedback article={{ ...base, id: 'vote-normal-3', url: 'https://www.androidauthority.com/google-personal-intelligence-privacy-3727111/' }} />);
    fireEvent.click(screen.getByLabelText('This article is not interesting'));
    await waitFor(() => expect(setFeedback).toHaveBeenCalled());
    expect(setFeedback.mock.calls[0]?.[0]).toMatchObject({
      articleId: 'vote-normal-3',
      url: 'https://www.androidauthority.com/google-personal-intelligence-privacy-3727111/',
    });
  });
});
