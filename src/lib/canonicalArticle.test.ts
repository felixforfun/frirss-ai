import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { canonicalOrSelf, canonicalPathKey, canonicalTargetFor, isTechmemePermalinkUrl, resolveCanonicalArticle } from './canonicalArticle';

vi.mock('../api/backend', () => ({
  resolveTechmemeArticleUrl: vi.fn(),
}));

import { resolveTechmemeArticleUrl } from '../api/backend';
const fetchTechmeme = vi.mocked(resolveTechmemeArticleUrl);

const feedResolve = (url: string) => resolveCanonicalArticle(url, fetchTechmeme as unknown as (u: string) => Promise<string | null>);

beforeEach(() => {
  fetchTechmeme.mockReset();
});

describe('isTechmemePermalinkUrl', () => {
  it('accepts story permalinks in both shapes, any Techmeme host', () => {
    for (const url of ['https://www.techmeme.com/261023/p28#a261023p28', 'http://techmeme.com/p3', 'https://www.techmeme.com/261023/p28']) {
      expect(isTechmemePermalinkUrl(url), url).toBe(true);
    }
  });

  it('rejects non-Techmeme and non-permalink URLs', () => {
    for (const url of ['https://www.androidauthority.com/a-1/', 'https://www.techmeme.com/', 'https://www.techmeme.com/feed.xml', 'https://www.techmeme.com/261023/p28/extra']) {
      expect(isTechmemePermalinkUrl(url), url).toBe(false);
    }
    expect(isTechmemePermalinkUrl(undefined)).toBe(false);
  });
});

describe('resolveCanonicalArticle', () => {
  it('resolves a Techmeme story to the publisher target', async () => {
    fetchTechmeme.mockResolvedValueOnce('https://www.androidauthority.com/google-personal-intelligence-privacy-3727111/');
    const target = await feedResolve('https://www.techmeme.com/261023/p28#a261023p28');
    expect(target).toEqual({ url: 'https://www.androidauthority.com/google-personal-intelligence-privacy-3727111/', publisher: 'androidauthority.com' });
  });

  it('never resolves the same Techmeme story twice in concurrently or sequentially', async () => {
    fetchTechmeme.mockResolvedValue('https://www.theguardian.com/tech/2026/oct/24/story');
    const [a, b] = await Promise.all([
      feedResolve('https://www.techmeme.com/261023/p27'),
      feedResolve('https://www.techmeme.com/261023/p27#a261023p27'),
    ]);
    await feedResolve('https://techmeme.com/261023/p27');
    expect(a).toEqual(b);
    expect(fetchTechmeme).toHaveBeenCalledTimes(1);
    // Fragment/host variants share one entry and re-serve it from memory.
    expect(fetchTechmeme.mock.calls[0]?.[0]).toBe('https://www.techmeme.com/261023/p27');
  });

  it('skips non-Techmeme articles without touching the API', async () => {
    expect(await feedResolve('https://www.androidauthority.com/google-personal-intelligence-3727111/')).toBeNull();
    expect(fetchTechmeme).not.toHaveBeenCalled();
  });

  it('returns null on resolver failure and does not cache a fake miss', async () => {
    fetchTechmeme.mockRejectedValueOnce(new Error('timeout'));
    expect(await feedResolve('https://www.techmeme.com/261023/p26')).toBeNull();
    expect(canonicalTargetFor('https://www.techmeme.com/261023/p26')).toBeNull();
  });
});

describe('canonical helpers', () => {
  it('keeps the path key stable across host and fragment variants', () => {
    expect(canonicalPathKey('https://www.techmeme.com/261023/p28#a261023p28')).toBe('/261023/p28');
    expect(canonicalPathKey('http://techmeme.com/261023/p28')).toBe('/261023/p28');
  });

  it('canonicalOrSelf passes ordinary articles through unchanged', () => {
    expect(canonicalOrSelf({ url: 'https://example.com/a', canonicalUrl: 'https://example.com/original' })).toBe('https://example.com/original');
    expect(canonicalOrSelf({ url: 'https://example.com/a' })).toBe('https://example.com/a');
    expect(canonicalOrSelf({ url: '' })).toBe('');
  });
});
