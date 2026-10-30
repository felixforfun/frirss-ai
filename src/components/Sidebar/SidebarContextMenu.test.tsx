// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { SidebarContextMenu } from './Sidebar';
import type { MenuTarget } from './Sidebar';
import type { Subscription } from '../../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

// Disconnected from the two stores involved: the menu only reads accessors
// there, and the tests observe the effects through the spies below.
vi.mock('../../stores/feedStore', () => ({
  useFeedStore: Object.assign(
    (sel?: (s: unknown) => unknown) => (sel ? sel({}) : {}),
    { getState: () => ({}) },
  ),
  getSampleArticleUrl: () => 'https://example.com/1',
}));

const pushToast = vi.fn();
const noop = () => {};
const uiStoreState = () => ({
  feedSettings: {},
  setFeedAutoExtract: noop,
  setFeedLayout: noop,
  pushToast,
});

vi.mock('../../stores/uiStore', () => ({
  useUiStore: Object.assign(
    (sel: (s: unknown) => unknown) => sel(uiStoreState()),
    { getState: () => uiStoreState() },
  ),
}));

vi.mock('../../stores/authStore', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ activeServerId: 'srv1', logout: noop }),
}));

const feed = { id: 'feed/1', title: 'The Register' } as Subscription;

function renderMenu(target: MenuTarget) {
  return render(
    <SidebarContextMenu
      target={target}
      x={10}
      y={10}
      onRename={vi.fn(async () => true)}
      onDelete={vi.fn(async () => true)}
      onClose={vi.fn()}
    />,
  );
}

const container = () => document.body.querySelector('.py-1')!;

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('menu on a subscribed feed', () => {
  it('shows every action, header included, in the required order', () => {
    renderMenu({ kind: 'feed', feed });
    const text = container().textContent ?? '';
    const order = [
      'The Register',
      'sidebar.rename',
      'sidebar.openSite',
      'sidebar.autoExtract',
      'sidebar.startPage',
      'sidebar.feedLayoutThisFeed',
      'sidebar.unsubscribe',
    ];
    let last = -1;
    for (const part of order) {
      const i = text.indexOf(part);
      expect(i, `${part} after index ${last}`).toBeGreaterThan(last);
      last = i;
    }
  });

  it('shows the feed name in the header', () => {
    renderMenu({ kind: 'feed', feed });
    expect(container().textContent).toContain('The Register');
  });

  it('opens the rename page in place', () => {
    renderMenu({ kind: 'feed', feed });
    fireEvent.click(screen.getByText('sidebar.rename').closest('button')!);
    const field = document.body.querySelector('input[type="text"]') as HTMLInputElement;
    expect(field).toBeTruthy();
    expect(field.value).toBe('The Register');
  });
});

describe('menu on a global or virtual view', () => {
  const view: MenuTarget = {
    kind: 'view',
    title: 'recently-read-title',
    target: { kind: 'filter', filter: 'recentlyread' },
  };

  it('offers no individual-feed action — no arbitrary feed can be renamed or unsubscribed', () => {
    renderMenu(view);
    const text = container().textContent ?? '';
    expect(text).not.toContain('sidebar.rename');
    expect(text).not.toContain('sidebar.openSite');
    expect(text).not.toContain('sidebar.autoExtract');
    expect(text).not.toContain('sidebar.unsubscribe');
    expect(text).not.toContain('sidebar.feedLayoutThisFeed');
  });

  it('anchors the menu to the view itself, and offers the start page', () => {
    renderMenu(view);
    expect(container().textContent).toContain('recently-read-title');
    expect(container().textContent).toContain('sidebar.startPage');
  });

  it('reuses the existing menu skeleton — same floating container, dimensions, padding', () => {
    renderMenu(view);
    const el = container() as HTMLElement;
    expect(el.style.position).toBe('fixed'); // same floating behaviour
    expect(el.style.minWidth).toBe('236px'); // same width as the feed menu
    expect(el.className).toContain('py-1');
  });

  it('never reaches a per-feed action page: no rename form exists', () => {
    renderMenu(view);
    expect(document.body.querySelector('input[type="text"]')).toBeNull();
  });
});

describe('« Set as start page » — preference behaviour', () => {
  it('saves the feed destination, with a confirmation toast', () => {
    renderMenu({ kind: 'feed', feed });
    fireEvent.click(screen.getByText('sidebar.startPage').closest('button')!);
    expect(JSON.parse(localStorage.getItem('frirss_startPage_srv1')!)).toEqual({
      kind: 'feed', id: 'feed/1', title: 'The Register',
    });
    expect(pushToast).toHaveBeenCalledWith('toast.startPageSet');
  });

  it('saves the global-view destination', () => {
    renderMenu({ kind: 'view', title: 'V', target: { kind: 'filter', filter: 'starred' } });
    fireEvent.click(screen.getByText('sidebar.startPage').closest('button')!);
    expect(JSON.parse(localStorage.getItem('frirss_startPage_srv1')!)).toEqual({
      kind: 'filter', filter: 'starred',
    });
  });

  it('when the context is already the start page: ✓ marker, and a click clears it', () => {
    // A stale stored title must not hide the state: identity goes by feed id.
    localStorage.setItem(
      'frirss_startPage_srv1',
      JSON.stringify({ kind: 'feed', id: 'feed/1', title: 'Older name' }),
    );
    renderMenu({ kind: 'feed', feed });
    const btn = [...container().querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('sidebar.startPage'))!;
    expect(btn.textContent).toBe('✓ sidebar.startPage');
    fireEvent.click(btn);
    expect(localStorage.getItem('frirss_startPage_srv1')).toBeNull();
    expect(pushToast).toHaveBeenCalledWith('toast.startPageCleared');
  });

  it('choosing another destination replaces the preference', () => {
    localStorage.setItem(
      'frirss_startPage_srv1',
      JSON.stringify({ kind: 'feed', id: 'feed/9', title: 'Other' }),
    );
    renderMenu({ kind: 'feed', feed });
    const btn = screen.getByText('sidebar.startPage').closest('button')!;
    expect(btn.textContent).toBe('sidebar.startPage');
    fireEvent.click(btn);
    expect(JSON.parse(localStorage.getItem('frirss_startPage_srv1')!)).toEqual({
      kind: 'feed', id: 'feed/1', title: 'The Register',
    });
  });
});
