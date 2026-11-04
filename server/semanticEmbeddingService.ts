import db from './db.js';
import { SEMANTIC_PREP_VERSION, unit } from './semanticScoring.js';
import type { EmbeddingProvider } from './semanticEmbeddings.js';

// ═══════════════════════════════════════════════════════════════════════
// Cache-backed embedding service shared by semantic scores and the
// publisher-consensus signal. One table, one in-flight registry, one write
// path — previously this lived inside the intelligence routes and was
// inaccessible to other features.
// ═══════════════════════════════════════════════════════════════════════

db.exec(`
  CREATE TABLE IF NOT EXISTS semantic_embedding_cache (
    cache_key    TEXT    NOT NULL,
    provider     TEXT    NOT NULL,
    model        TEXT    NOT NULL,
    prep_version INTEGER NOT NULL,
    vector_json  TEXT    NOT NULL,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (provider, model, prep_version, cache_key)
  );
  CREATE INDEX IF NOT EXISTS idx_semantic_embedding_cache_updated
    ON semantic_embedding_cache(updated_at);
`);
db.prepare('DELETE FROM semantic_embedding_cache WHERE updated_at < datetime(\'now\', \'-90 days\')').run();

/** One in-flight embedding per cache key across concurrent requests. */
const semanticInFlight = new Map<string, Promise<number[] | null>>();

function semanticIdentity(providerId: string, model: string, key: string): string {
  return providerId + '|' + model + '|' + key;
}

/**
 * Cache-backed embedding lookup for one provider, writing successful vectors
 * through. Bounded and resumable: at most `maxEmbeds` provider lookups per
 * call; jobs beyond that are returned as `notAttempted` so the caller re-asks.
 * Concurrent requests share one in-flight embedding per cache key.
 */
export async function semanticEmbeddingsFor(
  provider: EmbeddingProvider,
  jobs: Array<{ key: string; text: string }>,
  maxEmbeds: number,
): Promise<{ vectors: Array<{ key: string; vector: number[] }>; notAttempted: Set<string>; failures: number }> {
  const vectors: Array<{ key: string; vector: number[] }> = [];
  const uncached: Array<{ key: string; text: string }> = [];
  const read = db.prepare(`SELECT vector_json FROM semantic_embedding_cache
    WHERE provider = ? AND model = ? AND prep_version = ? AND cache_key = ?`);
  for (const job of jobs) {
    const row = read.get(provider.id, provider.model, SEMANTIC_PREP_VERSION, job.key) as { vector_json: string } | undefined;
    if (row) {
      try {
        const vector = JSON.parse(row.vector_json) as unknown;
        // Vectors are stored already unit-normalised; reusing them as-is keeps
        // scores bit-identical between a fresh embed and a cache hit.
        if (Array.isArray(vector) && vector.length && vector.every((value) => typeof value === 'number' && Number.isFinite(value))) {
          vectors.push({ key: job.key, vector: vector as number[] });
          continue;
        }
      } catch { /* corrupt row: treat as a miss and overwrite below */ }
    }
    uncached.push(job);
  }
  const attempted = uncached.slice(0, maxEmbeds);
  const notAttempted = new Set(uncached.slice(maxEmbeds).map((job) => job.key));
  if (!attempted.length) return { vectors, notAttempted, failures: 0 };

  const write = db.prepare(`INSERT INTO semantic_embedding_cache
      (cache_key, provider, model, prep_version, vector_json, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(provider, model, prep_version, cache_key) DO UPDATE SET
      vector_json = excluded.vector_json, updated_at = excluded.updated_at`);

  // Jobs with no in-flight embedding yet are embedded in ONE batched provider
  // call whose result is distributed per key; concurrent requests join it.
  const fresh = attempted.filter((job) => !semanticInFlight.has(semanticIdentity(provider.id, provider.model, job.key)));
  if (fresh.length) {
    const batchPromise = provider.embed(fresh.map((job) => job.text)).then((results) => {
      const byKey = new Map<string, number[] | null>();
      fresh.forEach((job, index) => byKey.set(job.key, results[index] ?? null));
      return byKey;
    }).catch(() => {
      // A failed wave leaves nothing cached: the next request retries.
      const byKey = new Map<string, number[] | null>();
      for (const job of fresh) byKey.set(job.key, null);
      return byKey;
    }).finally(() => {
      for (const job of fresh) semanticInFlight.delete(semanticIdentity(provider.id, provider.model, job.key));
    });
    for (const job of fresh) {
      semanticInFlight.set(
        semanticIdentity(provider.id, provider.model, job.key),
        batchPromise.then((byKey) => byKey.get(job.key) ?? null),
      );
    }
  }

  const settled = await Promise.all(attempted.map(async (job) => ({
    key: job.key,
    vector: await (semanticInFlight.get(semanticIdentity(provider.id, provider.model, job.key)) ?? Promise.resolve<number[] | null>(null)),
  })));
  let failures = 0;
  for (const entry of settled) {
    if (!entry.vector) { failures++; continue; }
    const normalized = unit(entry.vector);
    write.run(entry.key, provider.id, provider.model, SEMANTIC_PREP_VERSION, JSON.stringify(normalized));
    vectors.push({ key: entry.key, vector: normalized });
  }
  return { vectors, notAttempted, failures };
}
