import { describe, expect, it } from 'vitest';
import type { Article } from '../types';
import type { ArticleFeedback } from '../api/intelligence';
import {
  DEFAULT_CUSTOM_INTERESTING_WEIGHTS,
  DEFAULT_INTERESTING_ALGORITHM,
  INTERESTING_ALGORITHMS,
  isInterestingAlgorithm,
  needsSemanticScores,
  normalizeCustomInterestingWeights,
  rankInterestingArticles,
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

describe('rankInterestingArticles', () => {
  it('recognizes the Custom algorithm', () => {
    expect(isInterestingAlgorithm('custom')).toBe(true);
    expect(INTERESTING_ALGORITHMS.some((item) => item.value === 'custom')).toBe(true);
  });

  it('keeps the Intelligence Next order when custom external influence is zero', () => {
    const first = article('first', 'AI systems', 'Research on AI');
    const second = article('second', 'Gardening', 'Growing vegetables');
    const weights = { externalInfluence: 0, semanticInfluence: 0, sources: { gdelt: 100, github: 0, hackerNews: 0, lobsters: 0 } };
    const base = rankInterestingArticles([first, second], [], Date.now(), 'intelligence-next');
    const custom = rankInterestingArticles([first, second], [], Date.now(), 'custom', {}, {
      [first.url]: { gdelt: 0, github: null, hackerNews: null, lobsters: null },
      [second.url]: { gdelt: 1, github: null, hackerNews: null, lobsters: null },
    }, weights);
    expect(custom.map((item) => item.id)).toEqual(base.map((item) => item.id));
  });

  it('allows external signals to fully determine the custom ranking at 100 percent', () => {
    const first = article('first', 'AI systems', 'Research on AI');
    const second = article('second', 'Gardening', 'Growing vegetables');
    const weights = { externalInfluence: 100, semanticInfluence: 0, sources: { gdelt: 100, github: 0, hackerNews: 0, lobsters: 0 } };
    const custom = rankInterestingArticles([first, second], [], Date.now(), 'custom', {}, {
      [first.url]: { gdelt: 0, github: null, hackerNews: null, lobsters: null },
      [second.url]: { gdelt: 1, github: null, hackerNews: null, lobsters: null },
    }, weights);
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

  it('uses Intelligence Next as the base and lets available external evidence change nearby ranks', () => {
    const now = Date.UTC(2026, 9, 15);
    const items = Array.from({ length: 10 }, (_, index) =>
      article(String(index), `Article ${index}`, `Distinct topic ${index}`, now));
    const baseline = rankInterestingArticles(items, [], now, 'intelligence-next').map((item) => item.id);
    const boostedId = baseline[5];
    const neighborId = baseline[4];
    const signals = Object.fromEntries(items.map((item) => [item.url, {
      gdelt: item.id === boostedId ? 1 : 0,
      github: null,
      hackerNews: null,
      lobsters: null,
    }]));
    const ranked = rankInterestingArticles(items, [], now, 'gdelt', {}, signals).map((item) => item.id);
    expect(ranked.indexOf(boostedId)).toBeLessThan(ranked.indexOf(neighborId));
  });

  it('treats unavailable external providers as neutral', () => {
    const now = Date.UTC(2026, 9, 15);
    const items = [article('a', 'First article', 'Topic A', now), article('b', 'Second article', 'Topic B', now)];
    const baseline = rankInterestingArticles(items, [], now, 'intelligence-next').map((item) => item.id);
    const signals = Object.fromEntries(items.map((item) => [item.url, {
      gdelt: null, github: null, hackerNews: null, lobsters: null,
    }]));
    expect(rankInterestingArticles(items, [], now, 'all-four', {}, signals).map((item) => item.id)).toEqual(baseline);
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

describe('semantic influence in Custom', () => {
  const now = Date.parse('2026-01-15T12:00:00Z');
  const context: IntelligenceContext = {};

  /** Verbatim replica of the pre-change Custom blend, for the regression proof. */
  function legacyCustomRank(
    input: Article[],
    feedback: ArticleFeedback[],
    externalSignals: Record<string, { gdelt: number | null; github: number | null; hackerNews: number | null; lobsters: number | null }>,
    customWeights: { externalInfluence: number; sources: Record<string, number> },
  ): Article[] {
    const base = rankIntelligenceNext(input, feedback, now, context);
    if (base.length < 2) return base;
    const baseScore = new Map(base.map((article, index) => [article, (base.length - index - 1) / (base.length - 1)]));
    return [...base].map((article, baseIndex) => {
      const personal = baseScore.get(article) ?? 0;
      const signals = externalSignals[article.url];
      if (!signals) return { article, score: personal, baseIndex };
      let weighted = 0;
      let totalWeight = 0;
      for (const [source, weight] of Object.entries(customWeights.sources) as Array<[ExternalSignalSource, number]>) {
        const value = signals[source];
        if (value === null || value === undefined || !Number.isFinite(value)) continue;
        weighted += weight * Math.max(0, Math.min(1, value));
        totalWeight += weight;
      }
      const external = totalWeight > 0 ? weighted / totalWeight : personal;
      const influence = customWeights.externalInfluence / 100;
      return { article, score: (1 - influence) * personal + influence * external, baseIndex };
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
  const signals = {
    'https://example.test/a': { gdelt: 0.9, github: 0, hackerNews: 0, lobsters: 0 },
    'https://example.test/b': { gdelt: null, github: null, hackerNews: null, lobsters: null },
    'https://example.test/c': { gdelt: 0.2, github: 0, hackerNews: 0, lobsters: 0 },
    'https://example.test/d': { gdelt: 0.5, github: 0, hackerNews: 0, lobsters: 0 },
    // e has no entry at all (lookup failed).
  };
  const weights = { externalInfluence: 25, semanticInfluence: 0, sources: { gdelt: 100, github: 0, hackerNews: 0, lobsters: 0 } };

  it('produces exactly the legacy Custom ordering at 0% semantic influence', () => {
    const legacy = legacyCustomRank(items, votes, signals, weights);
    const current = rankInterestingArticles(items, votes, now, 'custom', context, signals, weights);
    expect(current.map((item) => item.id)).toEqual(legacy.map((item) => item.id));
  });

  it('is untouched by semantic score values while semantic influence is 0', () => {
    const junkScores = Object.fromEntries(items.map((item, index) => [item.url, index % 2 ? 1 : -1]));
    const without = rankInterestingArticles(items, votes, now, 'custom', context, signals, weights);
    const withJunk = rankInterestingArticles(items, votes, now, 'custom', context, signals, weights, junkScores);
    expect(withJunk.map((item) => item.id)).toEqual(without.map((item) => item.id));
  });

  it('changes the ordering once semantic influence is non-zero', () => {
    const semanticScores = { 'https://example.test/e': 0.99, 'https://example.test/a': 0.1 };
    const weightsWithSemantic = { ...weights, semanticInfluence: 60 };
    const ranked = rankInterestingArticles(items, votes, now, 'custom', context, signals, weightsWithSemantic, semanticScores);
    const withoutSemantic = rankInterestingArticles(items, votes, now, 'custom', context, signals, weights);
    expect(ranked.map((item) => item.id)).not.toEqual(withoutSemantic.map((item) => item.id));
    // At a full semantic share the ordering IS the semantic rank order.
    const fullSemantic = { ...weights, externalInfluence: 0, semanticInfluence: 100 };
    const allScores = { 'https://example.test/e': 0.99, 'https://example.test/b': 0.5, 'https://example.test/c': 0.3, 'https://example.test/d': 0.2, 'https://example.test/a': 0.1 };
    expect(rankInterestingArticles(items, votes, now, 'custom', context, signals, fullSemantic, allScores).map((item) => item.id))
      .toEqual(['e', 'b', 'c', 'd', 'a']);
  });

  it('rescales external and semantic shares proportionally when they exceed 100%', () => {
    const semanticScores = { 'https://example.test/a': 0.99 };
    const overshooting = { ...weights, externalInfluence: 100, semanticInfluence: 100 };
    const ranked = rankInterestingArticles(items, votes, now, 'custom', context, signals, overshooting, semanticScores);
    // 50/50 after rescaling: the article with the top semantic score and a top
    // external signal should surface; nothing may NaN or vanish.
    expect(ranked).toHaveLength(items.length);
    expect(new Set(ranked).size).toBe(items.length);
    expect(ranked[0].id).toBe('a');
  });

  it('keeps custom external influence 0 equal to plain Intelligence Next', () => {
    const zeroExternal = { ...weights, externalInfluence: 0 };
    const base = rankInterestingArticles(items, votes, now, 'intelligence-next');
    expect(rankInterestingArticles(items, votes, now, 'custom', context, signals, zeroExternal).map((item) => item.id))
      .toEqual(base.map((item) => item.id));
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
  it('defaults missing semanticInfluence to 0 for weights stored before the field existed', () => {
    const normalized = normalizeCustomInterestingWeights({
      externalInfluence: 40,
      sources: { gdelt: 50, github: 10, hackerNews: 30, lobsters: 10 },
    });
    expect(normalized).toEqual({
      externalInfluence: 40,
      semanticInfluence: 0,
      sources: { gdelt: 50, github: 10, hackerNews: 30, lobsters: 10 },
    });
  });

  it('clamps out-of-range semantic influence', () => {
    expect(normalizeCustomInterestingWeights({ semanticInfluence: 250 }).semanticInfluence).toBe(100);
    expect(normalizeCustomInterestingWeights({ semanticInfluence: -5 }).semanticInfluence).toBe(0);
    expect(normalizeCustomInterestingWeights({ semanticInfluence: 'x' }).semanticInfluence).toBe(0);
  });
});
