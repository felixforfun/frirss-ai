import backend from './backend';

/**
 * Client for the publisher preview endpoints. Requests are authenticated
 * with the FriRSS JWT; the backend applies the SSRF guard and network bounds.
 */

export interface PreviewArticle {
  id: string;
  title: string;
  url: string;
  published: number | null;
  /** HTML fourni par le fil — assainir avec `sanitizeHtml` avant rendu. */
  summary: string;
  author: string;
}

export interface PreviewFeed {
  kind: 'rss' | 'atom';
  title: string;
  siteUrl: string;
  feedUrl: string;
  selfUrl: string;
  iconUrl: string;
  description: string;
}

export interface PublisherPreviewResponse {
  feed: PreviewFeed;
  articles: PreviewArticle[];
}

export interface DiscoveredLink { href: string; type: string; title: string }

export async function fetchPublisherPreview(feedUrl: string): Promise<PublisherPreviewResponse> {
  const { data } = await backend.get<PublisherPreviewResponse>('/publisher/preview', {
    params: { feedUrl },
    timeout: 15_000,
  });
  return data;
}

/**
 * Discovers the feeds declared by the publisher site. Returns the raw list —
 * the store decides (one candidate → preview; several → choice).
 */
export async function discoverPublisherFeed(siteUrl: string): Promise<DiscoveredLink[]> {
  const { data } = await backend.get<{ links: DiscoveredLink[] }>('/publisher/discover', {
    params: { siteUrl },
    timeout: 15_000,
  });
  return data.links ?? [];
}
