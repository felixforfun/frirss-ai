// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import HackerNewsDiscussionLink from './HackerNewsDiscussionLink';
import type { Article } from '../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

afterEach(cleanup);

const hnItemArticle: Article = {
  id: 'a1', title: 'Show HN: OmniDiff', summary: '', source: 'Hacker News',
  content: '<a href="https://news.ycombinator.com/item?id=50326821">Comments</a>',
  url: 'https://github.com/ivankovic/omnidiff', published: Date.now(),
  read: false, starred: false, labels: [],
} as unknown as Article;

const hnSelfPost: Article = {
  id: 'a2', title: 'Anthropic', summary: '', source: 'Hacker News',
  content: '<p>extraction</p>', url: 'https://news.ycombinator.com/item?id=50326727',
  published: Date.now(), read: false, starred: false, labels: [],
} as unknown as Article;

describe('HackerNewsDiscussionLink', () => {
  it('ne rend RIEN hors du flux Hacker News', () => {
    const other = { ...hnSelfPost, source: 'Techmeme', url: 'https://www.techmeme.com/261023/p28' };
    const { container } = render(<HackerNewsDiscussionLink article={other} className="inline-flex" />);
    expect(container.querySelector('a')).toBeNull();
  });

  it('ne rend RIEN sans identifiant fiable (ancre perdue à l’extraction)', () => {
    const lost = { ...hnSelfPost, url: 'https://lagomor.ph/post/', content: '<p>article extrait</p>' };
    const { container } = render(<HackerNewsDiscussionLink article={lost} className="inline-flex" />);
    expect(container.querySelector('a')).toBeNull();
  });

  it('rend le lien discussion pour un article dont le contenu porte l’ancre du flux', () => {
    const { getByRole } = render(<HackerNewsDiscussionLink article={hnItemArticle} className="inline-flex" />);
    const link = getByRole('link');
    expect(link.getAttribute('href')).toBe('https://news.ycombinator.com/item?id=50326821');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.textContent).toContain('hackerNews.viewComments');
  });

  it('rend le lien discussion pour une `url` qui est déjà l’item HN', () => {
    const { getByRole } = render(<HackerNewsDiscussionLink article={hnSelfPost} className="inline-flex" />);
    expect(getByRole('link').getAttribute('href')).toBe('https://news.ycombinator.com/item?id=50326727');
  });

  it('un clic sur le lien N’OUVRE PAS l’article porteur (stopPropagation)', () => {
    const onSelect = vi.fn();
    const { container } = render(
      // Ce clic sur cette div est le onClick de la rangée porteat.
      <div role="button" onClick={() => onSelect()}>
        <HackerNewsDiscussionLink article={hnItemArticle} className="inline-flex" />
      </div>,
    );
    fireEvent.click(container.querySelector('a') as Element);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('un clic TOUT COURT de la rangée reste disponible : clic sur un autre enfant', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <div role="button" onClick={() => onSelect()}>
        <span>titre</span>
        <HackerNewsDiscussionLink article={hnItemArticle} className="inline-flex" />
      </div>,
    );
    fireEvent.click(container.querySelector('span') as Element);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
