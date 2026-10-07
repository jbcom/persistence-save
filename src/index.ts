/**
 * persistence-save — save-game persistence for Capacitor games.
 *
 * - {@link createPersistence} — SQLite-backed save/load/list/delete over
 *   `@capacitor-community/sqlite` (jeep-sqlite/sql.js on web, native SQLite
 *   + optional SQLCipher on device) with a chained snapshot-migration walker
 *   and corrupt-save isolation.
 * - {@link createPreferencesKv} — the localStorage → Capacitor Preferences
 *   swap-policy bridge for small KV settings.
 * - {@link createAutoSaveScheduler} — debounce/throttle/suppress companion
 *   for high-frequency autosave callers.
 */

export {
  type AutoSaveScheduler,
  type AutoSaveSchedulerOptions,
  createAutoSaveScheduler,
} from './autosave.js';
export {
  type MigrationTable,
  migrateSnapshot,
  type SnapshotMigration,
  SnapshotVersionError,
  type VersionedSnapshot,
} from './migrations.js';
export {
  CorruptSaveError,
  createPersistence,
  type Persistence,
  type PersistenceConfig,
  type SaveRecord,
} from './persistence.js';
export {
  createPreferencesKv,
  type PreferencesKv,
} from './preferences-kv.js';
