import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  SEMANTIC_TAU,
  SEMANTIC_TEXT_MAX_CHARS,
  cleanForEmbedding,
  cosine,
  embeddingCacheKey,
  embeddingText,
  softBalancedMarginScore,
  unit,
  unescapeHtml,
} from '../semanticScoring.js';

/**
 * Reference values produced by the AUDIT's own implementation
 * (`/tmp/frirss-semantic-eval/audit-suite.py`: renorm_rows + score_soft_margin)
 * run on these exact vectors — seeded RandomState(42), 3 dimensions, 6
 * references (4 up, 2 down), 4 candidates. The TypeScript port must reproduce
 * them to floating-point precision, not approximately.
 */
const X_POOL: number[][] = [
  [-0.407417778168008, -0.6336810351269563, 0.6576162252811844],
  [-0.15634329259084795, 0.046761249258260196, -0.986595236370853],
  [-0.42594389475084443, 0.0867896752566488, -0.9005772319980818],
  [0.49036498797056294, -0.7839599081560673, -0.38072173693730726],
];
const X_REF: number[][] = [
  [0.6000020458127243, -0.16701530057610703, 0.7823703946303298],
  [0.977171326349286, -0.15023209347136074, -0.1502215598773674],
  [0.8688969434724488, 0.4222494168788285, -0.2583089846864122],
  [0.6367516175402981, -0.5438696951305717, -0.5465831430609553],
  [0.09351637279656137, -0.7394666427360134, -0.6666661625579204],
  [-0.46845169119, -0.8438075300211552, 0.26180501389550576],
];
const Y_REF: number[] = [1, 1, 1, 1, -1, -1];
const S_EXPECTED: number[][] = [
  [0.37588239383837574, -0.4017058773328958, -0.7914436892017417, -0.27422596122070164, -0.007924730560326165, 0.897727601273052],
  [-0.8734990439236564, -0.011591347581008382, 0.13874511497062528, 0.41427245439773386, 0.6085306185959659, -0.22451379398423135],
  [-0.9746473763452677, -0.2939726386087756, -0.1008272680424123, 0.17381759584831713, 0.49637356950507305, -0.10947527839879648],
  [0.12728788010558684, 0.6541391570922914, 0.19339387047457007, 0.9467088191256358, 0.8793836557116177, 0.3321241061924157],
];
const SOFT_EXPECTED = [-0.5565024455585281, -0.22870378117169682, -0.3570039280363715, 0.032810528443679154];

/** Reference cache keys and texts produced by the audit helper's clean() + cache-key formula. */
const CLEAN_SAMPLES: Array<{ title: string; summary: string; text: string; key: string }> = [
  {
    title: 'The &amp;quot;Quick&amp;quot; Fox',
    summary: '<p>A story about <b>PHP</b> &amp; security.<script>alert(1)</script></p>',
    text: 'The &quot;Quick&quot; Fox\nA story about PHP & security.',
    key: 'eed78cb1a7c23abe2061051025991af864fcdc8bda0d9593753c04ac7cb68d50',
  },
  {
    title: 'Footnote',
    summary: 'Caf&eacute; r&eacute;sum&eacute; &mdash; na&iuml;ve fa&ccedil;ade   test   text',
    text: 'Footnote\nCafé résumé — naïve façade test text',
    key: '5a384c7f3a598cf4ae12b3c549bd49a73c489c5cf6b5d81b848b00cd5c6b7d4d',
  },
  {
    title: 'No summary here',
    summary: '',
    text: 'No summary here\n',
    key: '9246ecd3eec28f22ca8b0a78acbc62a388a52196b3da863fb67ce2eb7daf265f',
  },
];

describe('audit formula parity', () => {
  it('reproduces the audited cosine similarity matrix', () => {
    const positives = X_REF.filter((_, index) => Y_REF[index] === 1);
    const negatives = X_REF.filter((_, index) => Y_REF[index] === -1);
    for (let row = 0; row < X_POOL.length; row++) {
      for (let ref = 0; ref < X_REF.length; ref++) {
        expect(cosine(X_POOL[row], X_REF[ref])).toBeCloseTo(S_EXPECTED[row][ref], 12);
      }
    }
    // The ported score consumes the similarities per class, in reference order.
    const sims = X_POOL.map((candidate) => [
      positives.map((ref) => cosine(candidate, ref)),
      negatives.map((ref) => cosine(candidate, ref)),
    ]);
    expect(sims[0][0]).toHaveLength(4);
    expect(sims[0][1]).toHaveLength(2);
  });

  it('reproduces the audited soft balanced margin scores', () => {
    for (let row = 0; row < X_POOL.length; row++) {
      const toPositives = S_EXPECTED[row].filter((_, index) => Y_REF[index] === 1);
      const toNegatives = S_EXPECTED[row].filter((_, index) => Y_REF[index] === -1);
      const score = softBalancedMarginScore(toPositives, toNegatives);
      expect(score).not.toBeNull();
      expect(score).toBeCloseTo(SOFT_EXPECTED[row], 12);
    }
  });

  it('matches the audit for a single example per class (log-mean-exp degenerates to the value)', () => {
    // lme([s]) = tau * (s/tau + ln(e^0 + 1e-300)) = s — the audit's behaviour.
    expect(softBalancedMarginScore([0.42], [0.1])).toBeCloseTo(0.32, 12);
    expect(softBalancedMarginScore([0.42], [0.1], 1)).toBeCloseTo(0.32, 12);
  });

  it('returns null when either class has no reference examples', () => {
    expect(softBalancedMarginScore([], [0.5])).toBeNull();
    expect(softBalancedMarginScore([0.5], [])).toBeNull();
    expect(softBalancedMarginScore([], [])).toBeNull();
    // Non-finite similarities are ignored like the audit's NaN mask.
    expect(softBalancedMarginScore([Number.NaN, 0.4], [0.2])).toBeCloseTo(0.2, 12);
    expect(softBalancedMarginScore([Number.NaN], [0.2])).toBeNull();
  });

  it('uses the audited temperature and stays finite for large spreads', () => {
    expect(SEMANTIC_TAU).toBe(0.05);
    // exp overflow guard: z - max keeps every exponential in [0, 1].
    const score = softBalancedMarginScore([1000, 0.9], [-1000, -0.9]);
    expect(score).not.toBeNull();
    expect(Number.isFinite(score as number)).toBe(true);
    // The aggregation is dominated by the maximum similarity of each class.
    const base = softBalancedMarginScore([0.9, 0.2], [0.1, -0.2]) as number;
    const sharper = softBalancedMarginScore([0.95, 0.2], [0.1, -0.2]) as number;
    expect(sharper).toBeGreaterThan(base);
  });
});

describe('text preprocessing and cache key parity', () => {
  it.each(CLEAN_SAMPLES)('matches the audit clean() and cache key for sample %#', ({ title, summary, text, key }) => {
    const produced = embeddingText(title, summary);
    expect(produced).toBe(text);
    expect(embeddingCacheKey('bge-m3', produced)).toBe(key);
    // Independent recomputation of the audited key formula.
    expect(createHash('sha256').update('bge-m3\0summary\0' + text).digest('hex')).toBe(key);
  });

  it('caps the embedded text at the audited 5000 characters', () => {
    expect(SEMANTIC_TEXT_MAX_CHARS).toBe(5000);
    const long = 'x'.repeat(7000);
    expect(embeddingText('title', long)).toHaveLength(5000);
    // The cap applies to the combined text, after the join.
    const half = 'y'.repeat(3000);
    expect(embeddingText(half, half)).toHaveLength(5000);
  });

  it('removes script, style and noscript blocks after decoding entities', () => {
    expect(cleanForEmbedding('<script>alert(1)</script>safe')).toBe('safe');
    expect(cleanForEmbedding('&lt;script&gt;alert(1)&lt;/script&gt;safe')).toBe('safe');
    expect(cleanForEmbedding('<style>.x{}</style>text')).toBe('text');
    expect(cleanForEmbedding('<noscript>fallback</noscript>text')).toBe('text');
  });

  it('decodes entities exactly like Python html.unescape', () => {
    expect(unescapeHtml('&amp;')).toBe('&');
    expect(unescapeHtml('&#8364;')).toBe('€'); // decimal
    expect(unescapeHtml('&#x20AC;')).toBe('€'); // hex
    expect(unescapeHtml('&#128;')).toBe('€'); // windows-1252 remap of 0x80
    expect(unescapeHtml('&#0;')).toBe('\uFFFD');
    expect(unescapeHtml('&#x;')).toBe('&#x;'); // no digits: literal
    expect(unescapeHtml('&amp')).toBe('&'); // legacy form without semicolon
    expect(unescapeHtml('&ampx')).toBe('&x'); // longest prefix, rest literal
    expect(unescapeHtml('&notit;')).toBe('&notit;'); // semicolon form not in table: unchanged
    expect(unescapeHtml('&nosuchentity;')).toBe('&nosuchentity;');
    expect(unescapeHtml('plain')).toBe('plain');
    expect(unescapeHtml('a & b')).toBe('a & b'); // bare & is not a reference
  });

  it('normalises vectors like the audit norm() and passes zero vectors through', () => {
    expect(unit([3, 4])).toEqual([0.6, 0.8]);
    expect(unit([0, 0, 0])).toEqual([0, 0, 0]);
    const normalized = unit([1, 1, 1, 1]);
    for (const value of normalized) expect(value).toBeCloseTo(0.5, 12);
  });
});
