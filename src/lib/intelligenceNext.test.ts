import { describe, expect, it } from 'vitest';
import type { Article, Subscription } from '../types';
import type { ArticleFeedback } from '../api/intelligence';
import {
  explainIntelligenceNext,
  rankIntelligenceNext,
  INTELLIGENCE_NEXT_PARAMETERS,
  type IntelligenceContext,
  type SavedArticleSignal,
} from './intelligenceNext';
import { rankInterestingArticles } from './intelligenceRanking';

const NOW = Date.UTC(2026, 9, 15, 12);
const HOUR = 3_600_000;

let sequence = 0;
function article(id: string, title: string, summary = '', overrides: Partial<Article> = {}): Article {
  sequence++;
  return {
    id,
    title,
    summary,
    content: summary,
    author: '',
    url: `https://example.test/${id || sequence}`,
    source: overrides.sourceId ?? 'Example',
    sourceId: 'feed/example',
    published: NOW - HOUR,
    read: false,
    starred: false,
    labels: [],
    tags: [],
    ...overrides,
  };
}

function vote(articleId: string, title: string, summary: string, value: 1 | -1, sourceId = 'feed/voted'): ArticleFeedback {
  return { articleId, url: '', title, summary, content: summary, sourceId, vote: value };
}

function saved(id: string, title: string, summary: string, flags: { starred?: boolean; readLater?: boolean }): SavedArticleSignal {
  return { id, title, summary, content: summary, sourceId: 'feed/saved', starred: !!flags.starred, readLater: !!flags.readLater };
}

function feed(id: string, title: string, categories: string[] = []): Subscription {
  return { id, title, categories: categories.map((label) => ({ id: `user/-/label/${label}`, label })) };
}

const ids = (articles: Article[]) => articles.map((item) => item.id);

/** Three in a row from one source is only allowed once nothing else is left. */
function expectNoAvoidableSourceRuns(ranked: Article[]) {
  for (let index = 2; index < ranked.length; index++) {
    const source = ranked[index].sourceId;
    if (ranked[index - 1].sourceId !== source || ranked[index - 2].sourceId !== source) continue;
    expect(ranked.slice(index).every((item) => item.sourceId === source)).toBe(true);
  }
}
const rank = (articles: Article[], feedback: ArticleFeedback[] = [], context: IntelligenceContext = {}) =>
  ids(rankIntelligenceNext(articles, feedback, NOW, context));
const explanationOf = (articles: Article[], feedback: ArticleFeedback[], id: string, context: IntelligenceContext = {}) =>
  explainIntelligenceNext(articles, feedback, NOW, context).find((item) => item.article.id === id)!;

// Distinct, unrelated filler topics so lexical overlap only comes from the fixtures under test.
const filler = [
  ['garden', 'Tomato seedlings need warm soil', 'Gardeners transplant tomato seedlings after frost'],
  ['recipe', 'Slow cooked lentil soup recipe', 'Lentils simmer with carrots onions and cumin'],
  ['hiking', 'Alpine hiking trails reopen', 'Mountain paths above the valley reopen after snowmelt'],
  ['violin', 'Violin maker restores antique instrument', 'Luthier repairs varnish on a baroque violin'],
  ['tennis', 'Tennis final goes to five sets', 'Baseline rallies decided the championship match'],
] as const;
const fillerArticles = (sourcePrefix = 'feed/filler') =>
  filler.map(([id, title, summary], index) => article(id, title, summary, { sourceId: `${sourcePrefix}-${index}` }));

describe('Intelligence Next — basic contract', () => {
  it('returns an empty list for no candidates', () => {
    expect(rankIntelligenceNext([], [vote('x', 'AI chips', 'chips', 1)], NOW)).toEqual([]);
    expect(explainIntelligenceNext([], [], NOW)).toEqual([]);
  });

  it('returns a single candidate unchanged', () => {
    const only = article('only', 'Only article');
    expect(rankIntelligenceNext([only], [], NOW)).toEqual([only]);
  });

  it('returns a permutation of the input, keeping duplicate and empty ids', () => {
    const items = [
      article('dup', 'Quantum computing milestone', 'Qubits reach new fidelity'),
      article('dup', 'Quantum computing milestone', 'Qubits reach new fidelity'),
      article('', 'Untitled feed item'),
      ...fillerArticles(),
    ];
    const ranked = rankIntelligenceNext(items, [vote('dup', 'Quantum computing', 'qubits', 1)], NOW);
    expect(ranked).toHaveLength(items.length);
    expect(new Set(ranked)).toEqual(new Set(items));
  });

  it('does not mutate its inputs', () => {
    const items = fillerArticles();
    const feedback = [vote('v', 'Tennis final', 'championship match', 1)];
    const before = JSON.stringify({ items, feedback });
    rankIntelligenceNext(items, feedback, NOW, { subscriptions: [feed('feed/filler-0', 'Garden')] });
    expect(JSON.stringify({ items, feedback })).toBe(before);
  });

  it('is deterministic, including on a warm tokenisation cache', () => {
    const items = [...fillerArticles(), article('ai', 'AI chip design', 'Machine learning accelerators')];
    const feedback = [vote('v', 'Artificial intelligence hardware', 'accelerator chips', 1)];
    const first = rank(items, feedback);
    const second = rank(items, feedback);
    const cold = rank(items.map((item) => ({ ...item })), feedback.map((row) => ({ ...row })));
    expect(second).toEqual(first);
    expect(cold).toEqual(first);
  });

  it('is reachable through rankInterestingArticles and passes the context through', () => {
    const items = [
      article('racing', 'Formula racing championship standings', 'Drivers battle for the title', { sourceId: 'feed/news' }),
      article('garden', 'Tomato seedlings need warm soil', 'Gardeners transplant seedlings', { sourceId: 'feed/news' }),
    ];
    const context = { subscriptions: [feed('feed/news', 'News'), feed('feed/f1', 'Formula racing championship')] };
    expect(ids(rankInterestingArticles(items, [], NOW, 'intelligence-next', context)))
      .toEqual(rank(items, [], context));
  });
});

describe('Intelligence Next — explicit feedback', () => {
  it('ranks articles similar to an upvote above unrelated ones', () => {
    const items = [...fillerArticles(), article('chip', 'New AI accelerator chip design', 'Researchers improve accelerator efficiency')];
    const order = rank(items, [vote('v', 'AI accelerator chips', 'chip design and efficiency', 1)]);
    expect(order[0]).toBe('chip');
  });

  it('pushes articles similar to a downvote below unrelated ones, even when newer', () => {
    const gossip = article('gossip', 'Celebrity gossip rumours', 'Latest celebrity relationship rumours', { published: NOW });
    const items = [gossip, ...fillerArticles().map((item) => ({ ...item, published: NOW - 48 * HOUR }))];
    const order = rank(items, [vote('v', 'Celebrity gossip', 'celebrity relationship rumours', -1)]);
    expect(order[order.length - 1]).toBe('gossip');
    expect(explanationOf(items, [vote('v', 'Celebrity gossip', 'celebrity relationship rumours', -1)], 'gossip').tier).toBe('net-negative');
  });

  it('puts a directly downvoted candidate last, even if it matches upvotes', () => {
    const items = [article('voted', 'AI chip research', 'Accelerator design'), ...fillerArticles()];
    const feedback = [vote('voted', 'AI chip research', 'Accelerator design', -1), vote('other', 'AI chip research', 'Accelerator design', 1)];
    const order = rank(items, feedback);
    expect(order[order.length - 1]).toBe('voted');
    expect(explanationOf(items, feedback, 'voted').tier).toBe('downvoted');
  });

  it('keeps a directly upvoted candidate on top even if it resembles a downvote', () => {
    const items = [article('voted', 'Celebrity chip gossip', 'Rumours about chips'), ...fillerArticles()];
    const feedback = [vote('voted', 'Celebrity chip gossip', 'Rumours about chips', 1), vote('bad', 'Celebrity gossip', 'rumours', -1)];
    expect(rank(items, feedback)[0]).toBe('voted');
    expect(explanationOf(items, feedback, 'voted').evidence.upvote).toBe(1);
  });

  it('uses the newest vote when an article was re-voted (feedback arrives newest first)', () => {
    const items = [article('topic', 'Crypto token exchange collapse', 'Token holders lose deposits'), ...fillerArticles()];
    const revoted = [
      vote('a', 'Crypto token exchange collapse', 'Token holders lose deposits', -1),
      vote('a', 'Crypto token exchange collapse', 'Token holders lose deposits', 1),
    ];
    const explanation = explanationOf(items, revoted, 'topic');
    expect(explanation.evidence.downvote).toBeGreaterThan(0.5);
    expect(explanation.evidence.upvote).toBe(0);
    expect(rank(items, revoted).at(-1)).toBe('topic');
  });

  it('forgets a removed vote', () => {
    const items = [article('topic', 'Crypto token exchange collapse', 'Token holders lose deposits'), ...fillerArticles()];
    const withVote = rank(items, [vote('a', 'Crypto token exchange', 'token deposits', -1)]);
    expect(withVote.at(-1)).toBe('topic');
    expect(rank(items, [])).toEqual(rank(items, []));
    expect(explanationOf(items, [], 'topic').evidence.downvote).toBe(0);
  });

  it('uses a re-fetched vote’s current text, even under the same article id', () => {
    const items = [
      article('rust', 'Rust compiler release notes', 'Borrow checker improvements'),
      article('violin', 'Violin maker restores antique instrument', 'Luthier repairs varnish'),
    ];
    expect(rank(items, [vote('v', 'Rust compiler', 'borrow checker', 1)])[0]).toBe('rust');
    expect(rank(items, [vote('v', 'Antique violin', 'luthier varnish', 1)])[0]).toBe('violin');
    expect(rank(items, [vote('v', 'Rust compiler', 'borrow checker', 1)])[0]).toBe('rust');
  });

  it('ignores invalid votes and malformed rows', () => {
    const items = [article('topic', 'Crypto token exchange collapse', 'Token holders lose deposits'), ...fillerArticles()];
    const malformed = [
      { ...vote('a', 'Crypto token exchange', 'token deposits', 1), vote: 0 },
      { ...vote('b', 'Crypto token exchange', 'token deposits', 1), vote: '1' },
      null,
      { ...vote('c', 'Crypto token exchange', 'token deposits', 1), title: null, summary: undefined, content: 42 },
    ] as unknown as ArticleFeedback[];
    expect(() => rank(items, malformed)).not.toThrow();
    const explanation = explanationOf(items, malformed, 'topic');
    expect(explanation.evidence.upvote).toBe(0);
    expect(explanation.evidence.downvote).toBe(0);
  });

  it('does not let many weak signals override a clear downvote', () => {
    const topic = 'Crypto token exchange collapse';
    const items = [
      article('crypto', topic, 'Token holders lose deposits', { sourceId: 'feed/crypto', starred: true, labels: ['user/-/label/read-later'] }),
      ...fillerArticles(),
    ];
    const context: IntelligenceContext = {
      subscriptions: [feed('feed/crypto', 'Crypto token exchange news', ['Crypto']), feed('feed/c2', 'Token exchange collapse')],
      savedArticles: Array.from({ length: 20 }, (_, index) => saved(`s${index}`, topic, 'Token holders lose deposits', { starred: true })),
    };
    const feedback = [vote('down', topic, 'Token holders lose deposits', -1)];
    const explanation = explanationOf(items, feedback, 'crypto', context);
    expect(explanation.evidence.saved).toBeGreaterThan(0.9);
    expect(explanation.tier).toBe('net-negative');
    expect(rank(items, feedback, context).at(-1)).toBe('crypto');
  });

  it('resolves conflicting preferences towards the closer example', () => {
    const items = [
      article('research', 'AI chip research lab results', 'Accelerator research breakthrough in the lab'),
      article('stocks', 'AI chip stock price rally', 'Speculators bid the stock price higher'),
      ...fillerArticles(),
    ];
    const feedback = [
      vote('up', 'AI chip research breakthrough', 'lab accelerator research results', 1),
      vote('down', 'AI chip stock price speculation', 'stock price speculators rally', -1),
    ];
    const order = rank(items, feedback);
    expect(order[0]).toBe('research');
    expect(order.at(-1)).toBe('stocks');
  });

  it('copes with sparse feedback that shares no vocabulary with the candidates', () => {
    const items = fillerArticles();
    const order = rank(items, [vote('x', 'Submarine cable outage', 'undersea fibre splice', 1)]);
    expect(order).toEqual(rank(items, []));
  });

  it('computes term statistics from the candidates only: unrelated votes do not change evidence', () => {
    const items = [article('chip', 'AI accelerator chip design', 'Accelerator efficiency research'), ...fillerArticles()];
    const base = [vote('v', 'AI accelerator chips', 'chip design and efficiency', 1)];
    // Fifty more upvotes that mention "chip" but nothing else in common: if they were
    // part of the corpus, "chip" would look common and its weight would collapse.
    const noisy = [...base, ...Array.from({ length: 50 }, (_, index) => vote(`n${index}`, `Potato chip flavour ${index}`, 'snack', -1))];
    const clean = explanationOf(items, base, 'chip').strongestUpvote!.similarity;
    const withNoise = explanationOf(items, noisy, 'chip').strongestUpvote!.similarity;
    expect(withNoise).toBeCloseTo(clean, 10);
  });
});

describe('Intelligence Next — text representation', () => {
  it('handles missing, empty, placeholder and non-string text without errors', () => {
    const items = [
      article('blank', '', ''),
      article('placeholder', 'Sans titre', ''),
      article('summary-only', 'Short', 'Summary about telescopes and galaxies', { content: '' }),
      { ...article('nulls', 'x'), title: null, summary: undefined, content: 7 } as unknown as Article,
      ...fillerArticles(),
    ];
    expect(() => explainIntelligenceNext(items, [vote('v', 'Telescope galaxies', 'astronomy', 1)], NOW)).not.toThrow();
    expect(rank(items, [vote('v', 'Telescope galaxies', 'astronomy', 1)])[0]).toBe('summary-only');
    expect(explanationOf(items, [], 'placeholder').evidence.confidence).toBe(0);
  });

  it('ignores markup, scripts and styles, including a script cut off by the length cap', () => {
    const scripted = article('scripted', 'Weekly digest', '', {
      content: `<style>.chip{color:red}</style><p>Weekly digest of local events</p><script>var chip = "accelerator";</script>`,
    });
    const truncated = article('truncated', 'Weekly digest two', '', {
      content: `<p>Local events</p>${' '.repeat(INTELLIGENCE_NEXT_PARAMETERS.maxRawChars)}<script>accelerator chip`,
    });
    const cutScript = article('cut', 'Weekly digest three', '', {
      content: `<p>Local events</p><script>${'accelerator chip '.repeat(2000)}</script>`,
    });
    const items = [scripted, truncated, cutScript, ...fillerArticles()];
    const feedback = [vote('v', 'Accelerator chip', 'accelerator chip', 1)];
    for (const id of ['scripted', 'truncated', 'cut']) expect(explanationOf(items, feedback, id).evidence.upvote).toBe(0);
  });

  it('decodes HTML entities', () => {
    const items = [article('entity', 'Caf&eacute; culture &amp; espresso', 'Baristas pull espresso shots'), ...fillerArticles()];
    expect(rank(items, [vote('v', 'Café espresso', 'baristas', 1)])[0]).toBe('entity');
  });

  it('maps synonyms and inflections to one term, counting adjacent synonyms once', () => {
    const items = [
      article('ml', 'Deep learning breakthrough', 'Researchers publish results'),
      article('markets', 'Bond markets wobble', 'Traders sell gilts'),
      ...fillerArticles(),
    ];
    // "learning" and "markets" only reach their groups through their stems.
    expect(rank(items, [vote('v', 'Artificial intelligence', 'computers', 1)])[0]).toBe('ml');
    expect(rank(items, [vote('v', 'Economy outlook', 'growth forecast', 1)])[0]).toBe('markets');
    const explained = explainIntelligenceNext(items, [vote('v', 'Artificial intelligence', 'machine learning', 1)], NOW);
    // "machine learning" is one mention of the group, not two, so it matches "learning" alone fully.
    expect(explained.find((item) => item.article.id === 'ml')!.evidence.upvote).toBeGreaterThan(0.3);
  });

  it('treats the pronoun "us" differently from the country "US"', () => {
    const items = [
      article('pronoun', 'Join us for a picnic', 'Tell us what to bring'),
      article('country', 'US tariffs widen', 'US trade policy shifts'),
      ...fillerArticles(),
    ];
    const explanation = explanationOf(items, [vote('v', 'US elections', 'US voters', 1)], 'pronoun');
    expect(explanation.evidence.upvote).toBe(0);
    expect(rank(items, [vote('v', 'US elections', 'US voters', 1)])[0]).toBe('country');
  });

  it('discounts positive evidence on texts too short to judge', () => {
    const items = [
      article('short', 'Chips', ''),
      article('long', 'Chip accelerator design research', 'Accelerator chips improve efficiency'),
      ...fillerArticles(),
    ];
    const feedback = [vote('v', 'Chip accelerator', 'chips accelerator design', 1)];
    expect(explanationOf(items, feedback, 'short').evidence.confidence).toBeLessThan(1);
    expect(rank(items, feedback)[0]).toBe('long');
  });
});

describe('Intelligence Next — subscriptions', () => {
  it('lets a newly subscribed feed with no articles yet influence ranking from its metadata', () => {
    const items = [
      article('racing', 'Formula racing championship standings', 'Drivers battle for the title', { sourceId: 'feed/news' }),
      article('garden', 'Tomato seedlings need warm soil', 'Gardeners transplant seedlings', { sourceId: 'feed/news' }),
    ];
    const before = { subscriptions: [feed('feed/news', 'Daily news')] };
    const after = { subscriptions: [...before.subscriptions, feed('feed/f1', 'Formula racing', ['Motorsport'])] };
    expect(explanationOf(items, [], 'racing', before).evidence.subscription).toBe(0);
    const explained = explanationOf(items, [], 'racing', after);
    expect(explained.evidence.subscription).toBeGreaterThan(0);
    expect(explained.strongestFeedId).toBe('feed/f1');
    expect(explanationOf(items, [], 'garden', after).evidence.subscription).toBe(0);
    // Equal freshness, so without the new feed the input order decides; with it, racing moves up.
    const swapped = [items[1], items[0]];
    expect(rank(swapped, [], before)).toEqual(['garden', 'racing']);
    expect(rank(swapped, [], after)).toEqual(['racing', 'garden']);
  });

  it('counts a new feed’s articles as soon as another subscribed feed covers the same subject', () => {
    const items = [
      ...fillerArticles(),
      article('new-1', 'Rust compiler release notes', 'Borrow checker improvements', { sourceId: 'feed/rust' }),
    ];
    const fillerFeeds = filler.map((_, index) => feed(`feed/filler-${index}`, `Filler ${index}`));
    const alone = { subscriptions: [feed('feed/rust', 'Rust programming language'), ...fillerFeeds] };
    // Its own feed cannot vouch for it…
    expect(explanationOf(items, [], 'new-1', alone).evidence.subscription).toBe(0);
    // …but a second, independent feed on the subject does, straight away.
    const corroborated = { subscriptions: [...alone.subscriptions, feed('feed/rust-weekly', 'This week in Rust', ['Programming'])] };
    const explanation = explanationOf(items, [], 'new-1', corroborated);
    expect(explanation.evidence.subscription).toBeGreaterThan(0);
    expect(explanation.strongestFeedId).toBe('feed/rust-weekly');
    expect(rank(items, [], corroborated)[0]).toBe('new-1');
  });

  it('does not let a repetitive feed vouch for its own articles', () => {
    const jobs = Array.from({ length: 10 }, (_, index) => article(
      `job${index}`,
      `Senior engineer job opening ${index}`,
      'Apply now: remote engineer role with great benefits',
      { sourceId: 'feed/jobs' },
    ));
    const items = [...jobs, ...fillerArticles()];
    const context = { subscriptions: [feed('feed/jobs', 'Job board'), ...filler.map(([id], index) => feed(`feed/filler-${index}`, id))] };
    const explained = explainIntelligenceNext(items, [], NOW, context);
    // Ten near-identical postings resemble their own feed's profile almost
    // perfectly; that says the feed is templated, not that the reader cares.
    for (const item of explained.filter((entry) => entry.article.sourceId === 'feed/jobs')) {
      expect(item.evidence.subscription).toBe(0);
      expect(item.strongestFeedId).toBeNull();
    }
  });

  it('judges a niche topic by its closest feeds, not diluted by many unrelated ones', () => {
    const markets = Array.from({ length: 5 }, (_, feedIndex) => [0, 1, 2].map((copy) => article(
      `m${feedIndex}-${copy}`,
      `Stock market rally lifts bond yields ${['again', 'today', 'sharply'][copy]}`,
      'Investors watch inflation, earnings and interest rates',
      { sourceId: `feed/markets-${feedIndex}` },
    ))).flat();
    const wood = [
      article('w1', 'Hand cut dovetail joints in walnut', 'Chisel, saw and workbench basics for joinery', { sourceId: 'feed/wood' }),
      article('w2', 'Sharpening a chisel for clean joinery', 'Dovetail practice on a walnut offcut at the workbench', { sourceId: 'feed/joinery' }),
    ];
    // An unrelated article from a feed nothing else corroborates: no subscription evidence.
    const garden = article('garden', 'Tomato seedlings need warm soil', 'Gardeners transplant tomato seedlings after frost', { sourceId: 'feed/garden' });
    const items = [garden, ...markets, ...wood];
    const woodFeeds = [feed('feed/wood', 'Woodworking shop', ['Hobbies']), feed('feed/joinery', 'Joinery journal', ['Hobbies'])];
    const marketFeeds = markets.filter((_, i) => i % 3 === 0).map((m) => feed(m.sourceId, 'Markets daily', ['Finance']));
    const everything = { subscriptions: [feed('feed/garden', 'Allotment'), ...marketFeeds, ...woodFeeds] };
    const alone = explanationOf(items, [], 'w1', { subscriptions: woodFeeds }).evidence.subscription;
    expect(alone).toBeGreaterThan(0.2);
    // Following five market feeds as well does not shrink the woodworking evidence…
    expect(explanationOf(items, [], 'w1', everything).evidence.subscription).toBeCloseTo(alone, 9);
    // …so the niche article still ranks above one nothing vouches for, though that one is first in the input.
    expect(explanationOf(items, [], 'garden', everything).evidence.subscription).toBe(0);
    const ranked = rank(items, [], everything);
    expect(ranked.indexOf('w1')).toBeLessThan(ranked.indexOf('garden'));
  });

  it('gives no subscription evidence to articles from feeds the reader no longer follows', () => {
    const items = [
      article('gone', 'Rust compiler release notes', 'Borrow checker improvements', { sourceId: 'feed/unsubscribed' }),
      article('kept', 'Rust language survey', 'Borrow checker complaints', { sourceId: 'feed/rust' }),
    ];
    const context = { subscriptions: [feed('feed/rust', 'Rust programming language'), feed('feed/rust-weekly', 'Rust borrow checker news')] };
    expect(explanationOf(items, [], 'gone', context).evidence.subscription).toBe(0);
    expect(explanationOf(items, [], 'kept', context).evidence.subscription).toBeGreaterThan(0);
  });

  it('gives a prolific feed no extra subscription weight for its volume', () => {
    const products = ['laptop', 'camera', 'headphones', 'blender', 'vacuum', 'monitor', 'keyboard', 'mattress', 'sneakers', 'backpack',
      'drone', 'tablet', 'speaker', 'router', 'printer', 'kettle', 'toaster', 'jacket', 'watch', 'phone', 'projector', 'charger',
      'microwave', 'bicycle', 'lamp', 'grill', 'tent', 'luggage', 'perfume', 'console', 'desk', 'chair', 'fridge', 'oven', 'scooter',
      'guitar', 'sofa', 'heater', 'fan', 'mixer'];
    // Forty distinct posts (no two are near-duplicates), so only the feed-level bounds are under test.
    const deals = products.map((product, index) =>
      article(`p${index}`, `${product} price drop`, `Discount coupon for the ${product}`, { sourceId: 'feed/deals', published: NOW - index * 60_000 }));
    const suffixes = ['amber', 'birch', 'cobalt', 'dune', 'ember', 'fjord', 'glacier', 'harbor', 'iris', 'juniper', 'kestrel', 'lagoon', 'meadow', 'nectar', 'orchid'];
    const others = filler.flatMap(([, title, summary], feedIndex) => [0, 1, 2].map((copy) =>
      article(`o${feedIndex}-${copy}`, `${title} ${suffixes[feedIndex * 3 + copy]}`, summary, { sourceId: `feed/other-${feedIndex}`, published: NOW - 6 * HOUR })));
    const subscriptions = [
      feed('feed/deals', 'Deals'),
      ...filler.map(([topic], index) => feed(`feed/other-${index}`, topic)),
      feed('feed/bargains', 'Price drop and discount coupon deals', ['Shopping']), // a second feed on the subject
    ];
    const single = explanationOf([deals[0], ...others], [], 'p0', { subscriptions });
    const flooded = explanationOf([...deals, ...others], [], 'p0', { subscriptions });
    expect(single.evidence.subscription).toBeGreaterThan(0.2);
    expect(single.strongestFeedId).toBe('feed/bargains');
    // Thirty-nine more posts from the same feed vouch for nothing; the subject only becomes less distinctive.
    expect(flooded.evidence.subscription).toBeLessThan(single.evidence.subscription);
    expect(flooded.strongestFeedId).toBe('feed/bargains');
    // In the list the feed alternates with the others instead of filling the head.
    const ranked = rankIntelligenceNext([...deals, ...others], [], NOW, { subscriptions });
    expect(ranked[0].sourceId).toBe('feed/deals');
    expect(ranked.slice(0, 12).filter((item) => item.sourceId === 'feed/deals').length).toBeLessThanOrEqual(8);
    expectNoAvoidableSourceRuns(ranked);
  });

  it('still applies a downvote when its topic makes up most of the unread list', () => {
    const deals = Array.from({ length: 40 }, (_, index) =>
      article(`p${index}`, `Daily deals roundup number ${index}`, 'Discount coupons and deals', { sourceId: 'feed/deals' }));
    const items = [...deals, ...fillerArticles()];
    const explained = explainIntelligenceNext(items, [vote('d', 'Daily deals roundup', 'Discount coupons and deals', -1)], NOW);
    expect(explained.filter((item) => item.article.sourceId === 'feed/deals').every((item) => item.tier === 'net-negative')).toBe(true);
    expect(explained.slice(0, 5).every((item) => item.article.sourceId !== 'feed/deals')).toBe(true);
  });

  it('keeps subscription evidence below explicit feedback', () => {
    const items = [
      article('voted-topic', 'Violin maker restores antique instrument', 'Luthier repairs varnish', { sourceId: 'feed/music' }),
      article('feed-topic', 'Rust compiler release notes', 'Borrow checker improvements', { sourceId: 'feed/rust' }),
      article('feed-topic-2', 'Rust async runtime benchmarks', 'Borrow checker and async', { sourceId: 'feed/rust' }),
    ];
    const context = {
      subscriptions: [feed('feed/rust', 'Rust compiler borrow checker'), feed('feed/rust-weekly', 'Rust compiler borrow checker'), feed('feed/music', 'Music')],
    };
    const feedback = [vote('v', 'Antique violin restoration', 'luthier varnish', 1)];
    const voted = explanationOf(items, feedback, 'voted-topic', context);
    const followed = explanationOf(items, feedback, 'feed-topic', context);
    expect(followed.evidence.subscription).toBeGreaterThan(voted.evidence.upvote); // stronger match…
    expect(rank(items, feedback, context)[0]).toBe('voted-topic'); // …but a weaker signal
    const disliked = [vote('d', 'Rust compiler borrow checker', 'Rust compiler release notes', -1)];
    expect(rank(items, disliked, context).at(-1)).toMatch(/^feed-topic/);
    expect(explanationOf(items, disliked, 'feed-topic', context).tier).toBe('net-negative');
  });
});

describe('Intelligence Next — starred and read-later', () => {
  const telescope = () => [
    article('astro', 'Telescope images distant galaxies', 'Astronomers capture galaxy clusters'),
    ...fillerArticles(),
  ];

  it('uses starred articles that are no longer candidates as weak positive evidence', () => {
    const context = { savedArticles: [saved('s', 'Telescope galaxies', 'astronomers capture clusters', { starred: true })] };
    expect(rank(telescope(), [], context)[0]).toBe('astro');
    expect(explanationOf(telescope(), [], 'astro', context).evidence.saved).toBeGreaterThan(0);
  });

  it('weights read-later below starred and both below an upvote', () => {
    const items = telescope();
    const starred = explanationOf(items, [], 'astro', { savedArticles: [saved('s', 'Telescope galaxies', 'astronomers', { starred: true })] });
    const later = explanationOf(items, [], 'astro', { savedArticles: [saved('s', 'Telescope galaxies', 'astronomers', { readLater: true })] });
    const upvoted = explanationOf(items, [vote('s', 'Telescope galaxies', 'astronomers', 1)], 'astro');
    expect(later.score).toBeLessThan(starred.score);
    expect(starred.score).toBeLessThan(upvoted.score);
  });

  it('lets an explicit vote on a saved article replace the implicit signal', () => {
    const context = { savedArticles: [saved('s', 'Telescope galaxies', 'astronomers capture clusters', { starred: true })] };
    const explanation = explanationOf(telescope(), [vote('s', 'Telescope galaxies', 'astronomers capture clusters', -1)], 'astro', context);
    expect(explanation.evidence.saved).toBe(0);
    expect(explanation.tier).toBe('net-negative');
  });

  it('prefers live candidate flags over a stale snapshot', () => {
    const items = telescope();
    const staleSnapshot = { savedArticles: [saved('astro', 'Telescope images distant galaxies', 'Astronomers capture galaxy clusters', { starred: true })] };
    expect(explanationOf(items, [], 'astro', staleSnapshot).evidence.saved).toBe(0);
    const starredNow = items.map((item) => (item.id === 'astro' ? { ...item, starred: true } : item));
    expect(explanationOf(starredNow, [], 'astro', staleSnapshot).evidence.saved).toBe(1);
  });

  it('recognises read-later sub-categories', () => {
    const items = telescope().map((item) => (item.id === 'astro' ? { ...item, labels: ['user/-/label/read-later/Science'] } : item));
    expect(explanationOf(items, [], 'astro').evidence.saved).toBeCloseTo(INTELLIGENCE_NEXT_PARAMETERS.readLaterStrength, 10);
  });

  it('does not treat read status as a preference', () => {
    const items = telescope();
    const feedback = [vote('v', 'Tennis final', 'championship match', 1)];
    const allRead = items.map((item) => ({ ...item, read: true }));
    expect(rank(allRead, feedback)).toEqual(rank(items, feedback));
  });
});

describe('Intelligence Next — freshness, duplicates and diversity', () => {
  it('orders by freshness when there is no other evidence', () => {
    const items = fillerArticles().map((item, index) => ({ ...item, published: NOW - (index + 1) * 5 * HOUR })).reverse();
    expect(rank(items)).toEqual(['garden', 'recipe', 'hiking', 'violin', 'tennis']);
  });

  it('keeps a strongly relevant old article above an irrelevant brand-new one', () => {
    const items = [
      article('old', 'Telescope images distant galaxies', 'Astronomers capture clusters', { published: NOW - 30 * 24 * HOUR }),
      ...fillerArticles().map((item) => ({ ...item, published: NOW })),
    ];
    expect(rank(items, [vote('v', 'Telescope galaxies', 'astronomers capture clusters', 1)])[0]).toBe('old');
  });

  it('prefers the fresher of two equally relevant articles', () => {
    const items = [
      article('older', 'Telescope images galaxies', 'Astronomers capture clusters', { published: NOW - 72 * HOUR, sourceId: 'feed/a' }),
      article('newer', 'Telescope images galaxies', 'Astronomers capture clusters', { published: NOW - HOUR, sourceId: 'feed/b' }),
      ...fillerArticles(),
    ];
    expect(rank(items, [vote('v', 'Telescope galaxies', 'astronomers capture clusters', 1)])[0]).toBe('newer');
  });

  it('survives invalid dates and clocks', () => {
    const items = [article('nan', 'Telescope galaxies', 'astronomy', { published: Number.NaN }), ...fillerArticles()];
    expect(() => rankIntelligenceNext(items, [], Number.NaN)).not.toThrow();
    expect(explanationOf(items, [], 'nan').evidence.freshness).toBe(0);
  });

  it('moves a near-duplicate of an article already shown out of the head', () => {
    const story = 'Nvidia unveils new AI accelerator chip for data centres';
    const items = [
      article('copy-a', story, 'The accelerator doubles inference throughput', { sourceId: 'feed/a' }),
      article('copy-b', story, 'The accelerator doubles inference throughput', { sourceId: 'feed/b' }),
      article('amd', 'AMD accelerator chip roadmap', 'New chips for inference workloads', { sourceId: 'feed/c' }),
      article('intel', 'Intel opens accelerator chip factory', 'Fabrication of inference chips', { sourceId: 'feed/d' }),
      ...fillerArticles(),
    ];
    const order = rank(items, [vote('v', 'AI accelerator chips for inference', 'data centre accelerator chip', 1)]);
    const [first, second] = [order.indexOf('copy-a'), order.indexOf('copy-b')].sort((a, b) => a - b);
    expect(first).toBe(0);
    expect(second).toBeGreaterThan(order.indexOf('amd'));
    expect(second).toBeGreaterThan(order.indexOf('intel'));
  });

  it('avoids more than two consecutive articles from one source when alternatives exist', () => {
    const astronomy = [
      ['Telescope images distant galaxies', 'Astronomers capture galaxy clusters'],
      ['Radio telescope maps hydrogen clouds', 'Astronomers chart the galaxy disc'],
      ['Space telescope spots exoplanet atmosphere', 'Astronomers detect water vapour'],
      ['Galaxy merger simulation released', 'Astronomers model colliding galaxies'],
      ['Telescope mirror segments installed', 'Observatory engineers align mirrors for astronomers'],
      ['Supernova seen in nearby galaxy', 'Astronomers follow the telescope alert'],
    ];
    const items = [
      ...astronomy.map(([title, summary], index) => article(`same-${index}`, title, summary, { sourceId: 'feed/same' })),
      ...fillerArticles(),
    ];
    const ranked = rankIntelligenceNext(items, [vote('v', 'Telescope galaxies', 'astronomers', 1)], NOW);
    expect(ranked[0].sourceId).toBe('feed/same');
    expectNoAvoidableSourceRuns(ranked);
  });

  it('does not let source variety override a large relevance gap', () => {
    // Distinct articles (no shared template), so neither similarity nor the
    // near-duplicate rule can explain the outcome — only the source penalty.
    const rust = [
      ['Rust compiler speeds up borrow checking', 'The Rust compiler release cuts borrow checker time on large crates'],
      ['Borrow checker in the Rust compiler explains lifetimes', 'Rust diagnostics now point at the conflicting borrow'],
      ['Async Rust: the compiler accepts trait methods', 'The Rust compiler and borrow checker now handle async traits'],
      ['Cargo and the Rust compiler resolve faster', 'Rust builds with the new compiler release finish sooner'],
      ['Rust kernel driver passes a borrow checker audit', 'The borrow checker caught three memory bugs in Rust code'],
    ].map(([title, summary], index) => article(`rust-${index}`, title, summary, { sourceId: 'feed/rust' }));
    const sky = [
      ['Telescope images a distant galaxy cluster', 'Astronomers used the telescope to measure light bent by the galaxy'],
      ['Galaxy survey telescope upgrade completed', 'Astronomers aligned the telescope mirror before new galaxy images'],
      ['Astronomers catch two galaxy cores merging', 'Telescope images show the galaxy collision in infrared'],
      ['Telescope maps a million stars in our galaxy', 'Astronomers say the galaxy catalogue doubles the known sample'],
      ['Supernova in a nearby galaxy seen by telescope', 'Amateur astronomers confirmed it with a small telescope'],
    ].map(([title, summary], index) => article(`sky-${index}`, title, summary, { sourceId: 'feed/sky' }));
    // Each mentions one vote word in passing and comes from its own source.
    const weak = [
      ['Town council meeting schedule', 'A compiler of local statistics presented the parking report'],
      ['Phone shop opens downtown', 'The new Galaxy handsets sit next to cheaper tablets'],
      ['Spring bicycle maintenance tips', 'Remove rust from the chain before the first long ride'],
      ['School holiday dates announced', 'The science club will visit the telescope shop in May'],
      ['Board game night returns', 'Chess and checker tables are free on Thursdays'],
    ].map(([title, summary], index) => article(`weak-${index}`, title, summary, { sourceId: `feed/weak-${index}` }));
    const feedback = [
      vote('r', 'Rust compiler borrow checker', 'Rust compiler and borrow checker release', 1),
      vote('s', 'Telescope galaxy images', 'Astronomers use a telescope to study the galaxy', 1),
    ];
    const explained = explainIntelligenceNext([...rust, ...sky, ...weak], feedback, NOW);
    const score = (prefix: string) => explained.filter((item) => item.article.id.startsWith(prefix)).map((item) => item.score);
    // Precondition: a clear gap between the two groups.
    expect(Math.max(...score('weak'))).toBeLessThan(0.6 * Math.min(...score('rust'), ...score('sky')));
    // The first nine are all strong; at most one weak article may break up an
    // otherwise unavoidable third sky article in a row (`maxSourceRun`).
    expect(explained.slice(0, 9).every((item) => !item.article.id.startsWith('weak'))).toBe(true);
    expect(explained.slice(0, 11).filter((item) => item.article.id.startsWith('weak'))).toHaveLength(1);
    expectNoAvoidableSourceRuns(explained.map((item) => item.article));
  });

  it('keeps alike, strongly relevant articles above weak ones from new sources', () => {
    // Same-topic articles that share most of their wording (not near
    // duplicates): the harsh case for a similarity penalty.
    const rust = ['diagnostics improve', 'release notes', 'async rules', 'cargo caching', 'lifetime elision']
      .map((topic, index) => article(`rust-${index}`, `Rust ${topic}`, `Rust compiler and borrow checker: ${topic}`, { sourceId: 'feed/rust' }));
    const sky = ['cluster images', 'mirror upgrade', 'merger observed', 'survey results', 'nearby supernova']
      .map((topic, index) => article(`sky-${index}`, `Telescope ${topic}`, `Astronomers use a telescope to study the galaxy: ${topic}`, { sourceId: 'feed/sky' }));
    const weak = ['Compiler conference schedule', 'Galaxy smartphone review', 'Rust removal for bicycles', 'Telescope shop opens downtown', 'Checker board game night']
      .map((title, index) => article(`weak-${index}`, title, 'Local roundup: parking, school holidays and the weather', { sourceId: `feed/weak-${index}` }));
    const feedback = [
      vote('r', 'Rust compiler borrow checker', 'Rust compiler and borrow checker release', 1),
      vote('s', 'Telescope galaxy images', 'Astronomers use a telescope to study the galaxy', 1),
    ];
    const explained = explainIntelligenceNext([...rust, ...sky, ...weak], feedback, NOW);
    const score = (prefix: string) => explained.filter((item) => item.article.id.startsWith(prefix)).map((item) => item.score);
    expect(Math.max(...score('weak'))).toBeLessThan(0.6 * Math.min(...score('rust'), ...score('sky')));
    expect(explained.slice(0, 9).every((item) => !item.article.id.startsWith('weak'))).toBe(true);
    expect(explained.slice(0, 11).filter((item) => item.article.id.startsWith('weak')).length).toBeLessThanOrEqual(1);
    expectNoAvoidableSourceRuns(explained.map((item) => item.article));
  });

  it('lets diversity reorder only articles of comparable relevance', () => {
    // `high` repeats the source and much of the wording of `top`; `low` is
    // fresh on both counts but far less relevant. Variety may cost an article
    // at most `similarityPenalty + sourcePenalty` of its own score, so `low`
    // must not overtake `high` (an absolute penalty of the same size would let it).
    const items = [
      article('top', 'Rust release notes for the zebra toolkit', 'Rust compiler release notes: zebra toolkit quokka plugin narwhal walrus okapi', { sourceId: 'feed/zebra' }),
      article('high', 'Zebra toolkit quokka plugin in Rust', 'Zebra toolkit quokka plugin narwhal walrus okapi ported to the borrow checker', { sourceId: 'feed/zebra' }),
      article('low', 'Compiler release party tonight', 'Speakers announced for the city hall event', { sourceId: 'feed/events' }),
      article('f1', 'Tennis final report', 'Baseline rallies decide the match', { sourceId: 'feed/tennis' }),
      article('f2', 'Garden tomatoes ripen', 'Compost and watering tips', { sourceId: 'feed/garden' }),
      article('f3', 'Train timetable changes', 'Weekend works on the line', { sourceId: 'feed/trains' }),
    ];
    const explained = explainIntelligenceNext(items, [vote('r', 'Rust compiler release notes', 'Rust compiler borrow checker release', 1)], NOW);
    const floor = 1 - INTELLIGENCE_NEXT_PARAMETERS.similarityPenalty - INTELLIGENCE_NEXT_PARAMETERS.sourcePenalty;
    const scoreOf = (id: string) => explained.find((item) => item.article.id === id)!.score;
    expect(scoreOf('low')).toBeLessThan(floor * scoreOf('high'));
    expect(ids(explained.map((item) => item.article))).toEqual(['top', 'high', 'low', 'f1', 'f2', 'f3']);
    explained.forEach((earlier, index) => {
      for (const later of explained.slice(index + 1)) expect(earlier.score).toBeGreaterThanOrEqual(floor * later.score);
    });
  });

  it('never lifts a net-negative article above a neutral one for diversity', () => {
    const items = [
      ...Array.from({ length: 5 }, (_, index) => article(`ok-${index}`, `Tennis final report ${index}`, 'Baseline rallies', { sourceId: 'feed/tennis' })),
      article('bad', 'Celebrity gossip rumours', 'Celebrity relationship rumours', { sourceId: 'feed/other' }),
    ];
    const explained = explainIntelligenceNext(items, [vote('d', 'Celebrity gossip', 'celebrity rumours', -1)], NOW);
    expect(explained.at(-1)!.article.id).toBe('bad');
    const firstNegative = explained.findIndex((item) => item.tier !== 'normal');
    expect(explained.slice(firstNegative).every((item) => item.tier !== 'normal')).toBe(true);
  });
});

describe('Intelligence Next — explanations and scale', () => {
  it('explains every article with bounded evidence and the strongest matches', () => {
    const items = [article('chip', 'AI accelerator chip design', 'Accelerator research', { sourceId: 'feed/news' }), ...fillerArticles()];
    const feedback = [vote('up', 'AI accelerator chips', 'accelerator research', 1)];
    const context = { subscriptions: [feed('feed/news', 'Daily news'), feed('feed/hw', 'Hardware accelerators')] };
    const explained = explainIntelligenceNext(items, feedback, NOW, context);
    expect(explained).toHaveLength(items.length);
    for (const item of explained) {
      for (const value of Object.values(item.evidence)) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
      expect(Number.isFinite(item.score)).toBe(true);
    }
    const chip = explained.find((item) => item.article.id === 'chip')!;
    expect(chip.strongestUpvote?.articleId).toBe('up');
    expect(chip.strongestFeedId).toBe('feed/hw');
  });

  it('ranks a large unread list against a long vote history quickly', () => {
    const words = ['chip', 'garden', 'violin', 'tennis', 'lentil', 'galaxy', 'rust', 'bond', 'climate', 'election', 'opera', 'glacier'];
    const text = (seed: number, length: number) =>
      Array.from({ length }, (_, index) => `${words[(seed * 7 + index * 3) % words.length]}${(seed + index) % 37}`).join(' ');
    const items = Array.from({ length: 1000 }, (_, index) =>
      article(`a${index}`, text(index, 8), text(index + 1, 60), { sourceId: `feed/${index % 40}`, published: NOW - index * 600_000 }));
    const feedback = Array.from({ length: 1000 }, (_, index) => vote(`f${index}`, text(index * 13, 8), text(index * 17, 60), index % 3 ? 1 : -1));
    const subscriptions = Array.from({ length: 40 }, (_, index) => feed(`feed/${index}`, `Feed ${index}`));
    const started = performance.now();
    const ranked = rankIntelligenceNext(items, feedback, NOW, { subscriptions });
    const elapsed = performance.now() - started;
    expect(ranked).toHaveLength(1000);
    expect(new Set(ranked).size).toBe(1000);
    // Generous bound for slow CI machines; the evaluation notes record real timings.
    expect(elapsed).toBeLessThan(10_000);
  });
});
