// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import MarkdownSummary from './MarkdownSummary';

describe('MarkdownSummary', () => {
  it('renders bold, italic, inline code and strike-through', () => {
    render(<MarkdownSummary markdown="**Important** and *emphasis*, `code`, ~~old~~" />);
    expect(screen.getByText('Important').tagName).toBe('STRONG');
    expect(screen.getByText('emphasis').tagName).toBe('EM');
    expect(screen.getByText('code').tagName).toBe('CODE');
    expect(screen.getByText('old').tagName).toBe('DEL');
  });

  it('renders unordered and ordered lists as semantic lists', () => {
    const { container } = render(<MarkdownSummary markdown={'- First\n- **Second**\n\n1. Third\n2. Fourth'} />);
    expect(container.querySelectorAll('ul > li')).toHaveLength(2);
    expect(container.querySelectorAll('ol > li')).toHaveLength(2);
    expect(screen.getByText('Second').tagName).toBe('STRONG');
  });

  it('renders headings, paragraph breaks and thematic separators', () => {
    const { container } = render(<MarkdownSummary markdown={'## Key points\n\nFirst paragraph\n\n---\n\nSecond paragraph'} />);
    expect(screen.getByRole('heading', { name: 'Key points' })).toBeTruthy();
    expect(container.querySelector('hr')).toBeTruthy();
    expect(screen.getByText('First paragraph').tagName).toBe('P');
    expect(screen.getByText('Second paragraph').tagName).toBe('P');
  });

  it('creates safe external links and does not make javascript URLs clickable', () => {
    const { container } = render(<MarkdownSummary markdown={'[Source](https://example.com) [unsafe](javascript:alert(1))'} />);
    const link = screen.getByRole('link', { name: 'Source' });
    expect(link.getAttribute('href')).toBe('https://example.com');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(screen.getByText('unsafe')).toBeTruthy();
  });

  it('treats raw HTML as text rather than injecting it', () => {
    const { container } = render(<MarkdownSummary markdown={'<img src=x onerror=alert(1)> **safe**'} />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('safe').tagName).toBe('STRONG');
  });

  it('uses the reading-body CSS size variable so the toolbar size control affects summaries', () => {
    const { container } = render(<MarkdownSummary markdown="A summary paragraph." />);
    expect((container.firstElementChild as HTMLElement).style.fontSize).toBe('var(--fs-reading-body)');
  });

  it('renders model-style star bullets with bold labels', () => {
    const { container } = render(<MarkdownSummary markdown={'* **Dispute:** Point one\n* **Impact:** Point two'} />);
    expect(container.querySelectorAll('ul > li')).toHaveLength(2);
    expect(screen.getByText('Dispute:').tagName).toBe('STRONG');
    expect(screen.getByText('Impact:').tagName).toBe('STRONG');
  });
});
