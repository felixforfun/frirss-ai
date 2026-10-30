// ═══════════════════════════════════════════════════════════════════════
// Start-page preference — the view FriRSS opens on, chosen from the feed
// sidebar's context menu (« Set as start page »).
//
// Destinations carry stable identifiers, never display labels:
//   • subscribed feeds, by FreshRSS stream id — a rename must not orphan
//     the preference (the title is kept only for instant navigation before
//     the subscription list has landed);
//   • global views, by their `Filter` value — each sidebar entry maps to
//     one stable filter id.
//
// Storage: device-local, per active FreshRSS server — the same choice as
// `lastView.ts`. A feed id only means something to the server that issued
// it, so an account-synced preference would spread a server-bound id
// across servers where it does not exist.
//
// Precedence at startup (`App.tsx`): start page → last viewed view → the
// default landing view. Devices without a stored target keep today's
// behavior byte for byte.
// ═══════════════════════════════════════════════════════════════════════
import type { Subscription, Filter } from '../types';

/** A subscribed feed, identified by its FreshRSS stream id. */
export interface FeedStartPage {
  kind: 'feed';
  id: string;
  /** Display label kept for instant navigation; never used for identity. */
  title: string;
}

/** One of the sidebar's global views, identified by its filter value. */
export interface FilterStartPage {
  kind: 'filter';
  filter: Filter;
}

export type StartPageTarget = FeedStartPage | FilterStartPage;

/**
 * Filters whose streams are stable destinations. Deliberately every value of
 * `Filter` including computed views (interesting / infrequent / recentlyread) —
 * restoring one runs the same `selectView` path as clicking its sidebar entry.
 */
const VALID_FILTERS: Filter[] = [
  'all', 'unread', 'interesting', 'infrequent', 'recentlyread', 'starred', 'readlater',
];

const PREFIX = 'frirss_startPage_';

function keyFor(serverId: string | number | null | undefined): string {
  return PREFIX + (serverId != null ? String(serverId) : 'default');
}

function normalize(unknown: unknown): StartPageTarget | null {
  if (!unknown || typeof unknown !== 'object') return null;
  const v = unknown as Partial<StartPageTarget>;
  if (v.kind === 'feed') {
    // An empty id names nothing — reject rather than restore a broken view.
    return typeof v.id === 'string' && v.id && typeof v.title === 'string'
      ? { kind: 'feed', id: v.id, title: v.title }
      : null;
  }
  if (v.kind === 'filter') {
    return typeof v.filter === 'string' && (VALID_FILTERS as string[]).includes(v.filter)
      ? { kind: 'filter', filter: v.filter as Filter }
      : null;
  }
  return null;
}

export function saveStartPage(
  serverId: string | number | null | undefined,
  target: StartPageTarget,
): void {
  try {
    localStorage.setItem(keyFor(serverId), JSON.stringify(target));
  } catch {
    // Storage unavailable/full — saving a preference is best-effort, never fatal.
  }
}

export function clearStartPage(serverId: string | number | null | undefined): void {
  try {
    localStorage.removeItem(keyFor(serverId));
  } catch {
    // Not fatal either: a stale value keeps pointing at a real destination.
  }
}

export function loadStartPage(
  serverId: string | number | null | undefined,
): StartPageTarget | null {
  try {
    const raw = localStorage.getItem(keyFor(serverId));
    if (!raw) return null;
    // A value we can no longer honour (unknown kind, dropped filter, empty id —
    // anything a future version might write) behaves as if nothing was set.
    return normalize(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Same destination, not the same label: feeds compare by id only so that a
 * rename never makes the start page appear unset, and a re-saved id with a
 * fresher title counts as a change of preference — not a no-op.
 */
export function targetsEqual(
  a: StartPageTarget | null | undefined,
  b: StartPageTarget | null | undefined,
): boolean {
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'feed' && b.kind === 'feed') return a.id === b.id;
  return a.kind === 'filter' && b.kind === 'filter' && a.filter === b.filter;
}

export interface StartPageResume {
  /** Pseudo or real subscription, exactly what `selectView` accepts. */
  feed: Subscription | null;
  /** `null` for a feed: let its own "unread only" preference decide. */
  filter: Filter | null;
  /**
   * Open the landing view the way the « All feeds » sidebar entry does —
   * `selectHomeAll`, not a bare `selectView(null, 'all')`, so the unread-only
   * scope is honoured exactly as when the entry is clicked.
   */
  homeAll: boolean;
}

/**
 * Turn a stored target into a resume instruction, or `null` when the
 * destination no longer exists (feed deleted server-side) — the caller then
 * falls back to the default startup behaviour instead of a broken view.
 * Global views are always restorable: their filters are stable identifiers.
 */
export function resumeTarget(
  target: StartPageTarget | null,
  subscriptions: Subscription[],
): StartPageResume | null {
  if (!target) return null;
  if (target.kind === 'feed') {
    // The live subscription wins over the stored title: identity is the id,
    // but the display label must follow the feed's current name.
    const live = subscriptions.find((s) => s.id === target.id);
    if (!live) return null;
    return { feed: live, filter: null, homeAll: false };
  }
  if (target.filter === 'all') return { feed: null, filter: 'all', homeAll: true };
  return { feed: null, filter: target.filter, homeAll: false };
}
