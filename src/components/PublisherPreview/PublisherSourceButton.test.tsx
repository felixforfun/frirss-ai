// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { PublisherSourceButton } from './PublisherSourceButton';
import type { Article } from '../../types';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('../../stores/previewStore', () => ({
  usePreviewStore: (selector: (s: unknown) => unknown) =>
    selector({ openPublisher }),
}));
const openPublisher = vi.fn();

const article: Article = {
  id: 'item/1', title: 'T', summary: '', content: '', author: '',
  url: 'https://x/a', source: 'Example', sourceId: 'feed/https://x/feed',
  published: 0, read: false, starred: false, labels: [], tags: [],
};

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe('PublisherSourceButton', () => {
  it('clicking the publisher label opens the publisher, NOT the row', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onPointerDown={onSelect}
      >
        <PublisherSourceButton article={article} className="font-medium" style={{}}>
          {article.source}
        </PublisherSourceButton>
      </div>,
    );
    const btn = container.querySelector('button')!;
    fireEvent.pointerDown(btn);
    fireEvent.click(btn);
    expect(openPublisher).toHaveBeenCalledWith(article);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('keyboard activation works and does not propagate', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <div role="button" tabIndex={0} onClick={onSelect}>
        <PublisherSourceButton article={article} className="" style={{}}>
          {article.source}
        </PublisherSourceButton>
      </div>,
    );
    const btn = container.querySelector('button')!;
    fireEvent.keyDown(btn, { key: 'Enter' });
    expect(openPublisher).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
