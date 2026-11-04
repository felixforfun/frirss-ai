import { describe, expect, it } from 'vitest';
import type { Article } from '../types';
import type { ArticleFeedback } from '../api/intelligence';
import {
  DEFAULT_CUSTOM_INTERESTING_WEIGHTS,
  externalSourcesForAlgorithm,
  DEFAULT_INTERESTING_ALGORITHM,
  INTERESTING_ALGORITHMS,
  isInterestingAlgorithm,
  legacySignalsToEvidence,
  needsSemanticScores,
  normalizeCustomInterestingWeights,
  rankInterestingArticles,
  type CustomInterestingWeights,
  type ExternalEvidenceByUrl,
  type ExternalSignalSource,
  type SemanticScoresByUrl,
} from './intelligenceRanking';
import { rankIntelligenceNext, type IntelligenceContext } from './intelligenceNext';

function article(id: string, title: string, summary: string, published = Date.now()): Article {
  return {
    id, title, summary, content: '', author: '', url: `https://example.test/${id}`,
    source: 'Example', sourceId: 'feed/1', published, read: false, starred: false, labels: [], tags: [],
  };
}

const feedback = (title: string, summary: string, vote: 1 | -1): ArticleFeedback => ({
  articleId: 'voted', url: '', title, summary, content: '', sourceId: 'feed/1', vote,
});

/** Evidence builder: measured boosts for the given sources, nothing elsewhere. */
function measured(evidence: Record<string, Partial<Record<ExternalSignalSource, number>>>): ExternalEvidenceByUrl {
  return Object.fromEntries(Object.entries(evidence).map(([url, slots]) => [url,
    Object.fromEntries(Object.entries(slots).map(([source, value]) => [source, { state: 'measured', value }]))]));
}

describe('rankInterestingArticles', () => {
  it('recognizes the Custom algorithm', () => {
    expect(isInterestingAlgorithm('custom')).toBe(true);
    expect(INTERESTING_ALGORITHMS.some((item) => item.value === 'custom')).toBe(true);
  });

  it('keeps the Intelligence Next order when custom discovery influence is zero', () => {
    const first = article('first', 'AI systems', 'Research on AI');
    const second = article('second', 'Gardening', 'Growing vegetables');
    const weights = { externalInfluence: 0, semanticInfluence: 0, sources: { consensus: 100, googleTrends: 0, wikipedia: 0, gdelt: 0, github: 0, hackerNews: 0, lobsters: 0 } };
    const base = rankInterestingArticles([first, second], [], Date.now(), 'intelligence-next');
    const custom = rankInterestingArticles([first, second], [], Date.now(), 'custom', {}, measured({
      [first.url]: { consensus: 0 },
      [second.url]: { consensus: 1 },
    }), weights);
    expect(custom.map((item) => item.id)).toEqual(base.map((item) => item.id));
  });

  it('lets measured evidence fully determine the custom ranking at 100 percent', () => {
    const first = article('first', 'AI systems', 'Research on AI');
    const second = article('second', 'Gardening', 'Growing vegetables');
    const weights = { externalInfluence: 100, semanticInfluence: 0, sources: { consensus: 100, googleTrends: 0, wikipedia: 0, gdelt: 0, github: 0, hackerNews: 0, lobsters: 0 } };
    const custom = rankInterestingArticles([first, second], [], Date.now(), 'custom', {}, measured({
      [first.url]: { consensus: 0 },
      [second.url]: { consensus: 1 },
    }), weights);
    expect(custom[0].id).toBe('second');
  });

  it('ranks content related to a positive vote above unrelated content', () => {
    const liked = article('liked', 'New chip design', 'Researchers improve AI accelerator efficiency');
    const unrelated = article('other', 'Gardening tips', 'How to grow tomatoes at home');
    const ranked = rankInterestingArticles([unrelated, liked], [feedback('AI accelerator', 'chip design efficiency', 1)]);
    expect(ranked[0].id).toBe('liked');
  });

  it('pushes content related to a negative vote down', () => {
    const disliked = article('disliked', 'Celebrity gossip', 'Latest celebrity relationship rumours');
    const other = article('other', 'A quiet walk', 'Walking routes through a forest');
    const ranked = rankInterestingArticles([disliked, other], [feedback('Celebrity gossip', 'relationship rumours', -1)]);
    expect(ranked[0].id).toBe('other');
  });

  it('does not mutate the original article array', () => {
    const items = [article('a', 'A', 'First'), article('b', 'B', 'Second')];
    rankInterestingArticles(items, []);
    expect(items.map((item) => item.id)).toEqual(['a', 'b']);
  });
  it('matches short abbreviations in the synonyms model', () => {
    const abbreviation = article('ai', 'AI regulation and research', 'New AI policy');
    const unrelated = article('other', 'Gardening tools', 'Pruning and soil care');
    const ranked = rankInterestingArticles(
      [unrelated, abbreviation],
      [feedback('Artificial intelligence', 'AI systems and research', 1)],
      Date.now(),
      'synonyms',
    );
    expect(ranked[0].id).toBe('ai');
  });

  it('normalizes inflected synonym forms before synonym lookup', () => {
    const inflected = article('defence', 'Defences and military readiness', 'Security planning');
    const unrelated = article('other', 'Gardening tools', 'Pruning and soil care');
    const ranked = rankInterestingArticles(
      [unrelated, inflected],
      [feedback('Defence readiness', 'Military security planning', 1)],
      Date.now(),
      'synonyms',
    );
    expect(ranked[0].id).toBe('defence');
  });

  it('handles duplicate and empty IDs in Combined mode without collapsing articles', () => {
    const first = article('duplicate', 'AI chip research', 'Artificial intelligence advances');
    const second = article('duplicate', 'Gardening tools', 'Pruning and soil care');
    const third = article('', 'Military defence analysis', 'Security research');
    const ranked = rankInterestingArticles(
      [first, second, third],
      [feedback('AI chip research', 'Artificial intelligence advances', 1)],
      Date.now(),
      'combined',
    );
    expect(ranked).toHaveLength(3);
    expect(new Set(ranked).size).toBe(3);
    expect(ranked).toContain(first);
    expect(ranked).toContain(second);
    expect(ranked).toContain(third);
  });

  it('diversifies repeated sources without banning them for the rest of the list', () => {
    // Mêmes textes ET même horodatage, posés explicitement : ce test éprouve
    // la règle de diversification des sources, pas la pendule. Laissés à
    // Date.now(), les cinq articles reçoivent des âges différents à la
    // milliseconde selon la charge de la machine ; les scores alors très
    // légèrement inégaux se départent sur ce bruit avant la
    // diversification, et l'ordre attendu — feed/b en troisième position —
    // devient aléatoire (environ 1 échec sur 15, vu en CI sur main).
    const published = Date.parse('2026-01-15T12:00:00Z');
    const sameSource = [
      article('a', 'AI chip research', 'Artificial intelligence advances', published),
      article('b', 'AI chip research', 'Artificial intelligence advances', published),
      article('c', 'AI chip research', 'Artificial intelligence advances', published),
      article('d', 'AI chip research', 'Artificial intelligence advances', published),
    ];
    sameSource.forEach((item) => { item.sourceId = 'feed/a'; });
    const otherSource = article('other', 'AI chip research', 'Artificial intelligence advances', published);
    otherSource.sourceId = 'feed/b';
    const ranked = rankInterestingArticles(
      [...sameSource, otherSource],
      [feedback('AI chip research', 'Artificial intelligence advances', 1)],
      published + 3_600_000,
      'combined',
    );
    expect(ranked[2].sourceId).toBe('feed/b');
    expect(ranked.slice(3).some((item) => item.sourceId === 'feed/a')).toBe(true);
  });

  it('ignores unexpected runtime vote values instead of treating them as dislikes', () => {
    const relevant = article('relevant', 'AI chip research', 'Artificial intelligence advances');
    const unrelated = article('other', 'Gardening tools', 'Pruning and soil care');
    const malformed = { ...feedback('AI chip research', 'Artificial intelligence advances', 1), vote: 0 } as unknown as ArticleFeedback;
    const withoutFeedback = rankInterestingArticles([unrelated, relevant], [], Date.now(), 'current');
    const withMalformedFeedback = rankInterestingArticles([unrelated, relevant], [malformed], Date.now(), 'current');
    expect(withMalformedFeedback.map((item) => item.id)).toEqual(withoutFeedback.map((item) => item.id));
  });

});

it('supports all experimental algorithms without mutating input', () => {
  const articles = [
    article('a', 'NATO defence procurement', 'Military production expands'),
    article('b', 'AI chip design', 'Researchers improve machine learning'),
    article('c', 'Celebrity gossip', 'Relationship rumours spread'),
  ];
  for (const algorithm of ['current', 'weighted-idf', 'synonyms', 'topics', 'combined', 'microsoft-news', 'personal-news'] as const) {
    const ranked = rankInterestingArticles(articles, [feedback('defense production', 'military procurement', 1)], Date.now(), algorithm);
    expect(ranked).toHaveLength(3);
    expect(new Set(ranked.map((item) => item.id)).size).toBe(3);
  }
  expect(articles.map((item) => item.id)).toEqual(['a', 'b', 'c']);
});

it('supports the Microsoft NewsRec-inspired attention ranker', () => {
  const defence = article('defence', 'NATO defence procurement expands', 'Military production and European security planning');
  const unrelated = article('other', 'Celebrity gossip and dating rumours', 'Entertainment news about actors');
  const relevantButDifferentWords = article('security', 'European alliance increases readiness', 'Armed forces prepare new procurement plans');
  const ranked = rankInterestingArticles(
    [unrelated, relevantButDifferentWords, defence],
    [
      feedback('NATO defence procurement', 'Military security and readiness', 1),
      feedback('Celebrity gossip', 'Dating rumours about actors', -1),
    ],
    Date.now(),
    'microsoft-news',
  );
  expect(ranked[0].id).toBe('defence');
  expect(ranked[ranked.length - 1].id).toBe('other');
});

it('keeps all candidates in Microsoft NewsRec-inspired mode with empty feedback', () => {
  const items = [article('a', 'AI research', 'New chips'), article('b', 'Garden design', 'Plants and soil')];
  const ranked = rankInterestingArticles(items, [], Date.now(), 'microsoft-news');
  expect(ranked).toHaveLength(2);
  expect(new Set(ranked).size).toBe(2);
});


it('supports Personal News by learning preferences and retaining diverse candidates', () => {
  const liked = article('liked', 'European defence procurement', 'NATO military readiness and security policy');
  const related = article('related', 'Military readiness in Europe', 'Defence procurement and alliance planning');
  const disliked = article('disliked', 'Celebrity gossip', 'Actors dating rumours and entertainment news');
  const independent = article('independent', 'AI chip research', 'Researchers improve machine learning');
  independent.sourceId = 'feed/2';
  const ranked = rankInterestingArticles(
    [disliked, related, independent, liked],
    [
      feedback('European defence procurement', 'NATO military readiness and security policy', 1),
      feedback('Celebrity gossip', 'Actors dating rumours and entertainment news', -1),
    ],
    Date.now(),
    'personal-news',
  );
  expect(ranked).toHaveLength(4);
  expect(ranked[0].id).toBe('liked');
  expect(ranked.findIndex((item) => item.id === 'disliked')).toBeGreaterThan(0);
});

it('keeps all candidates in Personal News mode with empty feedback', () => {
  const items = [article('a', 'AI research', 'New chips'), article('b', 'Garden design', 'Plants and soil')];
  const ranked = rankInterestingArticles(items, [], Date.now(), 'personal-news');
  expect(ranked).toHaveLength(2);
  expect(new Set(ranked).size).toBe(2);
});

describe('correctness fixes for the existing term models', () => {
  const ids = (ranked: Article[]) => ranked.map((item) => item.id);
  const at = (ranked: Article[], id: string) => ranked.findIndex((item) => item.id === id);
  const sameTime = Date.UTC(2026, 9, 1, 12);
  const now = sameTime + 3600000;

  // "quokka" is rare among the candidates, "harbor"/"ferry" are common, so
  // with candidate IDF the rare shared term outweighs the two common ones.
  const idfCorpus = () => [
    article('rare', 'Quokka violin cello', '', sameTime),
    article('common', 'Harbor ferry tulip', '', sameTime),
    ...['lemon', 'mango', 'peach', 'grape', 'melon', 'olive'].map((word) =>
      article(`filler-${word}`, `Harbor ferry ${word}`, '', sameTime)),
  ];
  const idfUpvote = feedback('Quokka harbor ferry', '', 1);
  const unrelatedDownvotes = Array.from({ length: 30 }, () => feedback('Zeppelin airship', '', -1));

  for (const algorithm of ['weighted-idf', 'synonyms', 'microsoft-news', 'personal-news'] as const) {
    it(`${algorithm}: computes IDF from candidates only, so votes on absent topics do not reorder candidates`, () => {
      const plain = rankInterestingArticles(idfCorpus(), [idfUpvote], now, algorithm);
      const withUnrelatedHistory = rankInterestingArticles(idfCorpus(), [idfUpvote, ...unrelatedDownvotes], now, algorithm);
      expect(ids(withUnrelatedHistory)).toEqual(ids(plain));
      expect(at(withUnrelatedHistory, 'rare')).toBeLessThan(at(withUnrelatedHistory, 'common'));
    });
  }

  it('synonyms mode applies IDF like weighted-idf when no synonym or stem applies', () => {
    const weighted = rankInterestingArticles(idfCorpus(), [idfUpvote], now, 'weighted-idf');
    const synonyms = rankInterestingArticles(idfCorpus(), [idfUpvote], now, 'synonyms');
    expect(ids(synonyms)).toEqual(ids(weighted));
    expect(synonyms[0].id).toBe('rare');
  });

  // 30 upvotes, 3 of which mention crypto; both downvotes are about crypto.
  // A raw signed sum gives "crypto" +1 (looks liked); averaging each polarity
  // separately shows it is in 10% of upvotes but 100% of downvotes.
  const heavyUpvoterHistory = [
    ...Array.from({ length: 3 }, () => feedback('Crypto custody rules', '', 1)),
    ...Array.from({ length: 27 }, () => feedback('Linux kernel scheduler', '', 1)),
    ...Array.from({ length: 2 }, () => feedback('Crypto scam warning', '', -1)),
  ];

  for (const algorithm of ['weighted-idf', 'synonyms'] as const) {
    it(`${algorithm}: normalises upvote and downvote profiles independently`, () => {
      const items = [
        article('crypto', 'Crypto token listing', '', sameTime),
        article('neutral', 'Garden compost tips', '', sameTime),
      ];
      const ranked = rankInterestingArticles(items, heavyUpvoterHistory, now, algorithm);
      expect(ids(ranked)).toEqual(['neutral', 'crypto']);
    });
  }

  // "film" shares no words with any vote, so only the topic profile decides.
  // Culture: 3 of 13 upvotes, but 2 of 2 downvotes.
  const topicHistory = [
    ...Array.from({ length: 10 }, () => feedback('Linux kernel software', '', 1)),
    ...Array.from({ length: 3 }, () => feedback('Movie premiere', '', 1)),
    ...Array.from({ length: 2 }, () => feedback('Music festival', '', -1)),
  ];

  for (const algorithm of ['topics', 'personal-news'] as const) {
    it(`${algorithm}: normalises positive and negative topic profiles independently`, () => {
      const items = [
        article('culture', 'Film review', '', sameTime),
        article('neutral', 'Garden compost tips', '', sameTime),
      ];
      const ranked = rankInterestingArticles(items, topicHistory, now, algorithm);
      expect(ids(ranked)).toEqual(['neutral', 'culture']);
    });
  }

  // Regression: the synonym groups list inflected forms ("learning", "armed",
  // "emissions", "warming"), but they were looked up only after stemming, so
  // these articles had no topic and Topics could not rank them at all.
  const technologyHistory = Array.from({ length: 3 }, () => feedback('Linux kernel software', '', 1));
  it('topics: recognises the inflected words the synonym groups list', () => {
    for (const [title, history] of [
      ['Deep learning breakthrough', technologyHistory],
      ['Armed forces on alert', [feedback('Navy patrol', '', 1)]],
      ['Emissions fall as warming slows', [feedback('Physics research', '', 1)]],
    ] as const) {
      const items = [article('neutral', 'Garden compost tips', '', sameTime), article('match', title, '', sameTime)];
      expect(ids(rankInterestingArticles(items, [...history], now, 'topics'))).toEqual(['match', 'neutral']);
    }
  });

  it('topics: does not stretch a listed word to its other inflections', () => {
    // "learning" means AI in the synonym list; "learn" and "warm" alone do not.
    const items = [article('neutral', 'Garden compost tips', '', sameTime), article('learn', 'Learn to bake on a warm day', '', sameTime)];
    const history = [...technologyHistory, feedback('Physics research', '', 1)];
    expect(ids(rankInterestingArticles(items, history, now, 'topics'))).toEqual(['neutral', 'learn']);
  });

  it('personal-news: bounds diversity reranking so large candidate sets stay fast', () => {
    const words = ['policy', 'chip', 'energy', 'market', 'climate', 'rocket', 'vaccine', 'battery', 'satellite', 'election'];
    const items = Array.from({ length: 600 }, (_, index) => {
      const item = article(
        `bulk-${index}`,
        `${words[index % 10]} ${words[(index * 3) % 10]} report ${index}`,
        `${words[(index * 7) % 10]} analysis and ${words[(index + 4) % 10]} outlook`,
        sameTime - index * 60000,
      );
      item.sourceId = `feed/${index % 12}`;
      return item;
    });
    const history = Array.from({ length: 50 }, (_, index) =>
      feedback(`${words[index % 10]} briefing`, `${words[(index + 1) % 10]} update`, index % 4 === 0 ? -1 : 1));
    const started = performance.now();
    const ranked = rankInterestingArticles(items, history, now, 'personal-news');
    const elapsed = performance.now() - started;
    expect(ranked).toHaveLength(items.length);
    expect(new Set(ranked).size).toBe(items.length);
    // Generous bound: the unbounded greedy loop needed minutes at this size.
    expect(elapsed).toBeLessThan(3000);
  });
});

describe('algorithm registry and selection contract', () => {
  it('keeps the default and all legacy algorithms, then lists external experiments', () => {
    expect(DEFAULT_INTERESTING_ALGORITHM).toBe('current');
    expect(INTERESTING_ALGORITHMS.map((a) => a.value)).toEqual([
      'current', 'weighted-idf', 'synonyms', 'topics', 'combined', 'microsoft-news', 'personal-news', 'intelligence-next',
      'gdelt', 'gdelt-github', 'gdelt-hn', 'hn-lob', 'all-four', 'custom', 'soft-balanced-margin',
    ]);
    expect(INTERESTING_ALGORITHMS.every((a) => isInterestingAlgorithm(a.value))).toBe(true);
    for (const value of ['', 'Current', 'intelligence', null, undefined, 3]) expect(isInterestingAlgorithm(value)).toBe(false);
  });

  it('uses Intelligence Next as the base and lets measured evidence change nearby ranks (I5)', () => {
    const now = Date.UTC(2026, 9, 15);
    const items = Array.from({ length: 10 }, (_, index) =>
      article(String(index), `Article ${index}`, `Distinct topic ${index}`, now));
    const baseline = rankInterestingArticles(items, [], now, 'intelligence-next').map((item) => item.id);
    const boostedId = baseline[5];
    const neighborId = baseline[4];
    const evidence = measured({ [items.find((item) => item.id === boostedId)!.url]: { gdelt: 1 } });
    const ranked = rankInterestingArticles(items, [], now, 'gdelt', {}, evidence).map((item) => item.id);
    expect(ranked.indexOf(boostedId)).toBeLessThan(ranked.indexOf(neighborId));
  });

  it('treats unavailable external providers as neutral (I1/I4)', () => {
    const now = Date.UTC(2026, 9, 15);
    const items = [article('a', 'First article', 'Topic A', now), article('b', 'Second article', 'Topic B', now)];
    const baseline = rankInterestingArticles(items, [], now, 'intelligence-next').map((item) => item.id);
    const unavailable = Object.fromEntries(items.map((item) => [item.url, {
      gdelt: { state: 'unavailable' }, github: { state: 'not-applicable' },
      hackerNews: { state: 'none' }, lobsters: { state: 'unavailable' },
    }])) as ExternalEvidenceByUrl;
    expect(rankInterestingArticles(items, [], now, 'all-four', {}, unavailable).map((item) => item.id)).toEqual(baseline);
  });

  it('existing algorithms ignore the Intelligence Next context entirely', () => {
    const now = Date.UTC(2026, 9, 15);
    const items = [
      article('a', 'Rust compiler release', 'Faster builds and borrow checking', now - 3_600_000),
      article('b', 'Tomato garden tips', 'Grow tomatoes on a balcony', now - 7_200_000),
      article('c', 'Compiler internals', 'How the Rust borrow checker works', now - 1_800_000),
      article('d', 'Stock market wobble', 'Bond yields jump again', now - 900_000),
    ];
    items[1].sourceId = 'feed/2';
    items[3].sourceId = 'feed/3';
    const votes = [feedback('Rust compiler', 'borrow checker', 1), feedback('Stock market', 'bond yields', -1)];
    const context = {
      subscriptions: [{ id: 'feed/2', title: 'Garden weekly' }],
      savedArticles: [{ id: 's', title: 'Tomato garden tips', summary: '', content: '', sourceId: 'feed/2', starred: true, readLater: true }],
    };
    for (const { value } of INTERESTING_ALGORITHMS) {
      if (value === 'intelligence-next' || ['gdelt', 'gdelt-github', 'gdelt-hn', 'hn-lob', 'all-four', 'custom', 'soft-balanced-margin'].includes(value)) continue;
      const without = rankInterestingArticles(items, votes, now, value).map((x) => x.id);
      expect(rankInterestingArticles(items, votes, now, value, context).map((x) => x.id), value).toEqual(without);
    }
  });
});

describe('soft-balanced-margin (semantic) method', () => {
  it('is registered as a fifteenth method with the existing fourteen untouched', () => {
    expect(isInterestingAlgorithm('soft-balanced-margin')).toBe(true);
    expect(INTERESTING_ALGORITHMS).toHaveLength(15);
    expect(new Set(INTERESTING_ALGORITHMS.map((item) => item.value)).size).toBe(15);
    const legacy = ['current', 'weighted-idf', 'synonyms', 'topics', 'combined', 'microsoft-news', 'personal-news',
      'intelligence-next', 'gdelt', 'gdelt-github', 'gdelt-hn', 'hn-lob', 'all-four', 'custom'];
    legacy.forEach((value, index) => expect(INTERESTING_ALGORITHMS[index].value).toBe(value));
    expect(INTERESTING_ALGORITHMS[14]).toEqual({ value: 'soft-balanced-margin', label: 'Soft margin (semantic)' });
  });

  const now = Date.parse('2026-01-15T12:00:00Z');
  const items = [
    article('a', 'Rust compiler release', 'Faster builds and borrow checking', now - 3_600_000),
    article('b', 'Tomato garden tips', 'Grow tomatoes on a balcony', now - 7_200_000),
    article('c', 'Compiler internals deep dive', 'How the Rust borrow checker works', now - 1_800_000),
    article('d', 'Stock market wobble', 'Bond yields jump again', now - 900_000),
  ];
  const votes = [feedback('Rust compiler', 'borrow checker', 1), feedback('Stock market', 'bond yields', -1)];

  it('orders purely by semantic score, then follows base order for unscored articles', () => {
    const scores = { 'https://example.test/d': 0.9, 'https://example.test/b': 0.4, 'https://example.test/a': -0.2 };
    const ranked = rankInterestingArticles(items, votes, now, 'soft-balanced-margin', {}, {}, DEFAULT_CUSTOM_INTERESTING_WEIGHTS, scores);
    // d (0.9) first, b (0.4) next, a (-0.2, scored) after, then the unscored c in base position.
    expect(ranked.map((item) => item.id)).toEqual(['d', 'b', 'a', 'c']);
  });

  it('ranks equal scores by base order', () => {
    const scores = Object.fromEntries(items.map((item) => [item.url, 0.5]));
    const ranked = rankInterestingArticles(items, votes, now, 'soft-balanced-margin', {}, {}, DEFAULT_CUSTOM_INTERESTING_WEIGHTS, scores);
    expect(ranked.map((item) => item.id)).toEqual(['c', 'a', 'd', 'b']);
  });

  it('falls back to the base (Intelligence Next) ordering without usable scores', () => {
    const base = rankInterestingArticles(items, votes, now, 'intelligence-next');
    const scoreVariants: SemanticScoresByUrl[] = [{}, { 'https://example.test/unknown': 1 }, { 'https://example.test/a': Number.NaN }];
    for (const scores of scoreVariants) {
      expect(rankInterestingArticles(items, votes, now, 'soft-balanced-margin', {}, {}, DEFAULT_CUSTOM_INTERESTING_WEIGHTS, scores).map((item) => item.id))
        .toEqual(base.map((item) => item.id));
    }
  });

  it('is deterministic for repeated calls', () => {
    const scores = { 'https://example.test/c': 0.7, 'https://example.test/a': 0.2 };
    const first = rankInterestingArticles(items, votes, now, 'soft-balanced-margin', {}, {}, DEFAULT_CUSTOM_INTERESTING_WEIGHTS, scores);
    const second = rankInterestingArticles(items, votes, now, 'soft-balanced-margin', {}, {}, DEFAULT_CUSTOM_INTERESTING_WEIGHTS, scores);
    expect(first.map((item) => item.id)).toEqual(second.map((item) => item.id));
  });
});

describe('discovery blend in Custom', () => {
  const now = Date.parse('2026-01-15T12:00:00Z');
  const context: IntelligenceContext = {};

  /**
   * Verbatim replica of the pre-rework Custom blend. With the rework the
   * blend is boost-space with a fixed denominator (§4.3), which differs from
   * the legacy behaviour exactly where evidence is missing or inapplicable —
   * the two agree when every requested source is measured on every article.
   */
  function legacyCustomRank(
    input: Article[],
    rankingFeedback: ArticleFeedback[],
    evidenceValues: Record<string, Record<ExternalSignalSource, number>>,
    customWeights: { externalInfluence: number; sources: Record<ExternalSignalSource, number> },
  ): Article[] {
    const base = rankIntelligenceNext(input, rankingFeedback, now, context);
    if (base.length < 2) return base;
    const baseScore = new Map(base.map((entry, index) => [entry, (base.length - index - 1) / (base.length - 1)]));
    return [...base].map((entry, baseIndex) => {
      const personal = baseScore.get(entry) ?? 0;
      const values = evidenceValues[entry.url];
      let weighted = 0;
      let totalWeight = 0;
      for (const [source, weight] of Object.entries(customWeights.sources) as Array<[ExternalSignalSource, number]>) {
        const value = values?.[source];
        if (value === null || value === undefined || !Number.isFinite(value)) continue;
        weighted += weight * Math.max(0, Math.min(1, value));
        totalWeight += weight;
      }
      const external = totalWeight > 0 ? weighted / totalWeight : personal;
      const influence = customWeights.externalInfluence / 100;
      return { article: entry, score: (1 - influence) * personal + influence * external, baseIndex };
    }).sort((a, b) => b.score - a.score || a.baseIndex - b.baseIndex).map(({ article }) => article);
  }

  const items = [
    article('a', 'Rust compiler release', 'Faster builds and borrow checking', now - 3_600_000),
    article('b', 'Tomato garden tips', 'Grow tomatoes on a balcony', now - 7_200_000),
    article('c', 'Compiler internals deep dive', 'How the Rust borrow checker works', now - 1_800_000),
    article('d', 'Stock market wobble', 'Bond yields jump again', now - 900_000),
    article('e', 'Quantum sensor research', 'Trap ion clock stability', now - 500_000),
  ];
  const votes = [feedback('Rust compiler', 'borrow checker', 1), feedback('Stock market', 'bond yields', -1)];
  const evidence = measured({
    'https://example.test/a': { consensus: 0.9 },
    'https://example.test/b': { consensus: 0.0 },
    'https://example.test/c': { consensus: 0.2 },
    'https://example.test/d': { consensus: 0.5 },
    // e has no entry at all (acquisition never asked for it).
  });
  const allMeasured: Record<string, Record<ExternalSignalSource, number>> = {
    'https://example.test/a': { consensus: 0.9, github: 0, hackerNews: 0, lobsters: 0, gdelt: 0, wikipedia: 0, googleTrends: 0 },
    'https://example.test/b': { consensus: 0, github: 0, hackerNews: 0, lobsters: 0, gdelt: 0, wikipedia: 0, googleTrends: 0 },
    'https://example.test/c': { consensus: 0.2, github: 0, hackerNews: 0, lobsters: 0, gdelt: 0, wikipedia: 0, googleTrends: 0 },
    'https://example.test/d': { consensus: 0.5, github: 0, hackerNews: 0, lobsters: 0, gdelt: 0, wikipedia: 0, googleTrends: 0 },
    'https://example.test/e': { consensus: 0.3, github: 0, hackerNews: 0, lobsters: 0, gdelt: 0, wikipedia: 0, googleTrends: 0 },
  };
  const weights: CustomInterestingWeights = {
    externalInfluence: 25, semanticInfluence: 0, v: 2,
    sources: { consensus: 100, googleTrends: 0, wikipedia: 0, gdelt: 0, github: 0, hackerNews: 0, lobsters: 0 },
  };

  it('produces exactly the legacy Custom ordering when every requested source is measured everywhere', () => {
    const legacy = legacyCustomRank(items, votes, allMeasured, { externalInfluence: weights.externalInfluence, sources: { consensus: 100, googleTrends: 0, wikipedia: 0, gdelt: 0, github: 0, hackerNews: 0, lobsters: 0 } });
    const current = rankInterestingArticles(items, votes, now, 'custom', context, measured(allMeasured), weights);
    expect(current.map((item) => item.id)).toEqual(legacy.map((item) => item.id));
  });

  it('is untouched by semantic score values while semantic influence is 0', () => {
    const junkScores = Object.fromEntries(items.map((item, index) => [item.url, index % 2 ? 1 : -1]));
    const without = rankInterestingArticles(items, votes, now, 'custom', context, evidence, weights);
    const withJunk = rankInterestingArticles(items, votes, now, 'custom', context, evidence, weights, junkScores);
    expect(withJunk.map((item) => item.id)).toEqual(without.map((item) => item.id));
  });

  it('changes the ordering once semantic influence is non-zero', () => {
    const semanticScores = { 'https://example.test/e': 0.99, 'https://example.test/a': 0.1 };
    const weightsWithSemantic = { ...weights, semanticInfluence: 60 };
    const ranked = rankInterestingArticles(items, votes, now, 'custom', context, evidence, weightsWithSemantic, semanticScores);
    const withoutSemantic = rankInterestingArticles(items, votes, now, 'custom', context, evidence, weights);
    expect(ranked.map((item) => item.id)).not.toEqual(withoutSemantic.map((item) => item.id));
    // At a full semantic share the ordering IS the semantic rank order.
    const fullSemantic = { ...weights, externalInfluence: 0, semanticInfluence: 100 };
    const allScores = { 'https://example.test/e': 0.99, 'https://example.test/b': 0.5, 'https://example.test/c': 0.3, 'https://example.test/d': 0.2, 'https://example.test/a': 0.1 };
    expect(rankInterestingArticles(items, votes, now, 'custom', context, evidence, fullSemantic, allScores).map((item) => item.id))
      .toEqual(['e', 'b', 'c', 'd', 'a']);
  });

  it('rescales discovery and semantic shares proportionally when they exceed 100%', () => {
    const semanticScores = { 'https://example.test/a': 0.99 };
    const overshooting = { ...weights, externalInfluence: 100, semanticInfluence: 100 };
    const ranked = rankInterestingArticles(items, votes, now, 'custom', context, evidence, overshooting, semanticScores);
    // 50/50 after rescaling: the article with the top semantic score and a top
    // consensus boost should surface; nothing may NaN or vanish.
    expect(ranked).toHaveLength(items.length);
    expect(new Set(ranked).size).toBe(items.length);
    expect(ranked[0].id).toBe('a');
  });

  it('keeps custom discovery influence 0 equal to plain Intelligence Next', () => {
    const zeroExternal = { ...weights, externalInfluence: 0 };
    const base = rankInterestingArticles(items, votes, now, 'intelligence-next');
    expect(rankInterestingArticles(items, votes, now, 'custom', context, evidence, zeroExternal).map((item) => item.id))
      .toEqual(base.map((item) => item.id));
  });
});

describe('discovery blend invariants (rework §4.4)', () => {
  const now = Date.parse('2026-01-15T12:00:00Z');
  const context: IntelligenceContext = {};
  const items = Array.from({ length: 8 }, (_, index) =>
    article(String(index), `Article ${index} distinct topic`, `Summary ${index}`, now - index * 600_000));
  const votes: ArticleFeedback[] = [];
  const weights: CustomInterestingWeights = {
    externalInfluence: 30, semanticInfluence: 0, v: 2,
    sources: { consensus: 40, googleTrends: 0, wikipedia: 0, gdelt: 0, github: 20, hackerNews: 20, lobsters: 20 },
  };

  it('I1: all providers down (nothing measured) reproduces Intelligence Next exactly', () => {
    const base = rankInterestingArticles(items, votes, now, 'intelligence-next', context).map((item) => item.id);
    const evidence = Object.fromEntries(items.map((item) => [item.url, {
      consensus: { state: 'unavailable' }, github: { state: 'none' },
      hackerNews: { state: 'unavailable' }, lobsters: { state: 'not-applicable' },
    }])) as ExternalEvidenceByUrl;
    expect(rankInterestingArticles(items, votes, now, 'custom', context, evidence, weights).map((item) => item.id)).toEqual(base);
  });

  it('I2: a source with all-zero boosts has no effect at any weight', () => {
    const zero = measured(Object.fromEntries(items.map((item) => [item.url, { consensus: 0 }])));
    const base = rankInterestingArticles(items, votes, now, 'custom', context, zero, weights);
    const heavy = { ...weights, sources: { ...weights.sources, consensus: 100 } };
    expect(rankInterestingArticles(items, votes, now, 'custom', context, zero, heavy).map((item) => item.id))
      .toEqual(base.map((item) => item.id));
  });

  it('I3: changing a source weight reorders articles whose boosts disagree', () => {
    // Two textually identical articles at full discovery influence: the
    // weighted boost mix alone decides the order between them.
    const twinA = article('twin-a', 'Identical headline', 'Identical summary', now);
    const twinB = article('twin-b', 'Identical headline', 'Identical summary', now);
    const evidence = measured({
      [twinA.url]: { consensus: 0.1, github: 0.9 },
      [twinB.url]: { consensus: 0.9, github: 0.1 },
    });
    const consensusHeavy: CustomInterestingWeights = { externalInfluence: 100, semanticInfluence: 0, v: 2, sources: { ...weights.sources, consensus: 90, github: 10 } };
    const githubHeavy: CustomInterestingWeights = { externalInfluence: 100, semanticInfluence: 0, v: 2, sources: { ...weights.sources, consensus: 10, github: 90 } };
    const first = rankInterestingArticles([twinA, twinB], votes, now, 'custom', context, evidence, consensusHeavy).map((item) => item.id);
    const second = rankInterestingArticles([twinA, twinB], votes, now, 'custom', context, evidence, githubHeavy).map((item) => item.id);
    expect(first[0]).toBe('twin-b');
    expect(second[0]).toBe('twin-a');
  });

  it('I4: absent evidence is neutral — unavailable/none/not-applicable/missing all score identically', () => {
    const nothing = rankInterestingArticles(items, votes, now, 'custom', context, {}, weights);
    const absent: ExternalEvidenceByUrl = Object.fromEntries(items.map((item) => [item.url, {
      consensus: { state: 'unavailable' }, github: { state: 'not-applicable' }, hackerNews: { state: 'none' },
    }]));
    const withAbsent = rankInterestingArticles(items, votes, now, 'custom', context, absent, weights);
    expect(withAbsent.map((item) => item.id)).toEqual(nothing.map((item) => item.id));
  });

  it('I5: one measured article moves up even as the only match in the cohort', () => {
    // Two tied twins; exactly one carries measured evidence. At full
    // discovery influence the boost alone decides (at lower e the boost must
    // also overcome the personal-score gap, which is the blend doing its job).
    const twinA = article('twin-a', 'Twin headline', 'Twin summary', now);
    const twinB = article('twin-b', 'Twin headline', 'Twin summary', now);
    const base = rankInterestingArticles([twinA, twinB], votes, now, 'custom', context, {}, weights).map((item) => item.id);
    expect(base[0]).toBe('twin-a'); // tie keeps base order
    const fullDiscovery = { ...weights, externalInfluence: 100 };
    const lone = measured({ [twinB.url]: { consensus: 0.1 } });
    const ranked = rankInterestingArticles([twinA, twinB], votes, now, 'custom', context, lone, fullDiscovery).map((item) => item.id);
    expect(ranked[0]).toBe('twin-b');
  });

  it('I6: s = 0 and e = 0 leave the ordering; e + s > 1 rescales proportionally', () => {
    const evidence = measured({
      [items[0].url]: { consensus: 1 },
      [items[1].url]: { consensus: 0.5 },
    });
    const semanticScores = Object.fromEntries(items.map((item, index) => [item.url, index / items.length]));
    const plain = rankInterestingArticles(items, votes, now, 'custom', context, evidence, weights).map((item) => item.id);
    const overshoot = { ...weights, externalInfluence: 70, semanticInfluence: 70 };
    const rescaled = rankInterestingArticles(items, votes, now, 'custom', context, evidence, overshoot, semanticScores);
    // Rescaled 50/50: every article's score is 0.5·P + 0.5·Sem + 0·D — the
    // semantic rank decides; nothing NaNs and all candidates survive.
    expect(rescaled).toHaveLength(items.length);
    expect(new Set(rescaled).size).toBe(items.length);
    // s = 0, e = 0: exactly the personal order.
    const zeros = { ...weights, externalInfluence: 0, semanticInfluence: 0 };
    expect(rankInterestingArticles(items, votes, now, 'custom', context, evidence, zeros).map((item) => item.id))
      .toEqual(rankInterestingArticles(items, votes, now, 'intelligence-next', context).map((item) => item.id));
    void plain;
  });

  it('I7: identical inputs give an identical order, ties keep base order', () => {
    const evidence = measured({ [items[2].url]: { consensus: 0.4 }, [items[3].url]: { consensus: 0.4 } });
    const first = rankInterestingArticles(items, votes, now, 'custom', context, evidence, weights).map((item) => item.id);
    const second = rankInterestingArticles(items, votes, now, 'custom', context, evidence, weights).map((item) => item.id);
    expect(first).toEqual(second);
    // A zero-weight source never changes ties or anything else.
    const withExtra = { ...weights, sources: { ...weights.sources, wikipedia: 50 } };
    expect(rankInterestingArticles(items, votes, now, 'custom', context, evidence, withExtra).map((item) => item.id))
      .toEqual(first);
  });

  it('unregistered sources (googleTrends, not yet implemented) are absent from the denominator', () => {
    // googleTrends weight does not change the scale of the other sources.
    const evidence = measured({ [items[0].url]: { github: 1 } });
    const without = rankInterestingArticles(items, votes, now, 'custom', context, evidence, weights).map((item) => item.id);
    const trendsWeighted = { ...weights, sources: { ...weights.sources, googleTrends: 80 } };
    expect(rankInterestingArticles(items, votes, now, 'custom', context, evidence, trendsWeighted).map((item) => item.id))
      .toEqual(without);
  });
});

describe('legacy v1 signal conversion', () => {
  it('maps the four numeric-or-null slots to evidence states', () => {
    const evidence = legacySignalsToEvidence({
      'https://example.test/a': { gdelt: 0.4, github: 0.7, hackerNews: 0, lobsters: 0.2 },
      'https://example.test/b': { gdelt: 0, github: null, hackerNews: null, lobsters: null },
    });
    expect(evidence['https://example.test/a']).toEqual({
      gdelt: { state: 'measured', value: 0.4 },
      github: { state: 'measured', value: 0.7 },
      hackerNews: { state: 'none' },
      lobsters: { state: 'measured', value: 0.2 },
    });
    expect(evidence['https://example.test/b']).toEqual({
      gdelt: { state: 'measured', value: 0 },
      github: { state: 'not-applicable' },
      hackerNews: { state: 'unavailable' },
      lobsters: { state: 'unavailable' },
    });
  });
});

describe('needsSemanticScores', () => {
  it('is true for the semantic method and for Custom with non-zero semantic influence', () => {
    expect(needsSemanticScores('soft-balanced-margin')).toBe(true);
    expect(needsSemanticScores('custom', { ...DEFAULT_CUSTOM_INTERESTING_WEIGHTS, semanticInfluence: 1 })).toBe(true);
    expect(needsSemanticScores('custom', { ...DEFAULT_CUSTOM_INTERESTING_WEIGHTS, semanticInfluence: 0 })).toBe(false);
    expect(needsSemanticScores('current')).toBe(false);
    expect(needsSemanticScores('gdelt')).toBe(false);
    expect(needsSemanticScores('intelligence-next')).toBe(false);
  });
});

describe('normalizeCustomInterestingWeights backward compatibility', () => {
  it('migrates untouched legacy defaults to the discovery defaults, stamped v2', () => {
    const normalized = normalizeCustomInterestingWeights({
      externalInfluence: 25,
      sources: { gdelt: 40, github: 20, hackerNews: 25, lobsters: 15 },
    });
    expect(normalized).toEqual(DEFAULT_CUSTOM_INTERESTING_WEIGHTS);
    expect(normalized.v).toBe(2);
  });

  it('keeps customised values and fills only the new source keys', () => {
    const normalized = normalizeCustomInterestingWeights({
      externalInfluence: 40,
      sources: { gdelt: 50, github: 10, hackerNews: 30, lobsters: 10 },
    });
    expect(normalized).toEqual({
      externalInfluence: 40,
      semanticInfluence: 0,
      v: 2,
      sources: {
        consensus: 40, googleTrends: 25, wikipedia: 15,
        github: 10, hackerNews: 30, lobsters: 10, gdelt: 50,
      },
    });
  });

  it('already-migrated weights (v: 2) pass through normalization unchanged', () => {
    const weights = DEFAULT_CUSTOM_INTERESTING_WEIGHTS;
    expect(normalizeCustomInterestingWeights(weights)).toEqual(weights);
  });

  it('defaults missing semanticInfluence to 0 for weights stored before the field existed', () => {
    const normalized = normalizeCustomInterestingWeights({
      externalInfluence: 40,
      sources: { gdelt: 50, github: 10, hackerNews: 30, lobsters: 10 },
    });
    expect(normalized.semanticInfluence).toBe(0);
  });

  it('clamps out-of-range semantic influence', () => {
    expect(normalizeCustomInterestingWeights({ semanticInfluence: 250 }).semanticInfluence).toBe(100);
    expect(normalizeCustomInterestingWeights({ semanticInfluence: -5 }).semanticInfluence).toBe(0);
    expect(normalizeCustomInterestingWeights({ semanticInfluence: 'x' }).semanticInfluence).toBe(0);
  });

  it('externalSourcesForAlgorithm returns registered sources with weight above zero only', () => {
    const sources = externalSourcesForAlgorithm('custom', {
      v: 2, externalInfluence: 25, semanticInfluence: 0,
      sources: { consensus: 40, googleTrends: 80, wikipedia: 15, github: 8, hackerNews: 7, lobsters: 5, gdelt: 0 },
    });
    expect(sources).not.toContain('googleTrends');
    expect(sources).toContain('consensus');
    expect(sources).not.toContain('gdelt'); // default weight 0
  });
});
