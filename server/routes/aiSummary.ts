import { Router } from 'express';
import db from '../db.js';
import { decrypt, encrypt } from '../crypto.js';
import { requireAuth } from '../middleware/auth.js';
import { fetchUpstream, proxyRateLimiter } from './proxy.js';
import { aiConfigHash, aiContentHash, cleanArticleHtml, normalizeAiEndpoint, MAX_ARTICLE_TEXT_CHARS } from '../aiSummaryUtils.js';

const router = Router();
router.use(requireAuth);
if (proxyRateLimiter) router.use(proxyRateLimiter);

const DEFAULT_ENDPOINT = 'https://openrouter.ai/api/v1';
const DEFAULT_PROMPT = "Summarize this article in 3–5 concise bullet points. Focus on facts, important numbers and implications. Do not add information not present in the article.";
const MAX_PROMPT_CHARS = 4000;
const MAX_KEY_CHARS = 4096;
const MAX_ARTICLE_HTML_CHARS = 1_000_000;
const REQUEST_TIMEOUT_MS = 60_000;
const TEMPERATURE = 0.2;
const inFlightSummaries = new Map<string, Promise<string>>();

interface ConfigRow { enabled: number; endpoint: string; model: string; prompt: string; api_key: string | null; }
function readConfig(userId: number): ConfigRow {
  const row = db.prepare('SELECT enabled, endpoint, model, prompt, api_key FROM ai_summary_configs WHERE user_id = ?').get(userId) as ConfigRow | undefined;
  return row ?? { enabled: 0, endpoint: DEFAULT_ENDPOINT, model: '', prompt: DEFAULT_PROMPT, api_key: null };
}
function publicConfig(row: ConfigRow) {
  return { enabled: Boolean(row.enabled), endpoint: row.endpoint, model: row.model, prompt: row.prompt, hasApiKey: Boolean(row.api_key) };
}
function validString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength;
}
function completionUrl(endpoint: string): string {
  return endpoint.endsWith('/chat/completions') ? endpoint : endpoint + '/chat/completions';
}
async function providerRequest(endpoint: string, apiKey: string, body: Record<string, unknown>) {
  const url = completionUrl(endpoint);
  // Reuse FriRSS's DNS-resolving SSRF guard and redirect handling. Redirects
  // stay disabled so an upstream cannot receive the bearer token elsewhere.
  const response = await fetchUpstream(url, {
    method: 'POST',
    followRedirects: false,
    timeoutMs: REQUEST_TIMEOUT_MS,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    throw Object.assign(new Error('AI endpoint redirects are not supported'), { status: 502 });
  }
  let responseText = '';
  if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      reader.cancel().catch(() => {});
    }, REQUEST_TIMEOUT_MS);
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1_000_000) {
          await reader.cancel().catch(() => {});
          throw Object.assign(new Error('AI provider response too large'), { status: 502 });
        }
        responseText += decoder.decode(value, { stream: true });
      }
      responseText += decoder.decode();
      if (timedOut) throw Object.assign(new Error('AI provider timed out'), { name: 'TimeoutError' });
    } catch (err) {
      if (timedOut) throw Object.assign(new Error('AI provider timed out'), { name: 'TimeoutError' });
      throw err;
    } finally {
      clearTimeout(timer);
      reader.releaseLock();
    }
  }
  let json: unknown;
  try { json = JSON.parse(responseText); } catch { json = null; }
  if (!response.ok) {
    const status = response.status === 401 || response.status === 403 ? 400 : response.status === 429 ? 429 : 502;
    throw Object.assign(new Error(response.status === 401 || response.status === 403 ? 'AI provider rejected the API key' : response.status === 429 ? 'AI provider rate limit reached' : 'AI provider request failed'), { status });
  }
  if (!json || typeof json !== 'object') throw Object.assign(new Error('Invalid AI provider response'), { status: 502 });
  return json as { choices?: Array<{ message?: { content?: unknown } }> };
}
function providerError(err: unknown): { status: number; message: string } {
  const candidate = err as { status?: number; name?: string; message?: string };
  if (candidate?.name === 'TimeoutError' || candidate?.name === 'AbortError') return { status: 504, message: 'AI provider timed out' };
  if (candidate?.status) return { status: candidate.status, message: candidate.message || 'AI provider request failed' };
  return { status: 502, message: 'AI provider is unreachable or the endpoint is blocked' };
}

router.get('/config', (req, res) => res.json(publicConfig(readConfig(req.user.id))));

router.put('/config', (req, res) => {
  const body = req.body as Record<string, unknown>;
  try {
    if (typeof body.enabled !== 'boolean') return res.status(400).json({ error: 'Invalid enabled setting' });
    const endpoint = normalizeAiEndpoint(body.endpoint);
    if (!validString(body.model, 256) || !body.model.trim()) return res.status(400).json({ error: 'Model is required' });
    if (!validString(body.prompt, MAX_PROMPT_CHARS) || !body.prompt.trim()) return res.status(400).json({ error: 'Prompt is required and must be at most 4000 characters' });
    const old = readConfig(req.user.id);
    let apiKey = old.api_key;
    if (body.apiKey !== undefined && body.apiKey !== '') {
      if (!validString(body.apiKey, MAX_KEY_CHARS) || !body.apiKey.trim()) return res.status(400).json({ error: 'Invalid API key' });
      apiKey = encrypt(body.apiKey.trim()) ?? null;
    }
    db.prepare(`
      INSERT INTO ai_summary_configs (user_id, enabled, endpoint, model, prompt, api_key, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled, endpoint=excluded.endpoint, model=excluded.model, prompt=excluded.prompt, api_key=excluded.api_key, updated_at=datetime('now')
    `).run(req.user.id, body.enabled ? 1 : 0, endpoint, body.model.trim(), body.prompt.trim(), apiKey);
    res.json(publicConfig(readConfig(req.user.id)));
  } catch {
    res.status(400).json({ error: 'Invalid AI summary configuration' });
  }
});

router.delete('/key', (req, res) => {
  db.prepare(`
    INSERT INTO ai_summary_configs (user_id, enabled, endpoint, model, prompt, api_key, updated_at)
    VALUES (?, 0, ?, '', ?, NULL, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET api_key=NULL, enabled=0, updated_at=datetime('now')
  `).run(req.user.id, DEFAULT_ENDPOINT, DEFAULT_PROMPT);
  res.json(publicConfig(readConfig(req.user.id)));
});

router.post('/test', async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const stored = readConfig(req.user.id);
  try {
    const endpoint = body.endpoint === undefined ? stored.endpoint : normalizeAiEndpoint(body.endpoint);
    const model = body.model === undefined ? stored.model : body.model;
    if (!validString(model, 256) || !model.trim()) return res.status(400).json({ error: 'Configure a model first' });
    let key = stored.api_key ? decrypt(stored.api_key) : null;
    if (body.apiKey !== undefined && body.apiKey !== '') {
      if (!validString(body.apiKey, MAX_KEY_CHARS) || !body.apiKey.trim()) return res.status(400).json({ error: 'Invalid API key' });
      key = body.apiKey.trim();
    }
    if (!key) return res.status(400).json({ error: 'Configure an API key first' });
    await providerRequest(endpoint, key, { model, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 2, temperature: 0 });
    res.json({ ok: true });
  } catch (err) { const e = providerError(err); res.status(e.status).json({ error: e.message }); }
});

router.post('/summarize', async (req, res) => {
  const config = readConfig(req.user.id);
  if (!config.enabled) return res.status(409).json({ error: 'AI summaries are disabled' });
  const apiKey = config.api_key ? decrypt(config.api_key) : null;
  if (!apiKey) return res.status(400).json({ error: 'Configure an API key first' });
  if (!config.model.trim()) return res.status(400).json({ error: 'Configure a model first' });

  const body = req.body as Record<string, unknown>;
  if (!validString(body.articleKey, 512) || !body.articleKey.trim()
    || !validString(body.title, 2000) || !validString(body.url, 4096)
    || !validString(body.content, MAX_ARTICLE_HTML_CHARS) || !body.content.trim()) {
    return res.status(400).json({ error: 'Invalid or empty article' });
  }
  const content = cleanArticleHtml(body.content).slice(0, MAX_ARTICLE_TEXT_CHARS);
  if (!content) return res.status(400).json({ error: 'Article contains no readable text' });

  // Title and URL are in the model prompt too, so they are part of the content hash.
  const contentHash = aiContentHash({ title: body.title, url: body.url, content });
  const configHash = aiConfigHash({ model: config.model, prompt: config.prompt, temperature: TEMPERATURE });
  const articleKey = body.articleKey;
  const find = db.prepare('SELECT summary FROM ai_summary_cache WHERE user_id=? AND article_key=? AND content_hash=? AND config_hash=?');
  if (body.regenerate !== true) {
    const cached = find.get(req.user.id, articleKey, contentHash, configHash) as { summary: string } | undefined;
    if (cached) return res.json({ summary: cached.summary, cached: true });
  }

  const flightKey = [req.user.id, articleKey, contentHash, configHash].join(':');
  if (body.regenerate !== true) {
    const pending = inFlightSummaries.get(flightKey);
    if (pending) {
      try { return res.json({ summary: await pending, cached: true }); }
      catch (err) { const e = providerError(err); return res.status(e.status).json({ error: e.message }); }
    }
  }

  const generateAndSave = async (): Promise<string> => {
    const prompt = `${config.prompt}\n\nArticle title: ${body.title}\nArticle URL: ${body.url}\n\nArticle text:\n${content}`;
    const result = await providerRequest(config.endpoint, apiKey, { model: config.model, messages: [{ role: 'user', content: prompt }], temperature: TEMPERATURE });
    const summary = result.choices?.[0]?.message?.content;
    if (typeof summary !== 'string' || !summary.trim()) {
      throw Object.assign(new Error('AI provider returned an empty or malformed summary'), { status: 502 });
    }
    db.prepare(`
      INSERT INTO ai_summary_cache (user_id, article_key, content_hash, config_hash, model, summary)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, article_key, content_hash, config_hash)
      DO UPDATE SET model=excluded.model, summary=excluded.summary, updated_at=datetime('now')
    `).run(req.user.id, articleKey, contentHash, configHash, config.model, summary.trim());
    return summary.trim();
  };

  const pending = generateAndSave();
  if (body.regenerate !== true) inFlightSummaries.set(flightKey, pending);
  try {
    res.json({ summary: await pending, cached: false });
  } catch (err) {
    const e = providerError(err);
    res.status(e.status).json({ error: e.message });
  } finally {
    if (inFlightSummaries.get(flightKey) === pending) inFlightSummaries.delete(flightKey);
  }
});

export default router;
