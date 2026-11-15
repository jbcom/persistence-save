import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAtomicPreferencesKv, createPreferencesKv } from '../src/preferences-kv.js';

const { store } = vi.hoisted(() => ({ store: new Map<string, string>() }));

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: vi.fn(() => false) } }));

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async ({ key }: { key: string }) => ({ value: store.get(key) ?? null })),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
      store.set(key, value);
    }),
    remove: vi.fn(async ({ key }: { key: string }) => {
      store.delete(key);
    }),
    keys: vi.fn(async () => ({ keys: Array.from(store.keys()) })),
  },
}));

describe('createPreferencesKv', () => {
  beforeEach(() => {
    store.clear();
    const queues = new Map<string, Promise<unknown>>();
    vi.stubGlobal('navigator', {
      locks: {
        request: vi.fn((name: string, _options: unknown, action: () => Promise<unknown>) => {
          const next = (queues.get(name) ?? Promise.resolve()).catch(() => undefined).then(action);
          queues.set(name, next);
          return next;
        }),
      },
    });
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('rejects an empty namespace', () => {
    expect(() => createPreferencesKv('')).toThrow(/non-empty/);
  });

  it('round-trips a value under the namespaced key', async () => {
    const kv = createPreferencesKv('com.example.game');
    await kv.set('muted', '1');
    expect(store.get('com.example.game.muted')).toBe('1');
    expect(await kv.get('muted')).toBe('1');
  });

  it('returns null for an unset key', async () => {
    const kv = createPreferencesKv('com.example.game');
    expect(await kv.get('missing')).toBeNull();
  });

  it('remove() deletes only the addressed key', async () => {
    const kv = createPreferencesKv('com.example.game');
    await kv.set('a', '1');
    await kv.set('b', '2');
    await kv.remove('a');
    expect(await kv.get('a')).toBeNull();
    expect(await kv.get('b')).toBe('2');
  });

  it('two namespaces never collide', async () => {
    const kv1 = createPreferencesKv('com.example.one');
    const kv2 = createPreferencesKv('com.example.two');
    await kv1.set('muted', '1');
    await kv2.set('muted', '0');
    expect(await kv1.get('muted')).toBe('1');
    expect(await kv2.get('muted')).toBe('0');
  });

  it('clear() wipes only its own namespace', async () => {
    const kv1 = createPreferencesKv('com.example.one');
    const kv2 = createPreferencesKv('com.example.two');
    await kv1.set('a', '1');
    await kv1.set('b', '2');
    await kv2.set('a', 'keep');
    await kv1.clear();
    expect(await kv1.get('a')).toBeNull();
    expect(await kv1.get('b')).toBeNull();
    expect(await kv2.get('a')).toBe('keep');
  });

  it('keys() lists namespace keys with the prefix stripped', async () => {
    const kv = createPreferencesKv('com.example.game');
    const other = createPreferencesKv('com.other.app');
    await kv.set('muted', '1');
    await kv.set('vol.sfx', '0.5');
    await other.set('muted', '0');
    expect((await kv.keys()).sort()).toEqual(['muted', 'vol.sfx']);
  });

  it('getParsed() returns the parsed value on success', async () => {
    const kv = createPreferencesKv('com.example.game');
    await kv.set('volume', '0.75');
    const parsed = await kv.getParsed('volume', (raw) => Number(raw), 1);
    expect(parsed).toBe(0.75);
  });

  it('getParsed() returns the fallback when the parser throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
      /* silence expected warn */
    });
    try {
      const kv = createPreferencesKv('com.example.game');
      await kv.set('settings', 'not-json');
      const parsed = await kv.getParsed(
        'settings',
        (raw) => JSON.parse(raw ?? '') as { theme: string },
        { theme: 'dark' },
      );
      expect(parsed).toEqual({ theme: 'dark' });
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('getParsed() returns the fallback when the underlying read rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
      /* silence expected warn */
    });
    try {
      const { Preferences } = await import('@capacitor/preferences');
      (Preferences.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('storage corrupt'),
      );
      const kv = createPreferencesKv('com.example.game');
      const parsed = await kv.getParsed('anything', (raw) => raw ?? 'fallback-parse', 'fallback');
      expect(parsed).toBe('fallback');
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('getParsed() hands the parser null for an unset key', async () => {
    const kv = createPreferencesKv('com.example.game');
    const parsed = await kv.getParsed('unset', (raw) => (raw === null ? 'was-null' : raw), 'x');
    expect(parsed).toBe('was-null');
  });
});

describe('atomic Preferences update', () => {
  beforeEach(() => {
    store.clear();
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    const queues = new Map<string, Promise<unknown>>();
    vi.stubGlobal('navigator', {
      locks: {
        request: vi.fn((name: string, _options: unknown, action: () => Promise<unknown>) => {
          const next = (queues.get(name) ?? Promise.resolve()).catch(() => undefined).then(action);
          queues.set(name, next);
          return next;
        }),
      },
    });
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('merges concurrent updates from independent handles using fresh stored values', async () => {
    const a = createAtomicPreferencesKv('shared');
    const b = createAtomicPreferencesKv('shared');
    await Promise.all([
      a.update('history', (raw) => `${raw ?? ''}a`),
      b.update('history', (raw) => `${raw ?? ''}b`),
    ]);
    expect(await b.get('history')).toBe('ab');
  });

  it('removes values and avoids unchanged writes', async () => {
    const kv = createAtomicPreferencesKv('shared');
    await kv.set('value', 'old');
    vi.mocked(Preferences.set).mockClear();
    expect(await kv.update('value', (raw) => raw)).toBe('old');
    expect(Preferences.set).not.toHaveBeenCalled();
    expect(await kv.update('value', () => null)).toBeNull();
    expect(await kv.get('value')).toBeNull();
  });

  it('rejects thrown and async reducers before writing', async () => {
    const kv = createAtomicPreferencesKv('shared');
    await expect(
      kv.update('value', () => {
        throw new Error('bad reducer');
      }),
    ).rejects.toThrow('bad reducer');
    // TypeScript refuses this too; the runtime boundary protects JavaScript consumers.
    // @ts-expect-error asynchronous reducers are forbidden
    await expect(kv.update('value', async () => 'bad')).rejects.toThrow('synchronously');
    expect(await kv.get('value')).toBeNull();
  });

  it('keeps rollback inside the lock before a queued newer writer runs', async () => {
    const a = createAtomicPreferencesKv('shared');
    const b = createAtomicPreferencesKv('shared');
    await a.set('value', 'old');
    vi.mocked(Preferences.set).mockImplementationOnce(async ({ key, value }) => {
      store.set(key, value);
      throw new Error('write failed after applying');
    });
    const failed = a.update('value', () => 'failed');
    const newer = b.update('value', (raw) => `${raw}-new`);
    await expect(failed).rejects.toThrow('write failed after applying');
    await expect(newer).resolves.toBe('old-new');
    expect(await a.get('value')).toBe('old-new');
  });

  it('verifies a dropped write and restores the prior value', async () => {
    const kv = createAtomicPreferencesKv('shared');
    await kv.set('value', 'old');
    vi.mocked(Preferences.set).mockResolvedValueOnce(undefined);
    await expect(kv.update('value', () => 'new')).rejects.toThrow('verification failed');
    expect(await kv.get('value')).toBe('old');
  });

  it('restores an absent key after a failed verification read', async () => {
    const kv = createAtomicPreferencesKv('shared');
    vi.mocked(Preferences.get)
      .mockResolvedValueOnce({ value: null })
      .mockRejectedValueOnce(new Error('read failed'));
    await expect(kv.update('value', () => 'new')).rejects.toThrow('read failed');
    expect(await kv.get('value')).toBeNull();
  });

  it('reports rollback failure as uncertain storage', async () => {
    const kv = createAtomicPreferencesKv('shared');
    vi.mocked(Preferences.get)
      .mockResolvedValueOnce({ value: 'old' })
      .mockResolvedValueOnce({ value: 'wrong' })
      .mockResolvedValueOnce({ value: 'wrong' });
    await expect(kv.update('value', () => 'new')).rejects.toThrow('storage is uncertain');
  });

  it('rejects unsupported web atomic operations before storage access', async () => {
    const kv = createAtomicPreferencesKv('shared');
    vi.stubGlobal('navigator', {});
    await expect(kv.update('value', () => 'new')).rejects.toThrow('Web Locks');
    expect(Preferences.get).not.toHaveBeenCalled();
    expect(Preferences.set).not.toHaveBeenCalled();
  });

  it('ordinary setters still work without navigator or Web Locks and recover after rejection', async () => {
    vi.stubGlobal('navigator', undefined);
    const kv = createAtomicPreferencesKv('shared');
    vi.mocked(Preferences.set).mockRejectedValueOnce(new Error('unavailable'));
    const bad = kv.set('value', 'bad');
    const good = kv.set('value', 'good');
    await expect(bad).rejects.toThrow('unavailable');
    await good;
    expect(await kv.get('value')).toBe('good');
    await kv.remove('value');
    await kv.clear();
  });
});
