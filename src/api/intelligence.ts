import axios from 'axios';
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
}
export type ExternalSignalSource = 'gdelt' | 'github' | 'hackerNews' | 'lobsters';
export interface ExternalArticleSignals {
  gdelt: number | null;
  github: number | null;
  hackerNews: number | null;
  lobsters: number | null;
}
export type ExternalSignalsByUrl = Record<string, ExternalArticleSignals>;

/** Fetch cached server-side external scores for the currently loaded candidates. */
export async function getExternalSignals(
  articles: ExternalSignalArticle[],
  sources: ExternalSignalSource[],
): Promise<ExternalSignalsByUrl> {
  const { data } = await backend.post<{ signals: ExternalSignalsByUrl }>('/external-signals', {
    articles: articles.filter((article) => /^https?:\/\//i.test(article.url)).slice(0, 80).map((article) => ({
      url: article.url,
      title: article.title.slice(0, 2000),
      summary: article.summary.slice(0, 10000),
      content: article.content.slice(0, 12000),
    })),
    sources,
  }, { timeout: 120000 });
  return data.signals ?? {};
}

export type SemanticStatus = 'ok' | 'partial' | 'no-scores' | 'insufficient-feedback' | 'provider-unavailable';
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
