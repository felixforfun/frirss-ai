// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { FilterItem, FEED_LONG_PRESS_MS } from './Sidebar';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('../../stores/feedStore', () => ({
  useFeedStore: Object.assign(
    (sel?: (s: unknown) => unknown) => (sel ? sel({}) : {}),
    { getState: () => ({}) },
  ),
}));

function renderRow(on: { onClick?: () => void; onOpenMenu?: (r: DOMRect) => void; count?: number } = {}) {
  return render(
    <div>
      <FilterItem
        icon={<span />}
        label="All feeds"
        active={false}
        count={on.count}
        onClick={on.onClick ?? (() => {})}
        onOpenMenu={on.onOpenMenu}
      />
    </div>,
  );
}

const row = (c: ReturnType<typeof render>) => c.getByRole('button', { name: /All feeds/ });

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); cleanup(); });

describe('menu affordance of a global-view row', () => {
  it('opens the menu after the long-press delay — the only touch path', () => {
    const onOpenMenu = vi.fn();
    const c = renderRow({ onOpenMenu });
    fireEvent.touchStart(row(c));
    vi.advanceTimersByTime(FEED_LONG_PRESS_MS);
    expect(onOpenMenu).toHaveBeenCalledTimes(1);
  });

  it('opens nothing before the delay', () => {
    const onOpenMenu = vi.fn();
    const c = renderRow({ onOpenMenu });
    fireEvent.touchStart(row(c));
    vi.advanceTimersByTime(FEED_LONG_PRESS_MS - 50);
    fireEvent.touchEnd(row(c));
    vi.advanceTimersByTime(200);
    expect(onOpenMenu).not.toHaveBeenCalled();
  });

  it('cancelled by a swipe — a scroll must not open anything', () => {
    const onOpenMenu = vi.fn();
    const c = renderRow({ onOpenMenu });
    fireEvent.touchStart(row(c));
    fireEvent.touchMove(row(c));
    vi.advanceTimersByTime(FEED_LONG_PRESS_MS);
    expect(onOpenMenu).not.toHaveBeenCalled();
  });

  it('the click ending a long press must not navigate behind the menu', () => {
    const onClick = vi.fn();
    const c = renderRow({ onClick, onOpenMenu: vi.fn() });
    fireEvent.touchStart(row(c));
    vi.advanceTimersByTime(FEED_LONG_PRESS_MS);
    fireEvent.touchEnd(row(c));
    fireEvent.click(row(c));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('a plain click still navigates', () => {
    const onClick = vi.fn();
    const c = renderRow({ onClick, onOpenMenu: vi.fn() });
    fireEvent.click(row(c));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('rows without the affordance keep the exact previous behaviour', () => {
    // Saved-category rows have no menu: touch gestures are inert, nothing
    // is armed, nothing fires.
    const onClick = vi.fn();
    const c = renderRow({ onClick });
    const b = row(c);
    fireEvent.touchStart(b);
    vi.advanceTimersByTime(FEED_LONG_PRESS_MS + 1000);
    fireEvent.touchEnd(b);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('the ⋯ button replaced the count at hover and opens the menu', () => {
    const onOpenMenu = vi.fn();
    const c = renderRow({ onOpenMenu, count: 3 });
    const b = row(c);
    // Idle: the count is visible.
    expect(b.textContent).toContain('3');
    fireEvent.mouseEnter(b);
    fireEvent.click(b.querySelector('span[title="sidebar.menuButton"]')!);
    expect(onOpenMenu).toHaveBeenCalledTimes(1);
  });
});
