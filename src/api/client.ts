import axios, { type InternalAxiosRequestConfig } from 'axios';
import { useAuthStore } from '../stores/authStore';
import { isBackendAuthFailure, CloudflareAccessError } from '../lib/loginErrors';

const client = axios.create();

// All FreshRSS calls are routed through the same-origin backend proxy
// (/api/proxy) to avoid cross-origin CORS/preflight. The target travels in a
// header; the FreshRSS token is injected server-side from X-Server-Id (it
// never reaches the client). Auth to our backend uses the JWT.
client.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const { serverUrl, activeServerId, backendToken } = useAuthStore.getState();
  // Cloudflare Access uses this header to return a recognizable 401 for
  // unauthenticated XHR requests instead of redirecting the request to HTML.
  config.headers['X-Requested-With'] = 'XMLHttpRequest';
  if (serverUrl && config.url) {
    let fullUrl = config.url.startsWith('http')
      ? config.url
      : `${serverUrl}${config.url}`;
    // Fold axios params into the target URL (the proxy is the real request URL)
    if (config.params) {
      const qs = new URLSearchParams(config.params).toString();
      if (qs) fullUrl += (fullUrl.includes('?') ? '&' : '?') + qs;
      config.params = undefined;
    }
    config.headers['X-Proxy-Target'] = fullUrl;
    if (activeServerId) config.headers['X-Server-Id'] = String(activeServerId);
    config.url = '/api/proxy';
    config.baseURL = undefined;
  }
  if (backendToken) {
    config.headers.Authorization = `Bearer ${backendToken}`;
  }
  return config;
});

/** An XHR that Cloudflare redirected to its hosted login page surfaces as an
 * opaque cross-origin network error; the final URL is the only fingerprint
 * left. It is used for DETECTION only — FriRSS never navigates to it, and
 * never builds its own login URL: such a URL works only with Cloudflare's
 * signed `kid`+`meta` parameters (they carry the app identity, so no
 * hostname lookup happens), and only Cloudflare can mint those. Without
 * them, both the team-domain and the app-origin login endpoints answer
 * 404 "Unable to find your Access application!" for wildcard applications.
 * Cloudflare mints a working URL whenever an unauthenticated *document*
 * request arrives — which is why reloading the page is the only safe
 * recovery action. */
type ResponseUrlCarrier = {
  request?: { responseURL?: string };
  response?: { request?: { responseURL?: string } };
  config?: { url?: string };
};

function getResponseUrl(value: unknown): string | undefined {
  const error = value as ResponseUrlCarrier | null;
  return (
    error?.request?.responseURL ??
    error?.response?.request?.responseURL ??
    error?.config?.url
  );
}

function isCloudflareAccessLoginUrl(responseUrl: string | undefined): boolean {
  if (!responseUrl) return false;
  try {
    const url = new URL(responseUrl);
    return (
      url.hostname.endsWith('.cloudflareaccess.com') &&
      url.pathname.startsWith('/cdn-cgi/access/login/')
    );
  } catch {
    return false;
  }
}

const ACCESS_RELOAD_STORAGE_KEY = 'frirss:cloudflare-access-reload-at';
const ACCESS_RELOAD_COOLDOWN_MS = 60_000;
let accessReloadStarted = false;

/**
 * Point d'atterrissage de la récupération Access — une route backend,
 * obligatoirement sous `/api/`.
 *
 * `vite.config.js` pose `navigateFallback: '/index.html'` avec un service
 * worker qui répond à TOUTE navigation (recharges comprises) depuis son
 * pré-cache : `location.reload()` ne quitte donc jamais le navigateur tant
 * que le SW contrôle la page, et Cloudflare n'est jamais invité à émettre son
 * défi — la récupération était structurellement silencieuse dans le PWA
 * déployé. Le déni de `navigateFallbackDenylist: [/^\/api\//]` fait de
 * `/api/auth/access-recovery` la seule navigation qui parte toujours sur le
 * réseau : Cloudflare y voit un document non authentifié, mint son propre défi
 * (signé `kid`+`meta`), puis redirige vers `/`. Un test relie les deux bouts —
 * si l'un dérive sans l'autre, la récupération redevient un no-op.
 */
export const ACCESS_RECOVERY_LANDING = '/api/auth/access-recovery';

type HeaderCarrier = {
  response?: {
    status?: number;
    headers?: Record<string, unknown> & { get?: (name: string) => unknown };
  };
};

function isCloudflareAccessUnauthorized(value: unknown): boolean {
  const response = (value as HeaderCarrier | null)?.response;
  if (response?.status !== 401) return false;
  const headers = response.headers;
  const rawHeader =
    typeof headers?.get === 'function'
      ? headers.get('www-authenticate')
      : headers?.['www-authenticate'] ?? headers?.['WWW-Authenticate'];
  return typeof rawHeader === 'string' &&
    rawHeader.trim().toLowerCase().startsWith('cloudflare-access');
}

function isCloudflareAccessFailure(value: unknown): boolean {
  return (
    isCloudflareAccessUnauthorized(value) ||
    isCloudflareAccessLoginUrl(getResponseUrl(value))
  );
}

/**
 * Single recovery entry point, shared by every FriRSS axios instance (the
 * proxy client here and the backend client in src/api/backend.ts).
 *
 * An unauthenticated DOCUMENT request is the only thing Cloudflare answers
 * with its own login flow — carrying the signed `kid`+`meta` parameters that
 * make wildcard Access applications resolve — and FriRSS must never navigate
 * to a hand-built login URL: without those parameters every login endpoint
 * answers 404 "Unable to find your Access application!" (verified live on
 * both the team-domain and the app origin for *.example.com).
 *
 * The document request cannot be `location.reload()`: the PWA service worker
 * (vite.config.js `navigateFallback` + precache) answers navigations —
 * reloads included — from its cache, so the request never reaches the
 * network and recovery is a silent no-op. Navigating to the `/api/` landing
 * (excluded from `navigateFallback` by `navigateFallbackDenylist`) is
 * therefore the only reload-equivalent that always hits Cloudflare, which
 * mints the challenge and redirects back to the app. Despite the historical
 * name, this function navigates; it never reloads and never builds a login
 * URL. If the landing did not restore Access, stop: any other navigation
 * would mean minting a login URL ourselves.
 */
export async function reloadForCloudflareAccess(value: unknown): Promise<boolean> {
  if (typeof window === 'undefined' || !isCloudflareAccessFailure(value)) {
    return false;
  }
  if (accessReloadStarted) return true;

  const now = Date.now();
  try {
    const previous = Number(window.sessionStorage.getItem(ACCESS_RELOAD_STORAGE_KEY));
    if (Number.isFinite(previous) && previous > 0 && now - previous < ACCESS_RELOAD_COOLDOWN_MS) {
      // This is still an Access failure. Suppress another reload during the
      // cooldown, but do not let the 401 fall through as a FriRSS credential
      // failure or trigger logoutBackend().
      return true;
    }
    window.sessionStorage.setItem(ACCESS_RELOAD_STORAGE_KEY, String(now));
  } catch {
    // Storage can be unavailable in privacy modes; the in-memory guard still
    // prevents concurrent failures from starting multiple reloads.
  }

  accessReloadStarted = true;
  window.location.assign(ACCESS_RECOVERY_LANDING);
  return true;
}

/**
 * Oublie toute récupération déjà tentée : une relance EXPLICITE de
 * l'utilisateur (le bouton « Se connecter ») peut déclencher une nouvelle
 * récupération immédiatement, sans attendre le délai de grâce.
 *
 * Ce délai protège contre les tempêtes de requêtes en fond — des échecs qui
 * déclencheraient navigation sur navigation sans que personne ne demande rien.
 * Un clic de l'utilisateur n'est pas une tempête : il dit « réessaie
 * maintenant ». `accessReloadStarted`, resté vrai depuis la navigation
 * précédente, bloquerait sinon toute nouvelle tentative tant que la page vit.
 */
export function resetCloudflareAccessRecovery(): void {
  accessReloadStarted = false;
  try {
    window.sessionStorage.removeItem(ACCESS_RELOAD_STORAGE_KEY);
  } catch {
    // Storage can be unavailable in privacy modes.
  }
}

// Ne fermer la session FriRSS que sur NOTRE propre 401.
//
// Deux couches d'authentification sans rapport passent par ce client : le
// compte FriRSS (le JWT qui protège `/api/*`) et le serveur FreshRSS rattaché
// (API Google Reader). Le proxy relaie le statut amont TEL QUEL, donc un 401
// de FreshRSS — session expirée là-bas, mot de passe d'API changé ou jamais
// défini — arrivait ici avec le même statut que l'expiration de notre JWT et
// déconnectait l'utilisateur de FriRSS. Une panne d'une couche fermait la
// session de l'autre.
//
// `isBackendAuthFailure` (`src/lib/loginErrors.ts`) reconnaît les 401 de
// `server/middleware/auth.ts` par leurs messages, et un test y relit le
// middleware pour rougir si les deux listes divergent. Tout autre 401 est
// rejeté normalement, sans toucher à la session.
client.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (await reloadForCloudflareAccess(error)) {
      // Typed so the login screen can say "Cloudflare session expired"
      // instead of blaming the credentials (`loginErrors.ts`).
      return Promise.reject(new CloudflareAccessError());
    }
    if (isBackendAuthFailure(error)) {
      useAuthStore.getState().logout();
    }
    return Promise.reject(error);
  }
);

export default client;
