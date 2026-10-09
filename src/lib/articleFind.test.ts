// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { findTextRanges } from './articleFind';

describe('findTextRanges', () => {
  it('finds case-insensitive matches across text nodes without changing markup', () => {
    const root = document.createElement('article');
    root.innerHTML = '<p>Climate <strong>change</strong> is here. Climate matters.</p>';
    const before = root.innerHTML;

    const ranges = findTextRanges(root, 'climate');
    expect(ranges).toHaveLength(2);
    expect(ranges.map((range) => range.toString())).toEqual(['Climate', 'Climate']);
    expect(root.innerHTML).toBe(before);
  });

  it('returns no matches for an empty query and skips interactive UI text', () => {
    const root = document.createElement('article');
    root.innerHTML = '<p>Article content</p><button>Search</button><input value="Article">';
    expect(findTextRanges(root, '   ')).toHaveLength(0);
    expect(findTextRanges(root, 'Article')).toHaveLength(1);
  });

  it('finds multiple non-overlapping matches inside one text node', () => {
    const root = document.createElement('article');
    root.textContent = 'foo foo foo';
    expect(findTextRanges(root, 'foo')).toHaveLength(3);
  });
});
