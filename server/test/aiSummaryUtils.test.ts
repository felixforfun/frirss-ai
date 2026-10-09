import { describe, expect, it } from 'vitest';
import { aiConfigHash, aiContentHash, cleanArticleHtml, normalizeAiEndpoint } from '../aiSummaryUtils.js';

describe('AI summary utilities', () => {
  it('normalizes a base endpoint and preserves an explicit completions endpoint', () => {
    expect(normalizeAiEndpoint(' https://openrouter.ai/api/v1/ ')).toBe('https://openrouter.ai/api/v1');
    expect(normalizeAiEndpoint('https://example.com/v1/chat/completions')).toBe('https://example.com/v1/chat/completions');
  });

  it('rejects non-HTTP protocols and credentials in endpoint URLs', () => {
    expect(() => normalizeAiEndpoint('file:///etc/passwd')).toThrow();
    expect(() => normalizeAiEndpoint('http://user:pass@example.com/v1')).toThrow();
  });

  it('removes executable and non-article elements and bounds text', () => {
    expect(cleanArticleHtml('<p>Hello&nbsp;world</p><script>alert(1)</script><style>bad</style><noscript>no</noscript>'))
      .toBe('Hello world');
  });

  it('keeps paragraph boundaries in normalized text', () => {
    expect(cleanArticleHtml('<p>First paragraph</p><p>Second paragraph</p>')).toBe('First paragraph\nSecond paragraph');
  });

  it('invalidates content if any content sent to the model changes', () => {
    const initial = aiContentHash({ title: 'A', url: 'https://example.com/a', content: 'Body' });
    expect(aiContentHash({ title: 'B', url: 'https://example.com/a', content: 'Body' })).not.toBe(initial);
    expect(aiContentHash({ title: 'A', url: 'https://example.com/b', content: 'Body' })).not.toBe(initial);
    expect(aiContentHash({ title: 'A', url: 'https://example.com/a', content: 'Changed' })).not.toBe(initial);
  });

  it('invalidates summaries when model, prompt, or generation settings change', () => {
    const base = { model: 'model-a', prompt: 'brief', temperature: 0.2 };
    expect(aiConfigHash(base)).toBe(aiConfigHash(base));
    expect(aiConfigHash({ ...base, model: 'model-b' })).not.toBe(aiConfigHash(base));
    expect(aiConfigHash({ ...base, prompt: 'detailed' })).not.toBe(aiConfigHash(base));
  });
});
