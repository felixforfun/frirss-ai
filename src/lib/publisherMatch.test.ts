import { describe, it, expect } from 'vitest';
import { feedUrlsEquivalent, matchPublication, normalizeFeedUrl, siteHost } from './publisherMatch';
import type { Subscription } from '../types';

const sub = (id: string, url?: string, htmlUrl?: string): Subscription =>
  ({ id, title: id, ...(url !== undefined ? { url } : {}), ...(htmlUrl !== undefined ? { htmlUrl } : {}) });

describe('normalizeFeedUrl', () => {
  it('is case-insensitive on the hostname', () => {
    expect(feedUrlsEquivalent('https://EXAMPLE.com/feed/', 'https://example.com/feed/')).toBe(true);
  });

  it('equates http and https', () => {
    expect(feedUrlsEquivalent('http://example.com/feed', 'https://example.com/feed')).toBe(true);
  });

  it('ignores a trailing slash', () => {
    expect(feedUrlsEquivalent('https://example.com/feed', 'https://example.com/feed/')).toBe(true);
  });

  it('strips default ports', () => {
    expect(feedUrlsEquivalent('https://example.com:443/feed', 'https://example.com/feed')).toBe(true);
    expect(feedUrlsEquivalent('http://example.com:80/feed', 'https://example.com/feed')).toBe(true);
  });

  it('keeps non-default ports distinct', () => {
    expect(feedUrlsEquivalent('https://example.com:8443/feed', 'https://example.com/feed')).toBe(false);
  });

  it('does NOT strip query parameters — a different query may be a different content set', () => {
    expect(feedUrlsEquivalent('https://example.com/feed?edition=us', 'https://example.com/feed?edition=de')).toBe(false);
  });

  it('does NOT merge different paths', () => {
    expect(feedUrlsEquivalent('https://example.com/atom.xml', 'https://example.com/rss.xml')).toBe(false);
  });

  it('rejects non-http(s) schemes', () => {
    expect(feedUrlsEquivalent('file:///etc/passwd', 'file:///etc/passwd')).toBe(false);
    expect(normalizeFeedUrl('javascript:alert(1)')).toBeNull();
  });
});

describe('siteHost', () => {
  it('lowercases and drops www.', () => {
    expect(siteHost('https://WWW.TheNewStack.IO/feed')).toBe('thenewstack.io');
  });

  it('returns empty for garbage input', () => {
    expect(siteHost('not a url')).toBe('');
  });
});

describe('matchPublication', () => {
  const subs = [
    sub('welt', 'https://www.welt.de/feeds/index.rss', 'https://www.welt.de/'),
    sub('welt-wirtschaft', 'https://www.welt.de/feeds/wirtschaft.rss', 'https://www.welt.de/'),
    sub('newstack', 'http://thenewstack.io/feed', 'https://thenewstack.io'),
  ];

  it('matches an existing subscription ONLY by normalized feed URL', () => {
    expect(matchPublication(subs, 'https://www.welt.de/feeds/index.rss', null).exact?.id).toBe('welt');
  });

  it('does NOT claim a same-host feed as exact — same host is not proof', () => {
    const m = matchPublication(subs, 'https://www.welt.de/other-feed', 'https://www.welt.de/');
    expect(m.exact).toBeUndefined();
    // Les DEUX fils welt partagent le site : l'appariement doit rester
    // AMBIGUOUS — neither implicitly chosen nor skipped (briefing §5).
    expect(m.siteCandidates.map((s) => s.id)).toEqual(['welt', 'welt-wirtschaft']);
  });

  it('scopes to the given subscription list only (server/user isolation)', () => {
    expect(matchPublication([], 'https://www.welt.de/feeds/index.rss', null).exact).toBeUndefined();
    expect(matchPublication(subs, 'https://other-server.example.org/feed', null)).toEqual({ siteCandidates: [] });
  });

  it('never matches when the resolved feed URL is unknown', () => {
    expect(matchPublication(subs, null, 'https://www.welt.de/').siteCandidates.map((s) => s.id)).toEqual(['welt', 'welt-wirtschaft']);
  });
});
