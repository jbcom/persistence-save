---
title: API reference
description: Every export of persistence-save, with its options and errors.
---

Everything is exported from the package root, under ESM and CommonJS, with
types. The two WebAssembly assets are subpath exports; see
[Web assets](./web-assets/).

## `createPersistence<TState, TSnapshot>(config)`

Returns a `Persistence<TState>`. Synchronous; opens nothing until first use.

### `PersistenceConfig<TState, TSnapshot extends VersionedSnapshot>`

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `dbName` | `string` | required | SQLite database name. Namespace it (`com.example.game_v1`); a bare app name collides with other apps on the same web origin. |
| `dbVersion` | `number` | `1` | Capacitor SQLite connection version. |
| `snapshotVersion` | `number` | required | The version `serialize` emits and the migration walker's target. |
| `serialize` | `(state: TState) => TSnapshot` | required | Must return a non-array object with `version === snapshotVersion`; checked before SQLite opens. |
| `deserialize` | `(snap: TSnapshot) => TState` | required | Turns a migrated snapshot into live state. |
| `migrations` | `MigrationTable` | required | `N → N+1` steps keyed by source version. See [Migrations](./migrations/). |
| `encrypted` | `boolean` | `false` | SQLCipher on iOS and Android with a per-install key. Ignored on web. |
| `encryptionKeyPreference` | `string` | `<dbName>.dbKey` | Preferences key for the SQLCipher passphrase; set only to keep an existing key. |
| `seedPhraseOf` | `(state: TState) => string` | `() => ''` | Value stored in each row's `seedPhrase` column. |
| `maxSaves` | `number` | `100` | Row cap; the oldest rows past it are pruned after each save. |
| `listLimit` | `number` | `50` | Row cap on `list()`, clamped to 1–500. |
| `maxSnapshotBytes` | `number` | 2 MiB | Snapshot JSON cap in UTF-8 bytes, on write and on read (before parsing). |
| `wasmAssetsPath` | `string` | `/assets` | Where the web build serves the sql.js WebAssembly. |
| `initializeSchema` | `(connection: SQLiteDBConnection) => Promise<void>` | none | Idempotent setup for your own tables, run on the same connection after the `saves` table exists. |

### `Persistence<TState>`

| Method | Returns | Behaviour |
| --- | --- | --- |
| `save(name, state)` | `Promise<void>` | UPSERT by name, prune past `maxSaves`, flush the web store, then resolve. Names are capped at 256 characters. |
| `load(id)` | `Promise<SaveRecord<TState> \| null>` | `null` when no row; throws `CorruptSaveError` when the row cannot be parsed, migrated or deserialized. |
| `list()` | `Promise<SaveRecord<TState>[]>` | Newest first, at most `listLimit`; corrupt rows are skipped and logged individually. |
| `delete(id)` | `Promise<void>` | No-op when absent. |
| `withConnection(operation, fallback)` | `Promise<TResult>` | Runs your operation on the live connection; returns `fallback` where SQLite is unavailable. |
| `flush()` | `Promise<void>` | Flushes writes made through `withConnection` to the web store. |
| `close()` | `Promise<void>` | Closes the connection; later calls reopen it. |

### `SaveRecord<TState>`

`{ id: number; name: string; seedPhrase: string; savedAt: string; snapshot: TState }`,
where `savedAt` is an ISO timestamp and `snapshot` is already migrated and
deserialized.

### `CorruptSaveError`

Thrown by `load()`. Has `recordId: number` and `cause: string`.

## Migrations

- `migrateSnapshot(snapshot, targetVersion, migrations)` walks a snapshot to
  `targetVersion` and returns the migrated copy; the input is never mutated.
- `type SnapshotMigration = (snap: Record<string, unknown>) => Record<string, unknown>`
- `type MigrationTable = Record<number, SnapshotMigration>`
- `interface VersionedSnapshot { version: number }`
- `SnapshotVersionError` has `version` (where the walk failed) and
  `targetVersion`.

## `createAutoSaveScheduler<TData>(options)`

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `provider` | `() => TData \| null` | required | The data to write, or `null` to skip (menu, mid-load). |
| `save` | `(data: TData) => Promise<void>` | required | The write, for example `(d) => saves.save('AutoSave', d)`. |
| `debounceMs` | `number` | `400` | Window that coalesces bursts. |
| `onError` | `(err: unknown) => void` | `console.error` | Background save failures; awaited `flush()` failures reject instead. |

The returned `AutoSaveScheduler`:

| Method | Behaviour |
| --- | --- |
| `schedule()` | Queue a debounced save. |
| `scheduleThrottled(key, windowMs)` | Leading-edge throttle per `key` for per-frame callers; throws on a non-positive or non-finite window. |
| `flush()` | Save now, cancelling any pending debounce. Use on `pagehide` and in tests. |
| `suppress(fn)` | Run `fn` with autosave suppressed; re-entrant. Wrap state restores. |
| `cancel()` | Drop a pending debounced save. |
| `resetThrottle()` | Clear every throttle window, for example on session reset. |

## `createPreferencesKv(namespace)`

Returns a `PreferencesKv` whose keys are stored as `<namespace>.<key>`. The
namespace must be non-empty.

| Method | Behaviour |
| --- | --- |
| `get(key)` | The string value, or `null`. |
| `set(key, value)` | Write a string. |
| `remove(key)` | Remove; no-op when absent. |
| `clear()` | Remove only this namespace's keys. |
| `keys()` | This namespace's keys, prefix stripped. |
| `getParsed(key, parse, fallback)` | Parse the value; on a read failure or a parser throw, log and return `fallback`. Never rejects. |
