import { Preferences } from '@capacitor/preferences';
import type { SQLiteDBConnection } from '@capacitor-community/sqlite';
import { createPersistence, type Persistence } from './persistence.js';
import type { AtomicPreferencesKv } from './preferences-kv.js';

let database: Persistence<null> | undefined;
let pending: Promise<unknown> = Promise.resolve();

function connection<T>(action: (db: SQLiteDBConnection) => Promise<T>): Promise<T> {
  database ??= createPersistence({
    dbName: 'persistence_save_atomic_preferences_v1',
    snapshotVersion: 1,
    serialize: () => ({ version: 1 }),
    deserialize: () => null,
    migrations: {},
    initializeSchema: async (db) => {
      // This assignment returns a timeout row. Android execSQL rejects result
      // columns, so route it through the query bridge even though it sets state.
      await db.query('PRAGMA busy_timeout = 5000;');
      await db.execute(
        'CREATE TABLE IF NOT EXISTS atomic_preferences (key TEXT PRIMARY KEY, value TEXT);',
        false,
      );
    },
  });
  const store = database;
  const unavailable = Symbol('unavailable');
  // One shared native connection cannot host overlapping transactions, even for
  // different namespaces. SQLite BEGIN IMMEDIATE coordinates other processes.
  const next = pending
    .catch(() => undefined)
    .then(() => store.withConnection<T | typeof unavailable>(action, unavailable));
  pending = next;
  return next.then((value) => {
    if (value === unavailable) throw new Error('Native atomic Preferences storage is unavailable.');
    return value;
  });
}

async function read(db: SQLiteDBConnection, key: string): Promise<string | null> {
  const result = await db.query('SELECT value FROM atomic_preferences WHERE key = ?;', [key]);
  if (result.values?.length) return result.values[0]?.value as string | null;
  return (await Preferences.get({ key })).value;
}

async function write(db: SQLiteDBConnection, key: string, value: string | null): Promise<void> {
  // NULL is a persistent tombstone: removed legacy Preferences must not reappear.
  await db.run(
    'INSERT INTO atomic_preferences (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;',
    [key, value],
    false,
  );
}

async function transaction<T>(db: SQLiteDBConnection, action: () => Promise<T>): Promise<T> {
  await db.execute('BEGIN IMMEDIATE;', false);
  try {
    const value = await action();
    await db.execute('COMMIT;', false);
    return value;
  } catch (error) {
    try {
      await db.execute('ROLLBACK;', false);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'Native atomic Preferences transaction failed; storage is uncertain.',
      );
    }
    throw error;
  }
}

async function keys(db: SQLiteDBConnection, prefix: string): Promise<string[]> {
  const legacy = (await Preferences.keys()).keys.filter((key) => key.startsWith(prefix));
  const rows = (await db.query('SELECT key, value FROM atomic_preferences;')).values ?? [];
  const present = new Set(legacy);
  for (const row of rows) {
    if (typeof row.key !== 'string' || !row.key.startsWith(prefix)) continue;
    if (row.value === null) present.delete(row.key);
    else present.add(row.key);
  }
  return [...present];
}

/** Native-only backend; ordinary createPreferencesKv settings are untouched. */
export function createNativeAtomicPreferences(namespace: string): AtomicPreferencesKv {
  const prefix = `${namespace}.`;
  const update: AtomicPreferencesKv['update'] = (key, reduce) =>
    connection((db) =>
      transaction(db, async () => {
        const address = `${prefix}${key}`;
        const before = await read(db, address);
        const next = reduce(before);
        if (next !== null && typeof next !== 'string')
          throw new TypeError(
            'Atomic Preferences reducers must return a string or null synchronously.',
          );
        if (next !== before) {
          await write(db, address, next);
          if ((await read(db, address)) !== next)
            throw new Error('Native atomic Preferences write verification failed.');
        }
        return next;
      }),
    );
  return {
    get: (key) => connection((db) => read(db, `${prefix}${key}`)),
    set: async (key, value) => {
      await update(key, () => value);
    },
    remove: async (key) => {
      // Even an already-absent key needs a tombstone to cut off legacy fallback.
      await connection((db) =>
        transaction(db, async () => {
          await write(db, `${prefix}${key}`, null);
          return null;
        }),
      );
    },
    clear: async () => {
      await connection((db) =>
        transaction(db, async () => {
          for (const key of await keys(db, prefix)) await write(db, key, null);
          return null;
        }),
      );
    },
    keys: () =>
      connection(async (db) => (await keys(db, prefix)).map((key) => key.slice(prefix.length))),
    update,
    getParsed: async (key, parse, fallback) => {
      try {
        return parse(await connection((db) => read(db, `${prefix}${key}`)));
      } catch (error) {
        console.warn(`[preferences-kv] getParsed(${prefix}${key}) failed:`, error);
        return fallback;
      }
    },
  };
}
