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

import { Capacitor } from '@capacitor/core';
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

/** A Preferences store with a verified, serialized web read-modify-write. */
export interface AtomicPreferencesKv extends PreferencesKv {
  /**
   * Transform the latest durable value while holding the namespace's Web Lock.
   * The reducer must be synchronous; return null to remove the key. Rejects
   * without writing on native platforms or when Web Locks are unavailable.
   * All writers must use this package in the same origin, not raw Preferences.
   */
  update(key: string, reduce: (current: string | null) => string | null): Promise<string | null>;
}

// Ordinary setters remain available outside secure browser contexts. Their
// fallback queue is not an atomic-update guarantee across realms or processes.
const pending = new Map<string, Promise<unknown>>();

function serialize<T>(namespace: string, action: () => Promise<T>, atomic = false): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!Capacitor.isNativePlatform() && locks) {
    return locks.request(
      `persistence-save.preferences.${namespace}`,
      { mode: 'exclusive' },
      action,
    );
  }
  if (atomic) {
    return Promise.reject(
      new Error('Atomic Preferences updates require web storage and the Web Locks API.'),
    );
  }
  const previous = pending.get(namespace) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(action);
  pending.set(namespace, next);
  void next
    .finally(() => {
      if (pending.get(namespace) === next) pending.delete(namespace);
    })
    .catch(() => undefined);
  return next;
}

/**
 * Create a namespaced KV store. Use a reverse-domain namespace (e.g.
 * `com.example.mygame`) — see the module comment on why un-namespaced Preferences
 * keys are a cross-app collision risk on Android.
 */
export function createPreferencesKv(namespace: string): AtomicPreferencesKv {
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
      await serialize(namespace, () => Preferences.set({ key: namespaced(key), value }));
    },

    async remove(key: string): Promise<void> {
      await serialize(namespace, () => Preferences.remove({ key: namespaced(key) }));
    },

    async clear(): Promise<void> {
      await serialize(namespace, async () => {
        // Preferences.clear() would wipe other namespaces sharing the store.
        const { keys } = await Preferences.keys();
        for (const key of keys) {
          if (key.startsWith(prefix)) await Preferences.remove({ key });
        }
      });
    },

    async keys(): Promise<string[]> {
      const { keys } = await Preferences.keys();
      return keys.filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
    },

    update(key, reduce) {
      return serialize(
        namespace,
        async () => {
          const address = namespaced(key);
          const read = async () => (await Preferences.get({ key: address })).value;
          const write = async (value: string | null) => {
            if (value === null) await Preferences.remove({ key: address });
            else await Preferences.set({ key: address, value });
          };
          const before = await read();
          const next = reduce(before);
          if (next !== null && typeof next !== 'string') {
            throw new TypeError(
              'Atomic Preferences reducers must return a string or null synchronously.',
            );
          }
          if (next === before) return before;
          try {
            await write(next);
            if ((await read()) !== next)
              throw new Error('Atomic Preferences write verification failed.');
          } catch (error) {
            // Keep the lock until restoration is verified. A queued newer writer
            // cannot be overwritten by this attempt's rollback.
            try {
              await write(before);
              if ((await read()) !== before)
                throw new Error('Preferences rollback verification failed.');
            } catch (rollbackError) {
              throw new AggregateError(
                [error, rollbackError],
                'Atomic Preferences update and rollback failed; storage is uncertain.',
              );
            }
            throw error;
          }
          return next;
        },
        true,
      );
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
