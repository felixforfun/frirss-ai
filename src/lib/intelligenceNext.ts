/**
 * Intelligence Next — a local, deterministic and explainable ranker for the
 * Interesting view.
 *
 * Every signal becomes a bounded piece of evidence in [0, 1]:
 *
 * - explicit votes (strong): similarity to upvoted / downvoted articles,
 * - starred and read-later articles (weak positive),
 * - subscriptions (weak positive): every subscribed feed is a feed-level
 *   example, profiled from its recent articles plus its title and folders;
 *   an article scores by its closest few *other* feeds. Each feed is one
 *   unit-length profile however many articles it has, so a prolific feed
 *   weighs no more than a small one, a just-added feed counts from its title
 *   and folders alone, and a repetitive feed cannot vouch for itself,
 * - freshness, which scales relevance instead of replacing it.
 *
 * A bounded maximal-marginal-relevance pass then adds variety to the head of
 * the list. Its penalties scale an article's relevance by at most 35 %, so it
 * mainly reorders articles of comparable relevance; the final source-run
 * breaking can still move an article a few places. Neither pass touches
 * articles with net-negative evidence or a direct downvote, so variety never
 * lifts what the reader voted against.
 *
 * Read state is not a signal, and no dwell/scroll data is used. All weights
 * below are hand-set heuristics that have not been validated on real reading
 * data. The design draws on textbook IR techniques (BM25F term weighting,
 * Rocchio-style feedback, nearest-neighbour evidence, maximal marginal
 * relevance); it is not a port of any product's recommender.
 */
import type { Article, Subscription } from '../types';
import type { ArticleFeedback } from '../api/intelligence';
import { articleSource, diversifyBy, meaningfulShortTerms, stemTerm, synonymMap, validVote } from './intelligenceShared';

/** Starred / read-later article the reader saved; may be read (not a candidate). */
export interface SavedArticleSignal {
  id: string;
  title: string;
  summary: string;
  content: string;
  sourceId: string;
  starred: boolean;
  readLater: boolean;
}

export interface IntelligenceContext {
  /** Current subscriptions. Articles from feeds not listed here get no subscription evidence. */
  subscriptions?: Subscription[];
  /** Snapshot of starred / read-later articles. Live flags on candidates take precedence. */
  savedArticles?: SavedArticleSignal[];
}

/** Every tunable used by Intelligence Next, in one place. Heuristic, not fitted. */
export const INTELLIGENCE_NEXT_PARAMETERS = Object.freeze({
  // Representation
  titleWeight: 2,
  titleTokens: 30,
  leadTokens: 100,
  maxRawChars: 20_000,
  bm25K1: 1.2,
  bm25B: 0.75,
  // Evidence
  maxExplicitExamples: 1000,
  maxSavedExamples: 400,
  nearestExamples: 3,
  starredStrength: 1,
  readLaterStrength: 0.6,
  feedRecentArticles: 30,
  feedMetadataWeight: 1,
  confidenceTerms: 5,
  // Score
  upvoteWeight: 1,
  downvoteWeight: 1.5,
  savedWeight: 0.35,
  subscriptionWeight: 0.2,
  freshnessHalfLifeHours: 72,
  freshnessShare: 0.3,
  freshnessTieBreak: 0.02,
  // Diversity
  diversityPool: 80,
  diversitySelections: 30,
  similarityPenalty: 0.25,
  sourcePenalty: 0.1,
  nearDuplicatePenalty: 2,
  nearDuplicateCosine: 0.85,
  nearDuplicateTitleJaccard: 0.6,
  nearDuplicateMinTitleTerms: 3,
  maxSourceRun: 2,
});
const P = INTELLIGENCE_NEXT_PARAMETERS;

/** FreshRSS stream id of the read-later label (mirrors `READ_LATER_LABEL` in feedStore). */
const READ_LATER_STREAM = 'user/-/label/read-later';
/** Read-later sub-categories (`savedCategories.ts`), current and legacy names. */
const READ_LATER_CATEGORY_PREFIXES = [`${READ_LATER_STREAM}/`, 'user/-/label/À lire plus tard/'];
/** Title FriRSS substitutes when an item has none; it carries no meaning. */
const UNTITLED = 'Sans titre';

export type IntelligenceNextTier = 'normal' | 'net-negative' | 'downvoted';

export interface EvidenceMatch {
  articleId: string;
  title: string;
  similarity: number;
}

/** Why an article sits where it does; every evidence value is in [0, 1]. */
export interface IntelligenceNextExplanation {
  article: Article;
  tier: IntelligenceNextTier;
  score: number;
  directVote: 1 | -1 | null;
  evidence: {
    upvote: number;
    downvote: number;
    saved: number;
    subscription: number;
    freshness: number;
    confidence: number;
  };
  strongestUpvote: EvidenceMatch | null;
  strongestDownvote: EvidenceMatch | null;
  strongestSaved: EvidenceMatch | null;
  strongestFeedId: string | null;
}

// ── Text representation ─────────────────────────────────────────────────

const STOPWORDS = new Set([
  // English
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can', 'had', 'her', 'was', 'one', 'our', 'out',
  'has', 'have', 'his', 'how', 'its', 'may', 'new', 'now', 'see', 'two', 'way', 'who', 'did', 'get', 'got', 'him',
  'let', 'say', 'says', 'said', 'she', 'too', 'use', 'used', 'with', 'that', 'this', 'from', 'they', 'will', 'would',
  'there', 'their', 'what', 'about', 'which', 'when', 'your', 'more', 'been', 'than', 'them', 'then', 'into', 'also',
  'just', 'over', 'such', 'only', 'some', 'very', 'after', 'before', 'most', 'other', 'these', 'those', 'where',
  'while', 'could', 'should', 'being', 'because', 'does', 'each', 'here', 'like', 'make', 'many', 'much', 'must',
  'even', 'back', 'well', 'were', 'via', 'why',
  // French
  'les', 'des', 'une', 'est', 'que', 'qui', 'dans', 'pour', 'par', 'sur', 'pas', 'plus', 'avec', 'ses', 'aux',
  'mais', 'ont', 'été', 'cette', 'ces', 'elle', 'ils', 'nous', 'vous', 'leur', 'leurs', 'comme', 'tout', 'tous',
  'sont', 'fait', 'sans', 'entre', 'être', 'avoir', 'même', 'aussi', 'après', 'avant',
  // German
  'der', 'die', 'das', 'und', 'den', 'dem', 'des', 'ein', 'eine', 'einer', 'eines', 'einem', 'einen', 'ist', 'sind',
  'mit', 'von', 'für', 'auf', 'aus', 'bei', 'nach', 'sich', 'nicht', 'auch', 'als', 'wie', 'oder', 'aber', 'wird',
  'werden', 'wurde', 'haben', 'noch', 'nur', 'zum', 'zur', 'über', 'unter', 'durch', 'vor', 'bis', 'kann', 'mehr',
  'dass', 'sie', 'ihr', 'wir', 'ich',
]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"',
  hellip: ' ', mdash: ' ', ndash: ' ', eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', agrave: 'à', acirc: 'â',
  ccedil: 'ç', ocirc: 'ô', ucirc: 'û', ugrave: 'ù', icirc: 'î', iuml: 'ï', auml: 'ä', ouml: 'ö', uuml: 'ü', szlig: 'ß',
};

function decodeEntity(body: string): string {
  if (body[0] === '#') {
    const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
  }
  return NAMED_ENTITIES[body.toLowerCase()] ?? ' ';
}

/** HTML → plain text: no script/style bodies, no tags, entities decoded. */
function plainText(value: unknown): string {
  const raw = typeof value === 'string' ? value : '';
  let text = raw.slice(0, P.maxRawChars)
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    // A script/style block the length cap cut before its closing tag.
    .replace(/<(script|style|noscript)\b[\s\S]*$/i, ' ')
    .replace(/<[^>]*>/g, ' ');
  // A tag cut in half by the length cap would otherwise leak attribute text.
  if (raw.length > P.maxRawChars) text = text.replace(/<[^>]*$/, ' ');
  return text.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]{2,8});/gi, (_, body: string) => decodeEntity(body));
}

/**
 * Synonym roots keyed by stem, so every inflection of a listed word reaches its
 * group: "markets" and "market", "learning" and "learned", "emission(s)".
 * The shared `normalizeTerm` looks the stem up by the listed spelling and so
 * misses those; it is left unchanged here to keep the older models' rankings.
 */
const SYNONYM_BY_STEM = new Map<string, string>();
for (const [word, root] of synonymMap) SYNONYM_BY_STEM.set(stemTerm(word), root);

/**
 * Normalised term sequence: the shared tokeniser rules (letters/digits, length
 * ≥ 3 or a known short term), minus stopwords and bare numbers, then stemmed
 * and mapped to synonym groups. Adjacent words from the same synonym group
 * count once, so "machine learning" is one mention of `ai`, not two.
 * Short terms only count when written in capitals ("US", "AI"), so the pronoun
 * "us" is not read as the country. Lower-casing is locale-independent, so the
 * ranking does not depend on the device language.
 */
function termSequence(text: string, limit: number): string[] {
  const terms: string[] = [];
  let previousSynonym: string | null = null;
  for (const [original] of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const word = original.toLowerCase();
    if (word.length < 3 && !(meaningfulShortTerms.has(word) && original === original.toUpperCase())) continue;
    if (STOPWORDS.has(word) || /^\p{N}+$/u.test(word)) continue;
    const stem = stemTerm(word);
    const synonym = SYNONYM_BY_STEM.get(stem);
    if (synonym !== undefined && synonym === previousSynonym) continue;
    previousSynonym = synonym ?? null;
    terms.push(synonym ?? stem);
    if (terms.length >= limit) break;
  }
  return terms;
}

interface DocumentTerms {
  title: Map<string, number>;
  lead: Map<string, number>;
  leadLength: number;
}

function counts(terms: string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const term of terms) result.set(term, (result.get(term) ?? 0) + 1);
  return result;
}

// Tokenising is the expensive part; cache per source object and revalidate the
// text fields, so a re-rank after a vote does not re-parse every article.
// Votes arrive as new objects after every vote (the list is re-fetched), so
// they are also cached by article id. That cache holds exactly the votes the
// last ranking used (≤ maxExplicitExamples) and is replaced by each ranking.
interface CachedTerms { title: unknown; summary: unknown; content: unknown; terms: DocumentTerms }
const termCache = new WeakMap<object, CachedTerms>();
let voteTermCache = new Map<string, CachedTerms>();
const sameText = (cached: CachedTerms | undefined, title: unknown, summary: unknown, content: unknown): cached is CachedTerms =>
  !!cached && cached.title === title && cached.summary === summary && cached.content === content;

/**
 * One representation for candidates, votes, saved articles and feed metadata:
 * the title plus a lead of the body. The lead is the start of `content`, or the
 * summary when there is no content. Summary is a prefix of content in FriRSS,
 * so using both would count the opening sentences twice.
 */
function documentTerms(source: object, title: unknown, summary: unknown, content: unknown): DocumentTerms {
  return cachedDocumentTerms(source, title, summary, content).terms;
}

/** `previous`: an entry for the same document under another object (a re-fetched vote). */
function cachedDocumentTerms(source: object, title: unknown, summary: unknown, content: unknown, previous?: CachedTerms): CachedTerms {
  const cached = termCache.get(source);
  if (sameText(cached, title, summary, content)) return cached;
  if (sameText(previous, title, summary, content)) {
    termCache.set(source, previous);
    return previous;
  }
  const titleText = typeof title === 'string' && title.trim() !== UNTITLED ? title : '';
  let lead = termSequence(plainText(content), P.leadTokens);
  if (!lead.length) lead = termSequence(plainText(summary), P.leadTokens);
  const terms: DocumentTerms = {
    title: counts(termSequence(plainText(titleText), P.titleTokens)),
    lead: counts(lead),
    leadLength: lead.length,
  };
  const entry = { title, summary, content, terms };
  termCache.set(source, entry);
  return entry;
}

interface Corpus {
  idf: (term: string) => number;
  averageLeadLength: number;
}

/**
 * Statistics come from the candidate articles only — the reader's history is
 * not part of the corpus being ranked. BM25's IDF gives a term found in almost
 * every candidate a weight close to zero, which is enough for feed boilerplate.
 * Common terms are deliberately not cut off: when one topic makes up most of
 * the unread list, its words must still carry a vote against that topic.
 */
function corpusStatistics(documents: DocumentTerms[]): Corpus {
  const df = new Map<string, number>();
  let leadTotal = 0;
  for (const doc of documents) {
    leadTotal += doc.leadLength;
    for (const term of new Set([...doc.title.keys(), ...doc.lead.keys()])) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const n = documents.length;
  return {
    idf: (term) => {
      const frequency = df.get(term) ?? 0;
      return Math.log(1 + (n - frequency + 0.5) / (frequency + 0.5));
    },
    averageLeadLength: leadTotal > 0 ? leadTotal / n : 1,
  };
}

/** Unit-length term vector; empty when nothing meaningful remains. */
type Vector = Map<string, number>;

/** BM25F-style weights: title counts double, the lead is length-normalised, tf saturates. */
function weightVector(doc: DocumentTerms, corpus: Corpus): Vector {
  const lengthNorm = 1 - P.bm25B + P.bm25B * (doc.leadLength / corpus.averageLeadLength);
  const weights: Vector = new Map();
  let squared = 0;
  for (const term of new Set([...doc.title.keys(), ...doc.lead.keys()])) {
    const idf = corpus.idf(term);
    if (idf <= 0) continue;
    const tf = P.titleWeight * (doc.title.get(term) ?? 0) + (doc.lead.get(term) ?? 0) / lengthNorm;
    const weight = ((tf * (P.bm25K1 + 1)) / (tf + P.bm25K1)) * idf;
    weights.set(term, weight);
    squared += weight * weight;
  }
  if (squared > 0) {
    const norm = Math.sqrt(squared);
    for (const [term, weight] of weights) weights.set(term, weight / norm);
  }
  return weights;
}

function dot(a: Map<string, number>, b: Map<string, number>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let sum = 0;
  for (const [term, weight] of small) sum += weight * (large.get(term) ?? 0);
  return sum;
}

function jaccard(a: Map<string, number>, b: Map<string, number>): number {
  let shared = 0;
  for (const term of a.keys()) if (b.has(term)) shared++;
  const union = a.size + b.size - shared;
  return union ? shared / union : 0;
}

/** Combine independent pieces of evidence in [0, 1]: monotone and never above 1. */
function noisyOr(values: number[]): number {
  let miss = 1;
  for (const value of values) miss *= 1 - Math.min(1, Math.max(0, value));
  return 1 - miss;
}

// ── Example evidence (votes and saved articles) ─────────────────────────

type ExampleKind = 0 | 1 | 2; // upvote, downvote, saved
const UPVOTE: ExampleKind = 0;
const DOWNVOTE: ExampleKind = 1;
const SAVED: ExampleKind = 2;

interface Example {
  kind: ExampleKind;
  strength: number;
  articleId: string;
  title: string;
  vector: Vector;
}

interface NearestEvidence {
  values: [number[], number[], number[]];
  best: [EvidenceMatch | null, EvidenceMatch | null, EvidenceMatch | null];
}

/** Inverted index over example vectors, so scoring touches only examples sharing a term. */
function createExampleMatcher(examples: Example[]) {
  const postings = new Map<string, Array<[number, number]>>();
  examples.forEach((example, index) => {
    for (const [term, weight] of example.vector) {
      let list = postings.get(term);
      if (!list) postings.set(term, list = []);
      list.push([index, weight]);
    }
  });
  const accumulator = new Float64Array(examples.length);
  const touched: number[] = [];

  return (vector: Vector): NearestEvidence => {
    for (const [term, weight] of vector) {
      const list = postings.get(term);
      if (!list) continue;
      for (const [index, exampleWeight] of list) {
        if (accumulator[index] === 0) touched.push(index);
        accumulator[index] += weight * exampleWeight;
      }
    }
    const values: NearestEvidence['values'] = [[], [], []];
    const best: NearestEvidence['best'] = [null, null, null];
    const topIndexes: [number[], number[], number[]] = [[], [], []];
    for (const index of touched) {
      const example = examples[index];
      const similarity = Math.min(1, accumulator[index]) * example.strength;
      accumulator[index] = 0;
      if (similarity <= 0) continue;
      const top = values[example.kind];
      const indexes = topIndexes[example.kind];
      // Keep the strongest few, ties resolved by example order (most recent first).
      let position = top.length;
      while (position > 0 && (top[position - 1] < similarity || (top[position - 1] === similarity && indexes[position - 1] > index))) position--;
      if (position < P.nearestExamples) {
        top.splice(position, 0, similarity);
        indexes.splice(position, 0, index);
        if (top.length > P.nearestExamples) { top.pop(); indexes.pop(); }
      }
    }
    touched.length = 0;
    for (const kind of [UPVOTE, DOWNVOTE, SAVED]) {
      const index = topIndexes[kind][0];
      if (index !== undefined) {
        const example = examples[index];
        best[kind] = { articleId: example.articleId, title: example.title, similarity: values[kind][0] };
      }
    }
    return { values, best };
  };
}

// ── Subscription evidence ───────────────────────────────────────────────

interface FeedProfile {
  id: string;
  /** Unit-length sum of the feed's recent article vectors and its metadata vector. */
  unit: Map<string, number>;
}

/**
 * Subscription interest for each candidate, in [0, 1].
 *
 * Every subscribed feed acts as a weak, feed-level positive example: a profile
 * built from its most recent candidate articles plus its title and folder
 * labels (the sole profile while the feed has no articles, so a new
 * subscription counts immediately). A candidate's evidence is the noisy-OR of
 * its similarity to the closest profiles of *other* subscribed feeds — the
 * same aggregation as votes. Its own feed is left out: every candidate comes
 * from a subscribed feed, and resembling one's own feed measures how
 * repetitive the feed is (a deals or job-board feed would vouch for itself),
 * not how interested the reader is. Subscriptions vouch for an article when
 * feeds other than its publisher cover the same subject.
 *
 * One unit profile per feed, however prolific, and only the closest
 * `nearestExamples` feeds count, so a niche topic is not drowned out by a long
 * subscription list. Articles from feeds the reader does not follow get none.
 */
function subscriptionEvidence(
  articles: Article[],
  vectors: Vector[],
  subscriptions: Subscription[] | undefined,
  corpus: Corpus,
): { values: number[]; strongestFeed: Array<string | null> } {
  const values = new Array<number>(articles.length).fill(0);
  const strongestFeed = new Array<string | null>(articles.length).fill(null);
  if (!subscriptions?.length || !articles.length) return { values, strongestFeed };

  const byFeed = new Map<string, number[]>();
  for (const subscription of subscriptions) if (subscription?.id) byFeed.set(subscription.id, []);
  articles.forEach((article, index) => {
    if (vectors[index].size) byFeed.get(article.sourceId)?.push(index);
  });

  const feeds: FeedProfile[] = [];
  const feedIndexById = new Map<string, number>();
  for (const subscription of subscriptions) {
    if (!subscription?.id || feedIndexById.has(subscription.id)) continue;
    const recent = (byFeed.get(subscription.id) ?? [])
      .sort((a, b) => safeTime(articles[b].published) - safeTime(articles[a].published) || a - b)
      .slice(0, P.feedRecentArticles);
    const raw = new Map<string, number>();
    const add = (vector: Vector, weight: number) => {
      for (const [term, value] of vector) raw.set(term, (raw.get(term) ?? 0) + value * weight);
    };
    for (const index of recent) add(vectors[index], 1);
    const categories = (subscription.categories ?? []).map((category) => category?.label ?? '').join(' ');
    add(weightVector(documentTerms(subscription, subscription.title, categories, ''), corpus), P.feedMetadataWeight);
    let squared = 0;
    for (const value of raw.values()) squared += value * value;
    if (squared <= 0) continue;
    const norm = Math.sqrt(squared);
    const unit = new Map<string, number>();
    for (const [term, value] of raw) unit.set(term, value / norm);
    feedIndexById.set(subscription.id, feeds.length);
    feeds.push({ id: subscription.id, unit });
  }
  if (!feeds.length) return { values, strongestFeed };

  const postings = new Map<string, Array<[number, number]>>();
  feeds.forEach((feed, index) => {
    for (const [term, value] of feed.unit) {
      let list = postings.get(term);
      if (!list) postings.set(term, list = []);
      list.push([index, value]);
    }
  });
  const perFeed = new Float64Array(feeds.length);
  const touched: number[] = [];

  articles.forEach((article, index) => {
    const vector = vectors[index];
    if (!byFeed.has(article.sourceId) || !vector.size) return;
    const ownIndex = feedIndexById.get(article.sourceId);
    for (const [term, weight] of vector) {
      for (const [feedIndex, value] of postings.get(term) ?? []) {
        if (perFeed[feedIndex] === 0) touched.push(feedIndex);
        perFeed[feedIndex] += weight * value;
      }
    }
    const top: Array<[similarity: number, feedIndex: number]> = [];
    const consider = (feedIndex: number, similarity: number) => {
      if (!(similarity > 1e-9)) return;
      let position = top.length;
      while (position > 0 && (top[position - 1][0] < similarity
        || (top[position - 1][0] === similarity && top[position - 1][1] > feedIndex))) position--;
      if (position >= P.nearestExamples) return;
      top.splice(position, 0, [similarity, feedIndex]);
      if (top.length > P.nearestExamples) top.pop();
    };
    for (const feedIndex of touched) if (feedIndex !== ownIndex) consider(feedIndex, perFeed[feedIndex]);
    for (const feedIndex of touched) perFeed[feedIndex] = 0;
    touched.length = 0;
    values[index] = noisyOr(top.map(([similarity]) => similarity));
    if (top.length) strongestFeed[index] = feeds[top[0][1]].id;
  });
  return { values, strongestFeed };
}

// ── Scoring and ordering ────────────────────────────────────────────────

function safeTime(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function freshnessOf(published: unknown, now: number): number {
  if (typeof published !== 'number' || !Number.isFinite(published) || !Number.isFinite(now)) return 0;
  const ageHours = Math.max(0, (now - published) / 3_600_000);
  return 1 / (1 + ageHours / P.freshnessHalfLifeHours);
}

function hasReadLater(article: Article): boolean {
  return Array.isArray(article.labels) && article.labels.some((label) => typeof label === 'string'
    && (label === READ_LATER_STREAM || READ_LATER_CATEGORY_PREFIXES.some((prefix) => label.startsWith(prefix))));
}

function savedStrength(starred: boolean, readLater: boolean): number {
  return Math.max(starred ? P.starredStrength : 0, readLater ? P.readLaterStrength : 0);
}

/**
 * Score and order articles, returning the explanation for each in ranked
 * order. `rankIntelligenceNext` is the same ordering without the details.
 */
export function explainIntelligenceNext(
  articles: Article[],
  feedback: ArticleFeedback[],
  now = Date.now(),
  context: IntelligenceContext = {},
): IntelligenceNextExplanation[] {
  if (!articles.length) return [];

  const documents = articles.map((article) => documentTerms(article, article.title, article.summary, article.content));
  const corpus = corpusStatistics(documents);
  const vectors = documents.map((doc) => weightVector(doc, corpus));

  // Explicit votes: one per article (the API returns the newest first), capped.
  const directVotes = new Map<string, 1 | -1>();
  const examples: Example[] = [];
  let explicitCount = 0;
  const usedVoteTerms = new Map<string, CachedTerms>();
  for (const row of Array.isArray(feedback) ? feedback : []) {
    if (!row || !validVote(row.vote)) continue;
    const articleId = typeof row.articleId === 'string' ? row.articleId : '';
    if (articleId) {
      if (directVotes.has(articleId)) continue;
      directVotes.set(articleId, row.vote);
    }
    if (explicitCount >= P.maxExplicitExamples) continue;
    const terms = cachedDocumentTerms(row, row.title, row.summary, row.content, articleId ? voteTermCache.get(articleId) : undefined);
    if (articleId) usedVoteTerms.set(articleId, terms);
    const vector = weightVector(terms.terms, corpus);
    if (!vector.size) continue;
    explicitCount++;
    examples.push({ kind: row.vote === 1 ? UPVOTE : DOWNVOTE, strength: 1, articleId, title: String(row.title ?? ''), vector });
  }
  voteTermCache = usedVoteTerms;

  // Saved articles: live candidate flags win over the snapshot; an explicit
  // vote on the same article replaces the weaker implicit signal.
  const candidateIds = new Set(articles.map((article) => article.id).filter(Boolean));
  const savedSeen = new Set<string>();
  let savedCount = 0;
  const addSaved = (source: object, id: string, title: unknown, summary: unknown, content: unknown, strength: number, vector?: Vector) => {
    if (strength <= 0 || savedCount >= P.maxSavedExamples) return;
    if (id && (directVotes.has(id) || savedSeen.has(id))) return;
    const exampleVector = vector ?? weightVector(documentTerms(source, title, summary, content), corpus);
    if (!exampleVector.size) return;
    if (id) savedSeen.add(id);
    savedCount++;
    examples.push({ kind: SAVED, strength, articleId: id, title: String(title ?? ''), vector: exampleVector });
  };
  articles.forEach((article, index) => {
    addSaved(article, article.id, article.title, article.summary, article.content,
      savedStrength(!!article.starred, hasReadLater(article)), vectors[index]);
  });
  for (const item of context.savedArticles ?? []) {
    if (!item || (item.id && candidateIds.has(item.id))) continue;
    addSaved(item, item.id, item.title, item.summary, item.content, savedStrength(!!item.starred, !!item.readLater));
  }

  const nearest = createExampleMatcher(examples);
  const subscriptions = subscriptionEvidence(articles, vectors, context.subscriptions, corpus);

  const scored = articles.map((article, index) => {
    const evidence = nearest(vectors[index]);
    const directVote = (article.id && directVotes.get(article.id)) || null;
    const upvote = directVote === 1 ? 1 : noisyOr(evidence.values[UPVOTE]);
    const downvote = noisyOr(evidence.values[DOWNVOTE]);
    const saved = noisyOr(evidence.values[SAVED]);
    const subscription = subscriptions.values[index];
    const freshness = freshnessOf(article.published, now);
    // Very short texts match by accident; their positive evidence counts less.
    const confidence = directVote === 1 ? 1 : Math.min(1, vectors[index].size / P.confidenceTerms);
    const positive = confidence * (P.upvoteWeight * upvote + P.savedWeight * saved + P.subscriptionWeight * subscription);
    // A vote on the article itself is decisive: an upvoted article is not
    // pushed down for resembling something else the reader disliked, and a
    // downvoted one goes to the bottom tier whatever else it matches.
    const negative = directVote === 1 ? 0 : P.downvoteWeight * downvote;
    const score = positive * (1 - P.freshnessShare + P.freshnessShare * freshness)
      - negative
      + P.freshnessTieBreak * freshness;
    const tier: IntelligenceNextTier = directVote === -1 ? 'downvoted' : score < 0 ? 'net-negative' : 'normal';
    const explanation: IntelligenceNextExplanation = {
      article,
      tier,
      score: Number.isFinite(score) ? score : 0,
      directVote,
      evidence: { upvote, downvote, saved, subscription, freshness, confidence },
      strongestUpvote: evidence.best[UPVOTE],
      strongestDownvote: evidence.best[DOWNVOTE],
      strongestSaved: evidence.best[SAVED],
      strongestFeedId: subscriptions.strongestFeed[index],
    };
    return { index, explanation };
  });

  type Scored = (typeof scored)[number];
  const byScore = (a: Scored, b: Scored) =>
    b.explanation.score - a.explanation.score
    || safeTime(b.explanation.article.published) - safeTime(a.explanation.article.published)
    || a.index - b.index;
  const tier = (name: IntelligenceNextTier) => scored.filter((item) => item.explanation.tier === name).sort(byScore);
  const normal = tier('normal');

  // Maximal-marginal-relevance pass over the head of the list only: it trades
  // a little relevance for variety (vocabulary, publisher) and pushes near
  // duplicates out of the head. Only non-negative items take part, so
  // diversity can never lift an article the reader voted against.
  const pool = normal.slice(0, P.diversityPool).map((item) => ({ item, maxSimilarity: 0, nearDuplicate: false }));
  const topScore = pool.length ? pool[0].item.explanation.score : 0;
  // A source already in the head costs a fixed, bounded amount — not one step
  // per article shown — so readers whose interests sit in a few feeds still
  // see those feeds' best articles first; `diversifyBy` then breaks up runs.
  const shownSources = new Set<string>();
  const head: Scored[] = [];
  const selections = Math.min(P.diversitySelections, pool.length);
  for (let pick = 0; pick < selections; pick++) {
    let bestIndex = 0;
    let bestValue = -Infinity;
    pool.forEach((entry, index) => {
      const relevance = topScore > 0 ? entry.item.explanation.score / topScore : 0;
      // Penalties scale the article's own relevance (at most by
      // `similarityPenalty + sourcePenalty`), so this pass only reorders
      // articles of comparable relevance; it never lifts a weak match over a
      // much stronger one (`diversifyBy` below may still move one a few places
      // to break a source run). Near duplicates leave the head outright.
      const variety = 1
        - P.similarityPenalty * entry.maxSimilarity
        - (shownSources.has(articleSource(entry.item.explanation.article)) ? P.sourcePenalty : 0);
      const value = relevance * variety - (entry.nearDuplicate ? P.nearDuplicatePenalty : 0);
      if (value > bestValue) { bestValue = value; bestIndex = index; }
    });
    const [{ item: chosen }] = pool.splice(bestIndex, 1);
    head.push(chosen);
    shownSources.add(articleSource(chosen.explanation.article));
    const chosenTitle = documents[chosen.index].title;
    for (const entry of pool) {
      const similarity = dot(vectors[entry.item.index], vectors[chosen.index]);
      entry.maxSimilarity = Math.max(entry.maxSimilarity, similarity);
      const title = documents[entry.item.index].title;
      const sameTitle = title.size >= P.nearDuplicateMinTitleTerms && chosenTitle.size >= P.nearDuplicateMinTitleTerms
        && jaccard(title, chosenTitle) >= P.nearDuplicateTitleJaccard;
      if (similarity >= P.nearDuplicateCosine || sameTitle) entry.nearDuplicate = true;
    }
  }
  const normalOrder = diversifyBy(
    [...head, ...pool.map((entry) => entry.item), ...normal.slice(P.diversityPool)],
    (item) => articleSource(item.explanation.article),
    P.maxSourceRun,
  );

  return [...normalOrder, ...tier('net-negative'), ...tier('downvoted')].map((item) => item.explanation);
}

/** Intelligence Next ordering of the given articles (a permutation of the input). */
export function rankIntelligenceNext(
  articles: Article[],
  feedback: ArticleFeedback[],
  now = Date.now(),
  context: IntelligenceContext = {},
): Article[] {
  return explainIntelligenceNext(articles, feedback, now, context).map((item) => item.article);
}
