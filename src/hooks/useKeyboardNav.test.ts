// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useKeyboardNav } from './useKeyboardNav';
import { useFeedStore } from '../stores/feedStore';
import { useUiStore } from '../stores/uiStore';

const article = { id: 'article-1', title: 'Test article' } as never;
const originalSelectArticle = useFeedStore.getState().selectArticle;

function pressKey(key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  act(() => { window.dispatchEvent(event); });
  return event;
}

beforeEach(() => {
  useUiStore.setState({
    readingFocus: false,
    panelLayout: '3',
    shortcuts: { ...useUiStore.getState().shortcuts, backToList: 'Escape' },
  });
  useFeedStore.setState({ selectedArticle: null, selectArticle: originalSelectArticle });
});

afterEach(() => {
  cleanup();
  useUiStore.setState({
    readingFocus: false,
    shortcuts: { ...useUiStore.getState().shortcuts, backToList: 'Escape' },
  });
  useFeedStore.setState({ selectedArticle: null, selectArticle: originalSelectArticle });
});

describe('useKeyboardNav — back to list', () => {
  it('Escape closes the selected article in list/split view, not only grid layout', () => {
    const selectArticle = vi.fn();
    useFeedStore.setState({ selectedArticle: article, selectArticle } as never);
    renderHook(() => useKeyboardNav());

    const event = pressKey('Escape');

    expect(event.defaultPrevented).toBe(true);
    expect(selectArticle).toHaveBeenCalledWith(null);
  });

  it('uses the reassigned shortcut instead of hard-coding Escape', () => {
    const selectArticle = vi.fn();
    useFeedStore.setState({ selectedArticle: article, selectArticle } as never);
    useUiStore.setState({
      shortcuts: { ...useUiStore.getState().shortcuts, backToList: 'Backspace' },
    });
    renderHook(() => useKeyboardNav());

    pressKey('Escape');
    expect(selectArticle).not.toHaveBeenCalled();

    const event = pressKey('Backspace');
    expect(event.defaultPrevented).toBe(true);
    expect(selectArticle).toHaveBeenCalledWith(null);
  });
});
