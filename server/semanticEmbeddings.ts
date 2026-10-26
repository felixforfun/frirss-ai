import { fetchUpstream } from './routes/proxy.js';

/**
 * Embedding providers for semantic ranking.
 *
 * OpenRouter is the preferred provider (the local Ollama instance on the
 * target deployment is CPU-only and far too slow for a cold cache). Both
 * providers go through `fetchUpstream`, so FriRSS's outbound network policy
 * (DNS-resolved SSRF guard) applies; `openrouter.ai` is a public host and
 * passes without extra configuration, while a private Ollama host must be
 * listed in `PROXY_INTERNAL_HOSTS`.
 *
 * Configuration (server environment only — never accepted from clients):
 *   OPENROUTER_API_KEY       bearer token for the embeddings API
 *   OPENROUTER_EMBED_MODEL   default `baai/bge-m3` (1024 dims, verified live)
 *   OPENROUTER_BASE_URL      default `https://openrouter.ai/api/v1`
 *   OLLAMA_URL               e.g. `http://ollama:11434` — optional fallback
 *   OLLAMA_EMBED_MODEL       default `bge-m3`
 */

export interface EmbeddingProvider {
  /** Stable provider identity — part of the cache row identity. */
  readonly id: 'openrouter' | 'ollama';
  /** Model identifier exactly as the provider API expects it. */
  readonly model: string;
  /** Embed a batch of pre-cleaned texts; returns one finite vector per input. */
  embed(texts: string[]): Promise<number[][]>;
}

const OPENROUTER_TIMEOUT_MS = 60_000;
const OLLAMA_TIMEOUT_MS = 60_000;
/** Bounded sub-batches keep every HTTP request fast and individually retryable. */
const MAX_BATCH = 32;

function splitIntoBatches<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) batches.push(items.slice(index, index + size));
  return batches;
}

function assertFiniteVectors(vectors: unknown, count: number, provider: string): number[][] {
  if (!Array.isArray(vectors) || vectors.length !== count) {
    throw Object.assign(new Error(provider + ' returned an incomplete batch'), { status: 502 });
  }
  for (const vector of vectors) {
    if (!Array.isArray(vector) || !vector.length
      || (vector as unknown[]).some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
      throw Object.assign(new Error(provider + ' returned a malformed vector'), { status: 502 });
    }
  }
  return vectors as number[][];
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> {
  const response = await fetchUpstream(url, {
    method: 'POST',
    followRedirects: false,
    timeoutMs,
    headers,
    body: JSON.stringify(body),
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    throw Object.assign(new Error('Embedding provider redirects are not supported'), { status: 502 });
  }
  return {
    ok: response.ok,
    status: response.status,
    json: () => {
      if (!response.body) return Promise.resolve(null);
      return response.json();
    },
  };
}

function createOpenRouterProvider(apiKey: string, model: string, baseUrl: string): EmbeddingProvider {
  return {
    id: 'openrouter',
    model,
    async embed(texts: string[]): Promise<number[][]> {
      const vectors: number[][] = [];
      for (const batch of splitIntoBatches(texts, MAX_BATCH)) {
        let response: Awaited<ReturnType<typeof postJson>>;
        try {
          response = await postJson(
            baseUrl.replace(/\/+$/, '') + '/embeddings',
            { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
            { model, input: batch },
            OPENROUTER_TIMEOUT_MS,
          );
        } catch (error) {
          if ((error as { status?: number }).status) throw error;
          throw Object.assign(new Error('Embedding provider is unreachable'), { status: 502, cause: error });
        }
        if (!response.ok) {
          await response.json().catch(() => null); // drain
          if (response.status === 401 || response.status === 403) {
            throw Object.assign(new Error('Embedding provider rejected the API key'), { status: 500, providerStatus: response.status });
          }
          if (response.status === 429) {
            throw Object.assign(new Error('Embedding provider rate limit reached'), { status: 503, providerStatus: response.status });
          }
          throw Object.assign(new Error('Embedding provider request failed'), { status: 502, providerStatus: response.status });
        }
        const payload = await response.json() as { data?: Array<{ embedding?: unknown }> } | null;
        const data = payload?.data;
        if (!Array.isArray(data) || data.length !== batch.length) {
          throw Object.assign(new Error('Embedding provider returned an incomplete batch'), { status: 502 });
        }
        for (const item of data) vectors.push(...assertFiniteVectors([item?.embedding], 1, 'Embedding provider'));
      }
      return vectors;
    },
  };
}

function createOllamaProvider(url: string, model: string): EmbeddingProvider {
  return {
    id: 'ollama',
    model,
    async embed(texts: string[]): Promise<number[][]> {
      const vectors: number[][] = [];
      for (const batch of splitIntoBatches(texts, MAX_BATCH)) {
        let response: Awaited<ReturnType<typeof postJson>>;
        try {
          response = await postJson(
            url.replace(/\/+$/, '') + '/api/embed',
            { 'Content-Type': 'application/json' },
            { model, input: batch, truncate: true },
            OLLAMA_TIMEOUT_MS,
          );
        } catch (error) {
          if ((error as { status?: number }).status) throw error;
          throw Object.assign(new Error('Ollama is unreachable'), { status: 502, cause: error });
        }
        if (!response.ok) {
          await response.json().catch(() => null); // drain
          throw Object.assign(new Error('Ollama embedding request failed'), { status: 502, providerStatus: response.status });
        }
        const payload = await response.json() as { embeddings?: unknown } | null;
        vectors.push(...assertFiniteVectors(payload?.embeddings, batch.length, 'Ollama'));
      }
      return vectors;
    },
  };
}

/**
 * The configured provider, or `null` when none is usable. OpenRouter wins
 * when its key is present; Ollama is the fallback.
 */
export function resolveEmbeddingProvider(): EmbeddingProvider | null {
  const openrouterKey = process.env.OPENROUTER_API_KEY?.trim();
  if (openrouterKey) {
    return createOpenRouterProvider(
      openrouterKey,
      process.env.OPENROUTER_EMBED_MODEL?.trim() || 'baai/bge-m3',
      process.env.OPENROUTER_BASE_URL?.trim() || 'https://openrouter.ai/api/v1',
    );
  }
  const ollamaUrl = process.env.OLLAMA_URL?.trim();
  if (ollamaUrl) {
    return createOllamaProvider(ollamaUrl, process.env.OLLAMA_EMBED_MODEL?.trim() || 'bge-m3');
  }
  return null;
}
