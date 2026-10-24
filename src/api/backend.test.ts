import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The interceptor reads auth state but these tests exercise it directly,
// without making real network requests.
const logoutBackend = vi.fn();
vi.mock('../stores/authStore', () => ({
  useAuthStore: {
    getState: () => ({ backendToken: null, logoutBackend }),
  },
}));

import backend from './backend';
import { isCloudflareAccessError } from '../lib/loginErrors';
import { resolveTechmemeArticleUrl } from './backend';

const handlers = (backend.interceptors.response as unknown as {
  handlers: {
    fulfilled: (response: unknown) => unknown;
    rejected: (error: unknown) => Promise<unknown>;
  }[];
}).handlers[0];
const rejected = handlers.rejected;

const error401 = (headers: Record<string, string> = {}) => ({
  response: { status: 401, headers },
});

const reject = async (err: unknown): Promise<unknown> => {
  await expect(rejected(err)).rejects.toBe(err);
  return err;
};

beforeEach(() => {
  logoutBackend.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('backend request interceptor', () => {
  it('marks requests as XHR so Cloudflare Access answers 401, not 302', () => {
    const requestHandler = (backend.interceptors.request as unknown as {
      handlers: { fulfilled: (config: Record<string, unknown>) => Record<string, unknown> }[];
    }).handlers[0].fulfilled;
    const config = { headers: {} as Record<string, unknown> };
    requestHandler(config);
    expect(config.headers['X-Requested-With']).toBe('XMLHttpRequest');
  });
});

describe('backend response interceptor: Access vs FriRSS auth', () => {
  const stubWindow = () => {
    const reload = vi.fn();
    const assign = vi.fn();
    const values = new Map<string, string>();
    vi.stubGlobal('window', {
      location: { reload, assign, origin: 'https://rss.example.test', host: 'rss.example.test', pathname: '/', search: '', hash: '' },
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
        removeItem: (key: string) => { values.delete(key); },
      },
    });
    return { reload, assign };
  };

  it('recovers from an Access 401 without ending the FriRSS session', async () => {
    const { reload, assign } = stubWindow();
    vi.resetModules();
    const freshBackend = (await import('./backend')).default;
    const freshRejected = (freshBackend.interceptors.response as unknown as {
      handlers: { rejected: (error: unknown) => Promise<unknown> }[];
    }).handlers[0].rejected;

    // The exact fingerprint of an expired Cloudflare Access session on an
    // XHR (previously a 302 to the login page, which surfaced as a CORS
    // network error on /api/preferences and never triggered recovery).
    const caught = await freshRejected(error401({
      'www-authenticate': 'Cloudflare-Access resource_metadata="https://rss.example.test/.well-known/cloudflare-access-protected-resource/api/preferences"',
    })).catch((e: unknown) => e);
    // Typed, so the login screen can name the real cause ("Cloudflare session
    // expired") instead of blaming the FriRSS credentials.
    expect(isCloudflareAccessError(caught)).toBe(true);
    expect((caught as Error).message).toBe('Cloudflare Access authentication required');
    // The recovery landing is a document request the service worker cannot
    // answer — unlike a reload, which the PWA precache swallows.
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith('/api/auth/access-recovery');
    expect(reload).not.toHaveBeenCalled();
    expect(logoutBackend).not.toHaveBeenCalled();
  });

  it('does not misclassify an Access 401 during cooldown as a FriRSS login failure', async () => {
    const reload = vi.fn();
    const assign = vi.fn();
    const now = Date.now();
    vi.stubGlobal('window', {
      location: { reload, assign, origin: 'https://rss.example.test', host: 'rss.example.test', pathname: '/', search: '', hash: '' },
      sessionStorage: {
        getItem: (key: string) => key === 'frirss:cloudflare-access-reload-at' ? String(now - 1000) : null,
        setItem: vi.fn(),
        removeItem: vi.fn(),
      },
    });
    vi.resetModules();
    const freshBackend = (await import('./backend')).default;
    const freshRejected = (freshBackend.interceptors.response as unknown as {
      handlers: { rejected: (error: unknown) => Promise<unknown> }[];
    }).handlers[0].rejected;

    await expect(freshRejected(error401({
      'www-authenticate': 'Cloudflare-Access resource_metadata="https://rss.example.test/.well-known/cloudflare-access-protected-resource/api/auth/login"',
    }))).rejects.toThrow('Cloudflare Access authentication required');
    expect(reload).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
    expect(logoutBackend).not.toHaveBeenCalled();
  });

  it('still ends the FriRSS session on a genuine backend 401', async () => {
    stubWindow();
    await reject(error401({ 'www-authenticate': 'Bearer' }));
    await reject({ response: { status: 401, headers: {} } });
    expect(logoutBackend).toHaveBeenCalledTimes(2);
  });

  it('ignores other statuses and network errors', async () => {
    const { reload, assign } = stubWindow();
    for (const status of [400, 403, 429, 500, 502]) {
      await reject({ response: { status, headers: {} } });
    }
    await reject(new Error('Network Error'));
    expect(logoutBackend).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });
});

describe('resolveTechmemeArticleUrl', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('skips the request for anything that is not a Techmeme URL', async () => {
    const get = vi.spyOn(backend, 'get');
    expect(await resolveTechmemeArticleUrl('https://www.androidauthority.com/google-personal-intelligence-privacy-3727111/')).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it('calls GET /techmeme/resolve and returns a normalized publisher URL', async () => {
    const get = vi.spyOn(backend, 'get').mockResolvedValue({ data: { url: 'https://www.androidauthority.com/google-personal-intelligence-privacy-3727111/' } });
    const url = 'https://www.techmeme.com/261023/p28#a261023p28';
    expect(await resolveTechmemeArticleUrl(url)).toBe('https://www.androidauthority.com/google-personal-intelligence-privacy-3727111/');
    expect(get.mock.calls[0]?.[0]).toBe('/techmeme/resolve');
    const params = (get.mock.calls[0]?.[1] as { params?: { url?: string } } | undefined)?.params;
    expect(params?.url).toBe('https://www.techmeme.com/261023/p28#a261023p28');
  });

  it('returns null on a null resolution, a bad payload and request failure', async () => {
    const get = vi.spyOn(backend, 'get');
    get.mockResolvedValueOnce({ data: { url: null } });
    expect(await resolveTechmemeArticleUrl('https://www.techmeme.com/261023/p28#a261023p28')).toBeNull();
    get.mockResolvedValueOnce({ data: {} });
    expect(await resolveTechmemeArticleUrl('https://www.techmeme.com/261023/p28#a261023p28')).toBeNull();
    get.mockRejectedValueOnce(new Error('timeout'));
    expect(await resolveTechmemeArticleUrl('https://www.techmeme.com/261023/p28#a261023p28')).toBeNull();
  });
});
