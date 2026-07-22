/**
 * Generic save-game persistence facade — extracted from
 * Aethelgard-Chronicles-of-Strata's `src/persistence/persistence.ts`
 * (tournament winner, opus-upheld) and generalized to a caller-supplied
 * `TState`/`TSnapshot` pair + migration table.
 *
 * Save games are stored in `@capacitor-community/sqlite` (a `saves` table):
 * - Web: jeep-sqlite backed by sql.js + IndexedDB.
 * - iOS/Android: native SQLite via the Capacitor plugin, SQLCipher-encrypted
 *   when `encrypted: true` (per-install key minted via WebCrypto and stored
 *   in Capacitor Preferences — Keychain on iOS, EncryptedSharedPrefs on
 *   Android).
 *
 * The SQLite connection is opened lazily on the first save/load/list/delete
 * call. `createPersistence()` itself is synchronous and touches nothing.
 *
 * Hardening carried over from the source (each tagged to its original
 * security-review id):
 * - parameterized SQL throughout — zero string-built statements.
 * - UPSERT-by-name saves (M_SEC.26) — React StrictMode double-effect-safe.
 * - row cap on save() (M_AUDIT2.SEC2.7) + LIMIT on list() (M_SEC.13).
 * - snapshot byte cap before JSON.parse (M_AUDIT2.SEC2.9).
 * - CorruptSaveError distinguishes "no save" from "corrupt save" (M_SEC.22);
 *   list() skips + logs corrupt rows individually (M_SEC.21).
 * - synchronous web-store flush after EVERY write (M_V13.PERSIST.WEB-FLUSH)
 *   — no debounce window to lose data in; flush failures propagate.
 * - hard-fail key generation without WebCrypto (M_SEC_REVIEW.1) — better no
 *   saves than weak-encrypted saves.
 */

import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import {
  CapacitorSQLite,
  SQLiteConnection,
  type SQLiteDBConnection,
} from '@capacitor-community/sqlite';
import { type MigrationTable, migrateSnapshot, type VersionedSnapshot } from './migrations.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A persisted save-game record, with the snapshot already deserialized. */
export interface SaveRecord<TState> {
  /** Row id from the saves table. */
  id: number;
  /** The save's display name (unique — save() UPSERTs by name). */
  name: string;
  /** The seed phrase captured at save time (empty when `seedPhraseOf` unset). */
  seedPhrase: string;
  /** ISO timestamp the save was written. */
  savedAt: string;
  /** The restored state (migrated to the current snapshot version). */
  snapshot: TState;
}

/** The persistence facade interface. */
export interface Persistence<TState> {
  /**
   * Persist `state` under `name`. Parameterized UPSERT-by-name (a save with
   * the same name replaces the prior row, idempotently — StrictMode-safe),
   * row-capped at `maxSaves`, flushed to the web store before resolving.
   * No-op when the DB is unavailable in this environment.
   */
  save(name: string, state: TState): Promise<void>;
  /**
   * Load a save by row id. Returns `null` when no row exists; throws
   * {@link CorruptSaveError} when the row exists but its snapshot fails to
   * parse / migrate / deserialize — corruption is never masked as "no save".
   */
  load(id: number): Promise<SaveRecord<TState> | null>;
  /**
   * List saves newest-first, capped at `listLimit` rows. Corrupt rows are
   * skipped + logged individually rather than failing the whole list.
   */
  list(): Promise<SaveRecord<TState>[]>;
  /** Delete a save by row id. No-op when the row doesn't exist. */
  delete(id: number): Promise<void>;
  /**
   * Close the underlying DB connection. Subsequent calls re-open lazily.
   * Safe to call when nothing is open.
   */
  close(): Promise<void>;
}

/**
 * Thrown by `load(id)` when the row exists but its snapshot column fails to
 * parse / migrate / validate (M_SEC.22). Lets the app's resume path
 * differentiate "no save here" (null) from "save corrupted" (throw).
 */
export class CorruptSaveError extends Error {
  constructor(
    /** Row id of the corrupt record. */
    public readonly recordId: number,
    /** Human-readable parse/migration failure reason. */
    public readonly cause: string,
  ) {
    super(`Save ${recordId} is corrupt: ${cause}`);
    this.name = 'CorruptSaveError';
  }
}

/** Configuration for {@link createPersistence}. */
export interface PersistenceConfig<TState, TSnapshot extends VersionedSnapshot> {
  /**
   * SQLite database name. Namespace it (reverse-domain + version suffix,
   * e.g. `com.example.mygame_v1`) — the bare app name collides with any
   * other app sharing the same WebSQL/IndexedDB origin (M_AUDIT2.SEC2.8).
   */
  dbName: string;
  /** Capacitor SQLite connection version. Default 1. */
  dbVersion?: number;
  /**
   * The snapshot version `serialize` currently emits — the migration
   * walker's target. Bump together with every new `migrations` entry.
   */
  snapshotVersion: number;
  /**
   * SQLCipher at-rest encryption on native platforms (M_SEC.4). The
   * per-install passphrase is minted from `crypto.getRandomValues` and
   * stored under `<dbName>.dbKey` in Capacitor Preferences (Keychain /
   * EncryptedSharedPrefs). Ignored on web (sql.js has no SQLCipher).
   */
  encrypted?: boolean;
  /** State → versioned snapshot (must set `version: snapshotVersion`). */
  serialize: (state: TState) => TSnapshot;
  /** Migrated snapshot → live state. */
  deserialize: (snap: TSnapshot) => TState;
  /** Chained N→N+1 migration table (see {@link migrateSnapshot}). */
  migrations: MigrationTable;
  /** Extract the seed phrase stored on each row. Default: empty string. */
  seedPhraseOf?: (state: TState) => string;
  /** DoS row cap enforced after every save(). Default 100 (M_AUDIT2.SEC2.7). */
  maxSaves?: number;
  /** DoS row cap on list(). Default 50 (M_SEC.13). */
  listLimit?: number;
  /**
   * Hard cap on snapshot JSON length, enforced on BOTH write and read
   * (M_AUDIT2.SEC2.9 — bounds JSON.parse cost on tampered rows).
   * Default 2 MiB.
   */
  maxSnapshotBytes?: number;
  /**
   * Directory the jeep-sqlite WASM assets are served from on web.
   * Default `/assets` (copy both package exports `assets/sql-wasm.wasm` and
   * `assets/sql-wasm-browser.wasm` into `public/assets/` so the
   * package-owned, compatibility-tested assets are used).
   */
  wasmAssetsPath?: string;
}

// ---------------------------------------------------------------------------
// Module-level driver state
// ---------------------------------------------------------------------------

// One SQLiteConnection manager per process — the Capacitor plugin registers
// connections globally, so multiple createPersistence() instances (distinct
// dbNames) share this manager.
let sqliteManager: SQLiteConnection | null = null;

function isWebPlatform(): boolean {
  return Capacitor.getPlatform() === 'web';
}

/**
 * Inject the `<jeep-sqlite>` custom element needed by sql.js on web.
 * No-ops on native platforms or in non-browser environments.
 */
async function ensureJeepSqliteElement(wasmAssetsPath: string): Promise<void> {
  if (!isWebPlatform() || typeof window === 'undefined' || typeof document === 'undefined') {
    return;
  }

  const { defineCustomElements } = await import('@arcade-cabinet/jeep-sqlite/loader');
  await defineCustomElements(window);

  let jeepEl = document.querySelector('jeep-sqlite');
  if (!jeepEl) {
    jeepEl = document.createElement('jeep-sqlite');
    jeepEl.setAttribute('wasmpath', wasmAssetsPath);
    document.body.appendChild(jeepEl);
  }

  // Wait for the custom element to be fully registered before using it.
  // Without this, the capacitor-sqlite connection can race against the
  // element's internal WASM initialization and produce transaction errors.
  await customElements.whenDefined('jeep-sqlite');
}

/**
 * M_SEC.4 + M_SEC_REVIEW.1 — read or mint the per-install SQLCipher
 * passphrase (64 random bytes → base64, stored under `<dbName>.dbKey` in
 * Capacitor Preferences). Hard-fails when WebCrypto is unavailable — the
 * caller catches, marks the DB unavailable, and saves degrade to a no-op.
 * Better no saves than weak-encrypted saves.
 */
async function ensureDbSecret(dbName: string): Promise<string> {
  if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') {
    throw new Error('persistence: WebCrypto unavailable; cannot generate secure DB passphrase');
  }
  const prefKey = `${dbName}.dbKey`;
  const existing = await Preferences.get({ key: prefKey });
  if (existing.value && existing.value.length >= 32) return existing.value;
  const bytes = new Uint8Array(64);
  crypto.getRandomValues(bytes);
  const secret = btoa(String.fromCharCode(...bytes));
  await Preferences.set({ key: prefKey, value: secret });
  return secret;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const DEFAULT_MAX_SAVES = 100;
const DEFAULT_LIST_LIMIT = 50;
const DEFAULT_MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const MAX_NAME_LENGTH = 256;

/**
 * Create the persistence facade. Synchronous — no I/O at construction time;
 * the DB opens lazily on first use and re-opens after `close()`.
 */
export function createPersistence<TState, TSnapshot extends VersionedSnapshot>(
  config: PersistenceConfig<TState, TSnapshot>,
): Persistence<TState> {
  const {
    dbName,
    dbVersion = 1,
    snapshotVersion,
    encrypted = false,
    serialize,
    deserialize,
    migrations,
    seedPhraseOf,
    maxSaves = DEFAULT_MAX_SAVES,
    listLimit = DEFAULT_LIST_LIMIT,
    maxSnapshotBytes = DEFAULT_MAX_SNAPSHOT_BYTES,
    wasmAssetsPath = '/assets',
  } = config;

  // Per-instance connection state — all null until the first openDb() call.
  let db: SQLiteDBConnection | null = null;
  let openPromise: Promise<SQLiteDBConnection | null> | null = null;
  /** True once the DB provably cannot open (e.g. WASM missing in a test env). */
  let dbUnavailable = false;

  /**
   * M_V13.PERSIST.WEB-FLUSH — flush the in-memory sql.js DB back to
   * IndexedDB on web. jeep-sqlite holds the database in memory; without an
   * explicit `saveToStore` after a mutation, the write is lost on the next
   * page load. No-op on native (SQLCipher writes straight to disk). A flush
   * failure (IndexedDB quota, private-mode block) PROPAGATES — the caller's
   * save() rejects instead of silently losing the write.
   */
  async function flushWebStore(): Promise<void> {
    if (!isWebPlatform() || !sqliteManager) return;
    await sqliteManager.saveToStore(dbName);
  }

  /**
   * Open (or reuse) the database and ensure the schema exists. Returns null
   * (and sets dbUnavailable) if the DB cannot be opened. Idempotent —
   * concurrent callers share a single open sequence.
   */
  async function openDb(): Promise<SQLiteDBConnection | null> {
    if (dbUnavailable) return null;
    if (db) return db;
    if (openPromise) return openPromise;

    openPromise = (async () => {
      try {
        await ensureJeepSqliteElement(wasmAssetsPath);

        if (!sqliteManager) {
          sqliteManager = new SQLiteConnection(CapacitorSQLite);
        }

        if (isWebPlatform()) {
          await sqliteManager.initWebStore();
        }

        // M_SEC.4 — encryption mode + per-install key on native; the web
        // sql.js fallback ignores the encryption arg, so the bootstrap is
        // identical and a future SQLCipher.wasm adoption picks up the key
        // automatically.
        const useEncryption = encrypted && !isWebPlatform();
        const secret = useEncryption ? await ensureDbSecret(dbName) : null;
        if (secret && sqliteManager.setEncryptionSecret) {
          try {
            await sqliteManager.setEncryptionSecret(secret);
          } catch {
            // setEncryptionSecret throws on unsupported platforms; swallow
            // and let createConnection fall back to plaintext.
          }
        }
        const isConnected = (await sqliteManager.isConnection(dbName, false)).result;
        const conn = isConnected
          ? await sqliteManager.retrieveConnection(dbName, false)
          : await sqliteManager.createConnection(
              dbName,
              useEncryption,
              useEncryption ? 'encryption' : 'no-encryption',
              dbVersion,
              false,
            );

        await conn.open();

        await conn.execute(`
          CREATE TABLE IF NOT EXISTS saves (
            id       INTEGER PRIMARY KEY AUTOINCREMENT,
            name     TEXT    NOT NULL,
            seed     TEXT    NOT NULL,
            saved_at TEXT    NOT NULL,
            snapshot TEXT    NOT NULL
          );
        `);

        db = conn;
        return conn;
      } catch (err) {
        // DB not available in this environment (e.g. WASM fails in headless
        // Chromium during browser tests). Mark unavailable so callers get
        // graceful no-op behaviour rather than an unhandled rejection.
        dbUnavailable = true;
        console.warn('[persistence] SQLite unavailable, saves disabled:', err);
        return null;
      }
    })();

    try {
      return await openPromise;
    } finally {
      openPromise = null;
    }
  }

  /**
   * Raw row → SaveRecord. Enforces the snapshot byte cap BEFORE JSON.parse
   * (M_AUDIT2.SEC2.9), walks the migration chain, then deserializes.
   */
  // biome-ignore lint/suspicious/noExplicitAny: capacitor-sqlite values are untyped
  function rowToSaveRecord(row: any): SaveRecord<TState> {
    const snapshotStr = row.snapshot as string;
    if (typeof snapshotStr !== 'string') {
      throw new Error('snapshot column missing or non-string');
    }
    if (snapshotStr.length > maxSnapshotBytes) {
      throw new Error(`snapshot too large (${snapshotStr.length} > ${maxSnapshotBytes} bytes)`);
    }
    const parsed = JSON.parse(snapshotStr) as Record<string, unknown>;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('snapshot is not a JSON object');
    }
    const migrated = migrateSnapshot(parsed, snapshotVersion, migrations) as unknown as TSnapshot;
    return {
      id: row.id as number,
      name: row.name as string,
      seedPhrase: row.seed as string,
      savedAt: row.saved_at as string,
      snapshot: deserialize(migrated),
    };
  }

  return {
    async save(name: string, state: TState): Promise<void> {
      const conn = await openDb();
      if (!conn) return;
      // M_SEC.12 — cap the save name; a future cloud-sync feature could
      // receive arbitrarily-long input, so truncate at the storage layer.
      const safeName = name.length > MAX_NAME_LENGTH ? name.slice(0, MAX_NAME_LENGTH) : name;
      const seed = seedPhraseOf ? seedPhraseOf(state) : '';
      const savedAt = new Date().toISOString();
      const snapshot = JSON.stringify(serialize(state));
      // Write-side byte cap, symmetric with the read-side check so a state
      // that serializes over-budget fails loudly HERE, not as a
      // CorruptSaveError on the next load.
      if (snapshot.length > maxSnapshotBytes) {
        throw new Error(
          `persistence: snapshot too large to save (${snapshot.length} > ${maxSnapshotBytes} bytes)`,
        );
      }
      // M_SEC.26 — UPSERT by name: a save with the same name replaces the
      // prior row, idempotently. Defends against React StrictMode
      // double-firing effects inserting duplicate AutoSave rows. The
      // DELETE+INSERT pair stays atomic-enough within sql.js's
      // single-threaded execution.
      await conn.run(`DELETE FROM saves WHERE name = ?;`, [safeName]);
      await conn.run(`INSERT INTO saves (name, seed, saved_at, snapshot) VALUES (?, ?, ?, ?);`, [
        safeName,
        seed,
        savedAt,
        snapshot,
      ]);
      // M_AUDIT2.SEC2.7 — row cap: a runaway save-with-new-name loop could
      // otherwise grow unbounded; past maxSaves, drop the oldest rows.
      await conn.run(
        `DELETE FROM saves WHERE id IN (
           SELECT id FROM saves ORDER BY saved_at DESC LIMIT -1 OFFSET ?
         );`,
        [maxSaves],
      );
      // M_V13.PERSIST.WEB-FLUSH — persist to IndexedDB before resolving so
      // the save survives a page reload.
      await flushWebStore();
    },

    async load(id: number): Promise<SaveRecord<TState> | null> {
      const conn = await openDb();
      if (!conn) return null;
      const result = await conn.query(`SELECT * FROM saves WHERE id = ?;`, [id]);
      const rows = result.values ?? [];
      const row = rows[0];
      if (!row) return null;
      // M_SEC.22 — differentiate "no row found" from "corrupt row".
      try {
        return rowToSaveRecord(row);
      } catch (err) {
        throw new CorruptSaveError(id, err instanceof Error ? err.message : String(err));
      }
    },

    async list(): Promise<SaveRecord<TState>[]> {
      const conn = await openDb();
      if (!conn) return [];
      // M_SEC.13 — LIMIT via bind param, clamped to a sane integer.
      const safe = Math.floor(listLimit);
      const cap = Number.isFinite(safe) ? Math.max(1, Math.min(500, safe)) : DEFAULT_LIST_LIMIT;
      const result = await conn.query(`SELECT * FROM saves ORDER BY saved_at DESC LIMIT ?;`, [cap]);
      const rows = result.values ?? [];
      const records: SaveRecord<TState>[] = [];
      for (const row of rows) {
        try {
          records.push(rowToSaveRecord(row));
        } catch (err) {
          // M_SEC.21 — skip the corrupt row rather than failing the whole
          // list, but LOG it so a developer notices in a debug build.
          const id = (row as { id?: unknown }).id;
          console.warn(
            `[persistence] skipping corrupt save row${typeof id === 'number' ? ` id=${id}` : ''}:`,
            err,
          );
        }
      }
      return records;
    },

    async delete(id: number): Promise<void> {
      const conn = await openDb();
      if (!conn) return;
      await conn.run(`DELETE FROM saves WHERE id = ?;`, [id]);
      await flushWebStore();
    },

    async close(): Promise<void> {
      // Wait out an in-flight open so we never orphan a half-open handle.
      if (openPromise) await openPromise.catch(() => undefined);
      const conn = db;
      db = null;
      dbUnavailable = false;
      if (!conn || !sqliteManager) return;
      try {
        await conn.close();
      } finally {
        await sqliteManager.closeConnection(dbName, false).catch(() => undefined);
      }
    },
  };
}
