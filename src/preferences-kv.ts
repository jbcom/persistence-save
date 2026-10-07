/**
 * Capacitor Preferences KV bridge — the campaign swap-policy replacement for
 * bare `localStorage` in game code (small settings: muted, last seed, theme,
 * onboarding flags). Backed by `@capacitor/preferences`: native key-value
 * storage on iOS/Android (Keychain-adjacent, survives WebView cache clears),
 * localStorage on web — so bare localStorage survives only INSIDE this
 * package, never in game code.
 *
 * Structured save-game rows do NOT belong here — use `createPersistence`'s
 * SQLite store for those.
 *
 * - Every key is namespaced (`<namespace>.<key>`) so keys can never collide
 *   with other apps' Preferences storage (Android shares the Preferences API
 *   across the entire process).
 * - `getParsed` consolidates the catch-and-default read:
 *   "give me a parsed value or my fallback", never a rejection.
 */

import { Preferences } from '@capacitor/preferences';

/** Namespaced string key-value store over Capacitor Preferences. */
export interface PreferencesKv {
  /** Read a string value. Returns `null` if not set. */
  get(key: string): Promise<string | null>;
  /** Write a string value. */
  set(key: string, value: string): Promise<void>;
  /** Remove a key. No-op when absent. */
  remove(key: string): Promise<void>;
  /** Remove every key in THIS namespace (other namespaces untouched). */
  clear(): Promise<void>;
  /** List the keys present in this namespace (namespace prefix stripped). */
  keys(): Promise<string[]>;
  /**
   * Safe read with a typed parser + fallback. The underlying
   * read may reject (corrupt storage, race with a concurrent set) and the
   * parser may throw on a tampered value — either way the fallback is
   * returned and the failure is logged, never thrown.
   */
  getParsed<T>(key: string, parse: (raw: string | null) => T, fallback: T): Promise<T>;
}

/**
 * Create a namespaced KV store. Use a reverse-domain namespace (e.g.
 * `com.example.mygame`) — see the module comment on why un-namespaced Preferences
 * keys are a cross-app collision risk on Android.
 */
export function createPreferencesKv(namespace: string): PreferencesKv {
  if (namespace.length === 0) {
    throw new Error('createPreferencesKv: namespace must be non-empty');
  }
  const prefix = `${namespace}.`;
  const namespaced = (key: string): string => `${prefix}${key}`;

  return {
    async get(key: string): Promise<string | null> {
      const { value } = await Preferences.get({ key: namespaced(key) });
      return value;
    },

    async set(key: string, value: string): Promise<void> {
      await Preferences.set({ key: namespaced(key), value });
    },

    async remove(key: string): Promise<void> {
      await Preferences.remove({ key: namespaced(key) });
    },

    async clear(): Promise<void> {
      // Preferences.clear() would wipe EVERY namespace sharing the store;
      // enumerate + remove only our own keys instead.
      const { keys } = await Preferences.keys();
      for (const key of keys) {
        if (key.startsWith(prefix)) {
          await Preferences.remove({ key });
        }
      }
    },

    async keys(): Promise<string[]> {
      const { keys } = await Preferences.keys();
      return keys.filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
    },

    async getParsed<T>(key: string, parse: (raw: string | null) => T, fallback: T): Promise<T> {
      try {
        const { value } = await Preferences.get({ key: namespaced(key) });
        return parse(value);
      } catch (err) {
        console.warn(`[preferences-kv] getParsed(${namespaced(key)}) failed:`, err);
        return fallback;
      }
    },
  };
}
