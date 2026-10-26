import { createHash } from 'node:crypto';
import { HTML5_ENTITIES } from './semanticEntities.js';

/**
 * Semantic ranking scoring — an exact port of the audited implementation
 * (`/tmp/frirss-semantic-eval/audit-suite.py`, soft balanced margin with
 * log-mean-exp aggregation) that won the real-reader blind-labeling audit.
 *
 * Formula (tau = 0.05, cosine similarities between L2-normalised bge-m3
 * embeddings of `clean(title) + "\n" + clean(summary)` truncated to 5000
 * characters):
 *
 *   lme(Z) = tau * (max(Z/tau) + ln(mean(exp(Z/tau - max)) + 1e-300))
 *   score  = lme(similarities to upvoted articles) - lme(similarities to downvoted articles)
 *
 * Each class uses its FULL reference set; the temperature concentrates the
 * aggregation near each candidate's most-similar neighbours while staying
 * smooth, so a large class cannot swamp a small one (both sides are judged on
 * their own scale).
 */

/** Temperature of the log-mean-exp aggregation. The audited value. */
export const SEMANTIC_TAU = 0.05;

/** Bumped whenever the text preprocessing below changes meaningfully. */
export const SEMANTIC_PREP_VERSION = 1;

/** The audited embedding input length cap (characters). */
export const SEMANTIC_TEXT_MAX_CHARS = 5000;

// ── HTML entity decoding — CPython html.unescape, character for character ──

// Matches the same character references CPython's `_charref` regex matches:
// decimal/hex numeric forms with optional semicolon, and named references of
// up to 32 name characters with optional semicolon. The negated class stops at
// tab, newline, form feed, space, `<`, `&`, `#`, `;` — exactly like CPython.
const CHARREF_PATTERN = /&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/g;

// CPython maps these codepoints through windows-1252 when they appear as
// numeric references, and a few others to U+FFFD.
const INVALID_CHARREFS: Record<number, string> = {
  0x00: '\uFFFD',
  0x80: '\u20AC', 0x82: '\u201A', 0x83: '\u0192', 0x84: '\u201E', 0x85: '\u2026',
  0x86: '\u2020', 0x87: '\u2021', 0x88: '\u02C6', 0x89: '\u2030', 0x8A: '\u0160',
  0x8B: '\u2039', 0x8C: '\u0152', 0x8E: '\u017D', 0x91: '\u2018', 0x92: '\u2019',
  0x93: '\u201C', 0x94: '\u201D', 0x95: '\u2022', 0x96: '\u2013', 0x97: '\u2014',
  0x98: '\u02DC', 0x99: '\u2122', 0x9A: '\u0161', 0x9B: '\u203A', 0x9C: '\u0153',
  0x9E: '\u017E', 0x9F: '\u0178',
};

function replaceCharref(match: string): string {
  // CPython's replacement helper receives the reference WITHOUT the leading
  // ampersand (the regex's first group); the table is keyed the same way.
  const name = match.slice(1);
  if (name[0] !== '#') {
    const replacement = HTML5_ENTITIES[name];
    if (replacement !== undefined) return replacement;
    // Named reference without a semicolon: CPython tries the longest prefix
    // that is a known entity and keeps the rest as literal text.
    if (name[name.length - 1] !== ';') {
      for (let end = name.length - 1; end > 1; end--) {
        const prefix = HTML5_ENTITIES[name.slice(0, end)];
        if (prefix !== undefined) return prefix + name.slice(end);
      }
    }
    return match;
  }
  const hex = name[1] === 'x' || name[1] === 'X';
  const digits = name.slice(hex ? 2 : 1, match.endsWith(';') ? -1 : undefined);
  const parsed = hex ? Number.parseInt(digits, 16) : Number.parseInt(digits, 10);
  if (digits === '' || !Number.isSafeInteger(parsed)) return match;
  const mapped = INVALID_CHARREFS[parsed];
  if (mapped !== undefined) return mapped;
  if (parsed >= 0xd800 && parsed <= 0xdfff) return '\uFFFD';
  if (parsed > 0x10ffff) return '\uFFFD';
  return String.fromCodePoint(parsed);
}

/** Equivalent of Python's `html.unescape`. */
export function unescapeHtml(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(CHARREF_PATTERN, replaceCharref);
}

/**
 * The audited text preprocessing, mirroring the audit helper's `clean()`:
 * entity-decode first, drop script/style/noscript blocks, strip the remaining
 * tags, then collapse all whitespace runs to single spaces and trim.
 */
export function cleanForEmbedding(value: unknown): string {
  let text = unescapeHtml(typeof value === 'string' ? value : String(value ?? ''));
  text = text.replace(/<(script|style|noscript)[\s\S]*?>[\s\S]*?<\/\1>/gi, ' ');
  text = text.replace(/<[^>]+>/gs, ' ');
  return text.replace(/\s+/g, ' ').trim();
}

/** The exact text the audit embedded: `clean(title) + "\n" + clean(summary)`, capped at 5000 chars. */
export function embeddingText(title: unknown, summary: unknown): string {
  return (cleanForEmbedding(title) + '\n' + cleanForEmbedding(summary)).slice(0, SEMANTIC_TEXT_MAX_CHARS);
}

/**
 * The audited cache key: `SHA256(model + "\0summary\0" + text[:5000])`.
 * Cache rows additionally carry provider/model/prep-version columns, so a
 * vector is never reused across incompatible configurations.
 */
export function embeddingCacheKey(model: string, text: string): string {
  return createHash('sha256').update(model + '\0summary\0' + text.slice(0, SEMANTIC_TEXT_MAX_CHARS)).digest('hex');
}

/** L2-normalise; zero vectors pass through unchanged (matches the audit's `norm()`). */
export function unit(vector: number[]): number[] {
  let sumSquares = 0;
  for (const value of vector) sumSquares += value * value;
  const norm = Math.sqrt(sumSquares);
  if (!norm) return vector;
  return vector.map((value) => value / norm);
}

/** Cosine similarity of two L2-normalised vectors (their dot product). */
export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) dot += a[index] * b[index];
  return Number.isFinite(dot) ? dot : 0;
}

function logMeanExp(sims: number[], tau: number): number {
  let max = -Infinity;
  for (const sim of sims) {
    const z = sim / tau;
    if (z > max) max = z;
  }
  let sum = 0;
  for (const sim of sims) sum += Math.exp(sim / tau - max);
  return tau * (max + Math.log(sum / sims.length + 1e-300));
}

/**
 * The audited soft balanced margin. Returns `null` when either class has no
 * reference examples (the audit marks those candidates NaN and skips them).
 * Non-finite similarities are ignored; if nothing usable remains the class is
 * treated as empty.
 */
export function softBalancedMarginScore(
  simsToPositives: number[],
  simsToNegatives: number[],
  tau: number = SEMANTIC_TAU,
): number | null {
  const positives = simsToPositives.filter((value) => Number.isFinite(value));
  const negatives = simsToNegatives.filter((value) => Number.isFinite(value));
  if (!positives.length || !negatives.length) return null;
  const score = logMeanExp(positives, tau) - logMeanExp(negatives, tau);
  return Number.isFinite(score) ? score : null;
}
