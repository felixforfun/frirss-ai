export interface ArticleOpenEvent {
  articleId: string;
  openedAt: number;
  title: string;
  text: string;
  wordCount: number;
}

const STORAGE_PREFIX = 'frirss_reading_stats_v1:';
const MAX_EVENTS = 1000;
const SKIM_FACTOR = 0.6;
const WORDS_PER_MINUTE = 230;

function storageKey(serverId: string | number | null | undefined): string {
  return STORAGE_PREFIX + String(serverId ?? 'default');
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function plainText(value: string): string {
  return (value || '')
    .replace(/<script\\b[^>]*>[\\s\\S]*?<\\/script>/gi, ' ')
    .replace(/<style\\b[^>]*>[\\s\\S]*?<\\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\\s+/g, ' ')
    .trim();
}

export function recordArticleOpen(
  serverId: string | number | null | undefined,
  article: { id: string; title?: string; content?: string; summary?: string },
): void {
  if (typeof window === 'undefined' || !article?.id) return;
  try {
    const key = storageKey(serverId);
    const raw = window.localStorage.getItem(key);
    const events: ArticleOpenEvent[] = raw ? JSON.parse(raw) : [];
    const title = plainText(article.title || '').slice(0, 300);
    const body = plainText(article.content || article.summary || '');
    const topicText = [title, plainText(article.summary || ''), body.slice(0, 900)].filter(Boolean).join(' ').slice(0, 1500);
    const event: ArticleOpenEvent = {
      articleId: String(article.id),
      openedAt: Date.now(),
      title,
      text: topicText,
      wordCount: countWords(body || title),
    };
    events.push(event);
    window.localStorage.setItem(key, JSON.stringify(events.slice(-MAX_EVENTS)));
    window.dispatchEvent(new CustomEvent('frirss:reading-stats-updated'));
  } catch {
    // Stats are best-effort and must never interfere with opening an article.
  }
}

export function getArticleOpenEvents(serverId: string | number | null | undefined): ArticleOpenEvent[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(storageKey(serverId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is ArticleOpenEvent =>
      !!e && typeof e.articleId === 'string' && typeof e.openedAt === 'number'
      && typeof e.title === 'string' && typeof e.text === 'string' && typeof e.wordCount === 'number'
    );
  } catch {
    return [];
  }
}

export function estimatedSkimMinutes(wordCount: number): number {
  return Math.max(1, Math.round((Math.max(0, wordCount) / WORDS_PER_MINUTE) * SKIM_FACTOR));
}
