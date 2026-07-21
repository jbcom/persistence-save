import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPreferencesKv } from '../src/preferences-kv.js';

const { store } = vi.hoisted(() => ({ store: new Map<string, string>() }));

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
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('rejects an empty namespace', () => {
    expect(() => createPreferencesKv('')).toThrow(/non-empty/);
  });

  it('round-trips a value under the namespaced key (M_SEC.33)', async () => {
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

  it('getParsed() returns the fallback when the parser throws (M_MICRO.B.1)', async () => {
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
