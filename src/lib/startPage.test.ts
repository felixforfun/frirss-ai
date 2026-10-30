// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { saveStartPage, clearStartPage, loadStartPage, targetsEqual, resumeTarget, type StartPageTarget } from './startPage';
import type { Subscription } from '../types';

const feedTarget: StartPageTarget = { kind: 'feed', id: 'feed/42', title: 'Example' };

describe('startPage — store & load', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips a feed target per server', () => {
    saveStartPage('srv1', feedTarget);
    expect(loadStartPage('srv1')).toEqual(feedTarget);
  });

  it('round-trips a filter target, including computed views', () => {
    for (const filter of ['all', 'unread', 'interesting', 'infrequent', 'recentlyread', 'starred', 'readlater'] as const) {
      saveStartPage('srv1', { kind: 'filter', filter });
      expect(loadStartPage('srv1')).toEqual({ kind: 'filter', filter });
    }
  });

  it('keeps targets independent per server', () => {
    saveStartPage('srv1', feedTarget);
    expect(loadStartPage('srv2')).toBeNull();
  });

  it('handles a null server id via a stable "default" key', () => {
    saveStartPage(null, { kind: 'filter', filter: 'starred' });
    expect(loadStartPage(undefined)).toEqual({ kind: 'filter', filter: 'starred' });
  });

  it('returns null when nothing is stored', () => {
    expect(loadStartPage('srv1')).toBeNull();
  });

  it('returns null on corrupt JSON', () => {
    localStorage.setItem('frirss_startPage_srv1', '{not json');
    expect(loadStartPage('srv1')).toBeNull();
  });

  it('rejects a filter value outside the valid set', () => {
    // Whatever a future or older version might have written must behave
    // as if no start page was configured.
    localStorage.setItem('frirss_startPage_srv1', JSON.stringify({ kind: 'filter', filter: 'bogus' }));
    expect(loadStartPage('srv1')).toBeNull();
  });

  it('rejects a feed target with an empty id', () => {
    localStorage.setItem('frirss_startPage_srv1', JSON.stringify({ kind: 'feed', id: '', title: 'Ghost' }));
    expect(loadStartPage('srv1')).toBeNull();
  });

  it('rejects an unknown kind', () => {
    localStorage.setItem('frirss_startPage_srv1', JSON.stringify({ kind: 'category', id: 'x' }));
    expect(loadStartPage('srv1')).toBeNull();
  });

  it('clears the preference', () => {
    saveStartPage('srv1', feedTarget);
    clearStartPage('srv1');
    expect(loadStartPage('srv1')).toBeNull();
  });
});

describe('startPage — targetsEqual', () => {
  it('compares feeds by id, so a rename keeps the start page shown as set', () => {
    expect(targetsEqual(feedTarget, { kind: 'feed', id: 'feed/42', title: 'Example (renamed)' })).toBe(true);
    expect(targetsEqual(feedTarget, { kind: 'feed', id: 'feed/43', title: 'Example' })).toBe(false);
  });

  it('compares filters by filter value', () => {
    expect(targetsEqual({ kind: 'filter', filter: 'unread' }, { kind: 'filter', filter: 'unread' })).toBe(true);
    expect(targetsEqual({ kind: 'filter', filter: 'unread' }, { kind: 'filter', filter: 'all' })).toBe(false);
  });

  it('never equals across kinds', () => {
    expect(targetsEqual(feedTarget, { kind: 'filter', filter: 'starred' })).toBe(false);
  });

  it('is false when either side is unset', () => {
    expect(targetsEqual(feedTarget, null)).toBe(false);
    expect(targetsEqual(null, feedTarget)).toBe(false);
  });
});

describe('startPage — resumeTarget', () => {
  const subscriptions = [
    { id: 'feed/1', title: 'One' },
    { id: 'feed/42', title: 'Example (renamed)' },
  ] as Subscription[];

  it('resolves a live feed to its current subscription, and lets its own unread preference decide', () => {
    expect(resumeTarget(feedTarget, subscriptions)).toEqual({
      feed: subscriptions[1],
      filter: null,
      homeAll: false,
    });
  });

  it('returns null for a deleted feed — the caller falls back to the default startup', () => {
    const deleted: StartPageTarget = { kind: 'feed', id: 'feed/999', title: 'Bye' };
    expect(resumeTarget(deleted, subscriptions)).toBeNull();
    expect(resumeTarget(deleted, [])).toBeNull();
  });

  it('restores "all" through the home-entry path', () => {
    expect(resumeTarget({ kind: 'filter', filter: 'all' }, subscriptions)).toEqual({
      feed: null, filter: 'all', homeAll: true,
    });
  });

  it('restores other global views as a plain home view', () => {
    expect(resumeTarget({ kind: 'filter', filter: 'recentlyread' }, subscriptions)).toEqual({
      feed: null, filter: 'recentlyread', homeAll: false,
    });
  });

  it('returns null for an unset preference', () => {
    expect(resumeTarget(null, subscriptions)).toBeNull();
  });
});
