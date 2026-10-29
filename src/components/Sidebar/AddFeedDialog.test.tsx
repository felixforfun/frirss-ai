// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import AddFeedDialog from './AddFeedDialog';

// Text under test is the i18n KEY: the copy itself is guarded by
// i18nCoverage.test.ts (key exists in all 10 locales).
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

const { addFeed, onClose } = vi.hoisted(() => ({
  addFeed: vi.fn(),
  onClose: vi.fn(),
}));

vi.mock('../../stores/feedStore', () => ({
  useFeedStore: () => ({ subscriptions: [], addFeed }),
}));

async function submit(url: string) {
  const { container } = render(<AddFeedDialog onClose={onClose} />);
  fireEvent.change(container.querySelector('input[type="url"]')!, { target: { value: url } });
  fireEvent.submit(container.querySelector('form')!);
  return container;
}

describe('AddFeedDialog — message affiché selon l’issue de addFeed', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it("annonce « déjà abonné » quand addFeed le signale, sans fermer", async () => {    // Régression incident 2026-10-16 : le doublon affichait le message
    // générique « Error adding feed » — un échec qui n'en était pas un.
    addFeed.mockResolvedValue('already-subscribed');
    const container = await submit('https://example.com/feed.xml');
    await waitFor(() => expect(container.textContent).toContain('addFeed.alreadySubscribed'));
    expect(container.textContent).not.toContain('addFeed.error');
    expect(onClose).not.toHaveBeenCalled();
  });

  it("reste sur l'erreur générique pour un échec ordinaire", async () => {
    addFeed.mockResolvedValue('error');
    const container = await submit('https://example.com/feed.xml');
    await waitFor(() => expect(container.textContent).toContain('addFeed.error'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('ferme le dialogue quand le flux est ajouté', async () => {
    addFeed.mockResolvedValue('added');
    await submit('https://example.com/feed.xml');
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});

describe('AddFeedDialog — prefilled from a preview (briefing §8)', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it('prefills URL and title at mount when provided', () => {
    const { container } = render(
      <AddFeedDialog onClose={onClose} initialUrl="https://thenewstack.io/feed" initialTitle="The New Stack" />,
    );
    expect((container.querySelector('input[type="url"]') as HTMLInputElement).value).toBe('https://thenewstack.io/feed');
    expect((container.querySelector('input[type="text"]') as HTMLInputElement).value).toBe('The New Stack');
  });

  it('appelle onAdded (et pas seulement onClose) quand l\'ajout réussit', async () => {
    const onAdded = vi.fn();
    const { container } = render(
      <AddFeedDialog onClose={onClose} initialUrl="https://thenewstack.io/feed" onAdded={onAdded} />,
    );
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onAdded for a duplicate', async () => {
    const onAdded = vi.fn();
    addFeed.mockResolvedValue('already-subscribed');
    const { container } = render(
      <AddFeedDialog onClose={onClose} initialUrl="https://dup.example.org/feed" onAdded={onAdded} />,
    );
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(container.textContent).toContain('addFeed.alreadySubscribed'));
    expect(onAdded).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
