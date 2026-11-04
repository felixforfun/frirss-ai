import axios from 'axios';
import type { ExternalEvidenceState as ExternalSignalState, ExternalSignalSource } from '../lib/intelligenceRanking';
import { useAuthStore } from '../stores/authStore';

const backend = axios.create({ baseURL: '/api/intelligence', headers: { 'Content-Type': 'application/json' } });
backend.interceptors.request.use((config) => {
  const token = useAuthStore.getState().backendToken;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

export interface ArticleFeedback {
  articleId: string;
  url: string;
  title: string;
  summary: string;
  content: string;
  sourceId: string;
  vote: 1 | -1;
  createdAt?: string;
  updatedAt?: string;
}

export async function getArticleFeedback(): Promise<ArticleFeedback[]> {
  const { data } = await backend.get<{ feedback: ArticleFeedback[] }>('/feedback');
  return data.feedback;
}

export async function setArticleFeedback(
  feedback: Omit<ArticleFeedback, 'createdAt' | 'updatedAt'>,
): Promise<void> {
  await backend.put('/feedback', feedback);
}

export async function removeArticleFeedback(articleId: string): Promise<void> {
  await backend.delete(`/feedback/${encodeURIComponent(articleId)}`);
}

export interface ExternalSignalArticle {
  url: string;
  title: string;
  summary: string;
  content: string;
  /** Unix ms, when known: recency priority for rate-limited providers. */
  published?: number;
}
// One shared source/evidence vocabulary with the ranking library, so the
// wire types and the blend can never drift apart.
export type { ExternalSignalState, ExternalSignalSource };

/** Contract v2: exactly one state per (article, source). */
export interface ExternalSignalStateEntry {
  state: ExternalSignalState;
  value?: number;
  retryAfterMs?: number;
}
export type ExternalSignalsV2 = Record<string, Partial<Record<ExternalSignalSource, ExternalSignalStateEntry>>>;

/** Legacy v1 shape: four numeric-or-null slots per article. */
export interface ExternalArticleSignals {
  gdelt: number | null;
  github: number | null;
  hackerNews: number | null;
  lobsters: number | null;
}
export type ExternalSignalsByUrl = Record<string, ExternalArticleSignals>;

export interface ExternalSignalsResponse {
  version: 1 | 2;
  /** v2: state entries. v1: legacy numeric-or-null slots (converted by the caller). */
  signals: ExternalSignalsV2 | ExternalSignalsByUrl;
  pending: string[];
  fetchedAt: number;
}

/**
 * Contract v2 request: the server answers immediately with cached evidence
 * and queues the rest; `pending` lists urls that still need a poll. With an
 * older server (v1) the same call resolves synchronously — the response then
 * lacks `version`, and the caller converts the legacy slots.
 */
export async function getExternalSignals(
  articles: ExternalSignalArticle[],
  sources: ExternalSignalSource[],
  abortSignal?: AbortSignal,
): Promise<ExternalSignalsResponse> {
  const { data } = await backend.post<{ version?: number; signals?: ExternalSignalsV2 | ExternalSignalsByUrl; pending?: string[] }>('/external-signals', {
    version: 2,
    articles: articles.filter((article) => /^https?:\/\//i.test(article.url)).slice(0, 300).map((article) => ({
      url: article.url,
      title: article.title.slice(0, 2000),
      summary: article.summary.slice(0, 10000),
      content: article.content.slice(0, 12000),
      published: article.published,
    })),
    sources,
  }, { timeout: 30000, signal: abortSignal });
  const version = data.version === 2 ? 2 : 1;
  return {
    version,
    signals: data.signals ?? {},
    pending: data.pending ?? [],
    fetchedAt: Date.now(),
  };
}

/** One coverage entry per article url (publisher-consensus signal). */
export interface CoverageEntry {
  origins: number;
  publishers: string[];
  clusterId: string;
}
export type CoverageResponse = {
  status: 'ok' | 'partial' | 'provider-unavailable';
  coverage: Record<string, CoverageEntry>;
  missing: string[];
  provider: 'openrouter' | 'ollama' | null;
};

/**
 * Publisher-consensus coverage for the current candidates. The server embeds
 * missing vectors in bounded batches and reports the rest as `missing`, so the
 * caller polls while batches progress (same pattern as semantic scores).
 */
export async function getCoverage(
  articles: Array<{ url: string; title: string; summary: string; publisher: string; published: number }>,
  abortSignal?: AbortSignal,
): Promise<CoverageResponse> {
  const { data } = await backend.post<CoverageResponse>('/coverage', {
    articles: articles.filter((article) => /^https?:\/\//i.test(article.url)).slice(0, 300).map((article) => ({
      url: article.url,
      title: article.title.slice(0, 2000),
      summary: article.summary.slice(0, 10000),
      publisher: article.publisher.slice(0, 512),
      published: article.published,
    })),
  }, { timeout: 30000, signal: abortSignal });
  return {
    status: data.status,
    coverage: data.coverage ?? {},
    missing: data.missing ?? [],
    provider: data.provider ?? null,
  };
}

export type SemanticStatus = 'ok' | 'partial' | 'no-scores' | 'insufficient-feedback' | 'provider-unavailable' | 'reference-unavailable';
export interface SemanticScoresResponse {
  status: SemanticStatus;
  scores: Record<string, number>;
  missing: string[];
  provider: 'openrouter' | 'ollama' | null;
}
export interface SemanticScoreArticle {
  url: string;
  title: string;
  summary: string;
}

/**
 * Fetch server-computed semantic scores (soft balanced margin against the
 * reader's feedback) for the given candidates. The server returns only the
 * articles it could score; `missing` lists the rest so the caller can poll
 * again while the bounded embedding batches make progress.
 */
export async function getSemanticScores(
  articles: SemanticScoreArticle[],
): Promise<SemanticScoresResponse> {
  const { data } = await backend.post<SemanticScoresResponse>('/semantic-scores', {
    articles: articles.filter((article) => /^https?:\/\//i.test(article.url)).slice(0, 300).map((article) => ({
      url: article.url,
      title: article.title.slice(0, 2000),
      summary: article.summary.slice(0, 10000),
    })),
  }, { timeout: 120000 });
  return {
    status: data.status,
    scores: data.scores ?? {},
    missing: data.missing ?? [],
    provider: data.provider ?? null,
  };
}
