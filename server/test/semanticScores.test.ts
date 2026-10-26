import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createHash } from 'node:crypto';

// OLLAMA_URL and PROXY_INTERNAL_HOSTS are read once, at module load of the
// proxy and the semantic route, so they must exist before any import below.
vi.hoisted(() => {
  process.env.OLLAMA_URL = 'http://127.0.0.1:11434';
  process.env.OLLAMA_EMBED_MODEL = 'bge-m3';
  // The private loopback host is only fetchable when explicitly trusted.
  process.env.PROXY_INTERNAL_HOSTS = '127.0.0.1';
});

import app from '../index.js';
import db from '../db.js';

interface RecordedEmbed {
  url: string;
  input: string[];
}
/** Every /api/embed call the provider module made, in order. */
const embedCalls: RecordedEmbed[] = [];
let embedMode: 'ok' | 'fail' = 'ok';
/** Artificial provider latency so a second request can join an open wave. */
let embedDelayMs = 0;

/** Deterministic text-derived vector so scores are reproducible across requests. */
function vectorFor(text: string, dim = 8): number[] {
  const vector = new Array<number>(dim).fill(0);
  for (let index = 0; index < text.length; index++) vector[index % dim] += (text.charCodeAt(index) % 13) - 6;
  return vector;
}

const fetchMock = vi.fn(async (input: unknown, init?: { body?: string }) => {
  const url = String(input);
  const body = JSON.parse(init?.body ?? '{}') as { input?: string[] };
  if (url.includes('/api/embed')) {
    embedCalls.push({ url, input: body.input ?? [] });
    if (embedDelayMs) await new Promise((resolve) => setTimeout(resolve, embedDelayMs));
    if (embedMode === 'fail') return new Response('embed worker died', { status: 500 });
    return new Response(JSON.stringify({ embeddings: (body.input ?? []).map((text) => vectorFor(text)) }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response('not found', { status: 404 });
});
vi.stubGlobal('fetch', fetchMock);

let adminToken = '';
let userAToken = '';
let userBToken = '';
const userTokens = new Map<string, string>();

async function bootstrapUsers(): Promise<void> {
  // First account self-registers (becomes admin); everyone else is created
  // through the admin API and logs in, mirroring api.test.ts.
  const registration = await request(app).post('/api/auth/register')
    .send({ username: 'semantic-admin', password: 'secret123', email: 'admin@example.test' });
  expect(registration.status).toBe(201);
  adminToken = registration.body.token as string;
  for (const suffix of ['a', 'b', 'c', 'd', 'e']) {
    const username = 'semantic-user-' + suffix;
    const created = await request(app).post('/api/admin/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ username, password: 'secret123', email: `${username}@example.test`, role: 'user' });
    expect(created.status).toBe(201);
    const login = await request(app).post('/api/auth/login').send({ username, password: 'secret123' });
    expect(login.status).toBe(200);
    userTokens.set(suffix, login.body.token as string);
  }
}

function tokenFor(suffix: string): string {
  return userTokens.get(suffix) as string;
}

function putFeedback(token: string, article: { id: string; url: string; title: string; summary?: string; content?: string; vote: 1 | -1 }) {
  return request(app).put('/api/intelligence/feedback').set('Authorization', `Bearer ${token}`).send({
    articleId: article.id,
    url: article.url,
    title: article.title,
    summary: article.summary ?? '',
    content: article.content ?? '',
    sourceId: 'feed/1',
    vote: article.vote,
  });
}

function postScores(token: string, articles: Array<{ url: string; title: string; summary: string }>) {
  return request(app).post('/api/intelligence/semantic-scores').set('Authorization', `Bearer ${token}`).send({ articles });
}

const UP_A = { id: 'up-a1', url: 'https://example.test/a/up1', title: 'Transformer architecture advances', summary: 'Attention layers improve reasoning benchmarks' };
const UP_A2 = { id: 'up-a2', url: 'https://example.test/a/up2', title: 'New inference chip accelerates AI workloads', summary: 'Silicon optimised for transformer inference' };
const DOWN_A = { id: 'down-a1', url: 'https://example.test/a/down1', title: 'Celebrity wedding photos', summary: 'A glamorous ceremony by the sea' };
const CANDIDATES_A = [
  { url: 'https://example.test/a/c1', title: 'Scaling laws for large language models', summary: 'Compute-optimal training results' },
  { url: 'https://example.test/a/c2', title: 'Tabloid drama at the awards show', summary: 'Red carpet feuds and gossip' },
  { url: 'https://example.test/a/c3', title: 'Quantised inference on consumer GPUs', summary: 'Running models locally' },
  { url: 'https://example.test/a/c4', title: 'Reality TV season finale ratings', summary: 'Who won the audience vote' },
];

beforeAll(async () => {
  await bootstrapUsers();
  userAToken = tokenFor('a');
  userBToken = tokenFor('b');
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/intelligence/semantic-scores', () => {
  it('rejects unauthenticated requests', async () => {
    const response = await request(app).post('/api/intelligence/semantic-scores').send({ articles: CANDIDATES_A });
    expect(response.status).toBe(401);
  });

  it('rejects invalid payloads', async () => {
    expect((await postScores(userAToken, [])).status).toBe(400);
    const tooMany = Array.from({ length: 301 }, (_, index) => ({ url: `https://example.test/x/${index}`, title: 't', summary: 's' }));
    expect((await postScores(userAToken, tooMany)).status).toBe(400);
    expect((await postScores(userAToken, [{ url: 'ftp://example.test/x', title: 't', summary: 's' }])).status).toBe(400);
    expect((await postScores(userAToken, [{ url: 'https://example.test/x', title: 42 as unknown as string, summary: 's' }])).status).toBe(400);
    expect((await postScores(userAToken, [{ url: `https://example.test/x/${'u'.repeat(4096)}`, title: 't', summary: 's' }])).status).toBe(400);
  });

  it('reports provider-unavailable when no provider is configured', async () => {
    const url = process.env.OLLAMA_URL;
    delete process.env.OLLAMA_URL;
    try {
      const response = await postScores(userAToken, CANDIDATES_A.slice(0, 1));
      expect(response.status).toBe(200);
      expect(response.body.status).toBe('provider-unavailable');
      expect(response.body.provider).toBeNull();
      expect(response.body.scores).toEqual({});
    } finally {
      process.env.OLLAMA_URL = url;
    }
  });

  it('reports insufficient-feedback with only one class voted', async () => {
    await putFeedback(userAToken, { ...UP_A, vote: 1 });
    const response = await postScores(userAToken, CANDIDATES_A.slice(0, 2));
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('insufficient-feedback');
    expect(response.body.scores).toEqual({});
  });

  it('scores candidates, caches embeddings, and reuses the cache on the next request', async () => {
    await putFeedback(userAToken, { ...UP_A2, vote: 1 });
    await putFeedback(userAToken, { ...DOWN_A, vote: -1 });
    const callsBefore = embedCalls.length;
    const first = await postScores(userAToken, CANDIDATES_A);
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('ok');
    expect(first.body.provider).toBe('ollama');
    expect(first.body.missing).toEqual([]);
    expect(Object.keys(first.body.scores)).toHaveLength(4);
    for (const value of Object.values(first.body.scores)) expect(Number.isFinite(value)).toBe(true);

    // References (2 new) + candidates (4): two batched provider waves, not six calls.
    const newCalls = embedCalls.slice(callsBefore);
    expect(newCalls).toHaveLength(2);
    const embeddedTexts = newCalls.flatMap((call) => call.input);
    expect(embeddedTexts.some((text) => text.includes('New inference chip accelerates'))).toBe(true);
    expect(embeddedTexts.some((text) => text.includes('Celebrity wedding photos'))).toBe(true);

    const rows = db.prepare('SELECT COUNT(*) AS count FROM semantic_embedding_cache').get() as { count: number };
    expect(rows.count).toBeGreaterThanOrEqual(7);

    const callsBeforeSecond = embedCalls.length;
    const second = await postScores(userAToken, CANDIDATES_A);
    expect(second.body.scores).toEqual(first.body.scores);
    expect(embedCalls.slice(callsBeforeSecond)).toHaveLength(0); // fully served from cache
  });

  it('never mixes feedback across accounts', async () => {
    const UP_B = { id: 'up-b1', url: 'https://example.test/b/up1', title: 'Home espresso brewing guide', summary: 'Dialling in the grinder' };
    const DOWN_B = { id: 'down-b1', url: 'https://example.test/b/down1', title: 'Cryptocurrency pump schemes', summary: 'Anonymous coins and hype' };
    await putFeedback(userBToken, { ...UP_B, vote: 1 });
    await putFeedback(userBToken, { ...DOWN_B, vote: -1 });
    const callsBefore = embedCalls.length;
    const response = await postScores(userBToken, CANDIDATES_A);
    expect(response.body.status).toBe('ok');
    const newCalls = embedCalls.slice(callsBefore);
    // Only user B's references may be embedded for user B's request.
    const embeddedTexts = newCalls.flatMap((call) => call.input);
    expect(embeddedTexts.some((text) => text.includes('Home espresso brewing guide'))).toBe(true);
    expect(embeddedTexts.some((text) => text.includes('Transformer architecture advances'))).toBe(false);
    expect(embeddedTexts.some((text) => text.includes('Celebrity wedding photos'))).toBe(false);
    // Different references must produce different scores for the same articles.
    const aScores = (await postScores(userAToken, CANDIDATES_A)).body.scores as Record<string, number>;
    expect(response.body.scores).not.toEqual(aScores);
  });

  it('falls back to stored content when a feedback row has no summary', async () => {
    const token = tokenFor('c');
    await putFeedback(token, { id: 'up-c1', url: 'https://example.test/c/up1', title: 'Teardown findings', summary: '', content: 'gadget teardown internals revealed', vote: 1 });
    await putFeedback(token, { id: 'down-c1', url: 'https://example.test/c/down1', title: 'Infomercial roundup', summary: 'As-seen-on-TV gadgets', vote: -1 });
    const callsBefore = embedCalls.length;
    const response = await postScores(token, [{ url: 'https://example.test/c/cand1', title: 'Inside the new gadget', summary: 'A detailed teardown' }]);
    expect(response.body.status).toBe('ok');
    const embeddedTexts = embedCalls.slice(callsBefore).flatMap((call) => call.input);
    expect(embeddedTexts.some((text) => text.includes('gadget teardown internals revealed'))).toBe(true);
  });

  it('keeps nothing cached on provider failure and recovers on retry', async () => {
    const token = tokenFor('d');
    await putFeedback(token, { id: 'up-d1', url: 'https://example.test/d/up1', title: 'Vintage synthesizer restoration', summary: 'Recapping a Juno 106', vote: 1 });
    await putFeedback(token, { id: 'down-d1', url: 'https://example.test/d/down1', title: 'Lawn care sponsor segments', summary: 'Fertilizer spreader reviews', vote: -1 });
    const cold = [
      { url: 'https://example.test/d/cand1', title: 'Analog filter design deep dive', summary: 'Resonance and envelopes' },
      { url: 'https://example.test/d/cand2', title: 'Mulching blades compared', summary: 'The best mower attachments' },
    ];
    const keyOf = (text: string): string => {
      // The audited key formula, for counting cache rows directly.
      return createHash('sha256').update('bge-m3\0summary\0' + text).digest('hex');
    };
    const countRows = (keys: string[]): number => {
      const statement = db.prepare(`SELECT COUNT(*) AS count FROM semantic_embedding_cache
        WHERE provider = 'ollama' AND model = 'bge-m3' AND cache_key IN (${keys.map(() => '?').join(',')})`);
      return (statement.get(...keys) as { count: number }).count;
    };

    embedMode = 'fail';
    try {
      const failed = await postScores(token, cold);
      expect(failed.status).toBe(200);
      expect(failed.body.status).toBe('no-scores');
      expect(failed.body.scores).toEqual({});
      expect(failed.body.missing).toEqual([]);
      expect(countRows([keyOf('Analog filter design deep dive\nResonance and envelopes'), keyOf('Mulching blades compared\nThe best mower attachments')])).toBe(0);
    } finally {
      embedMode = 'ok';
    }
    const recovered = await postScores(token, cold);
    expect(recovered.body.status).toBe('ok');
    expect(Object.keys(recovered.body.scores)).toHaveLength(2);
  });

  it('serves two concurrent cold requests with a single embedding wave per text', async () => {
    const token = tokenFor('e');
    await putFeedback(token, { id: 'up-e1', url: 'https://example.test/e/up1', title: 'Sourdough starter maintenance', summary: 'Feeding schedules and hydration', vote: 1 });
    await putFeedback(token, { id: 'down-e1', url: 'https://example.test/e/down1', title: 'Multi-level marketing pitches', summary: 'Recruiting friends for profit', vote: -1 });
    const cold = [
      { url: 'https://example.test/e/cand1', title: 'Levain chemistry explained', summary: 'Wild yeast and bacteria balance' },
      { url: 'https://example.test/e/cand2', title: 'Pyramid scheme anatomy', summary: 'Why recruits always lose' },
    ];
    const candidateCallBodies = () => embedCalls.filter((call) => call.input.some((text) => text.includes('Levain chemistry explained')));
    const candidatesBefore = candidateCallBodies().length;
    embedDelayMs = 80; // keep the first wave open until the second request joins it
    try {
      const [first, second] = await Promise.all([postScores(token, cold), postScores(token, cold)]);
      expect(first.body.status).toBe('ok');
      expect(second.body.status).toBe('ok');
      expect(first.body.scores).toEqual(second.body.scores);
      // Both candidate texts travel in one wave, shared by both requests.
      const candidateWaves = candidateCallBodies().length - candidatesBefore;
      expect(candidateWaves).toBe(1);
    } finally {
      embedDelayMs = 0;
    }
  });
});
