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
| `maxSaves` | `number` | `100` | Ordinary-save row cap; the oldest rows past it are pruned after each save. |
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
| `createSnapshot(name, state)` | `Promise<SaveRecord<TState>>` | Insert an immutable named snapshot, then flush. Reject duplicates, invalid names and unavailable storage. Never pruned by ordinary saves. |
| `loadSnapshot(name)` | `Promise<SaveRecord<TState> \| null>` | Exact-name lookup; absence returns `null`; corruption and unavailable storage throw. |
| `listSnapshots(options?)` | `Promise<SaveRecord<TState>[]>` | Snapshot page newest id first; corruption and unavailable storage throw. |
| `delete(id)` | `Promise<void>` | Deletes only an ordinary save; no-op when absent. |
| `withConnection(operation, fallback)` | `Promise<TResult>` | Runs your operation on the live connection; returns `fallback` where SQLite is unavailable. |
| `flush()` | `Promise<void>` | Flushes writes made through `withConnection` to the web store. |
| `close()` | `Promise<void>` | Closes the connection; later calls reopen it. |

### Immutable snapshots

Snapshots occupy a separate `snapshots` table and name namespace. SQLite's unique
name constraint atomically arbitrates concurrent writers: one inserts, the rest
throw `SnapshotExistsError` with `snapshotName`. Existing bytes never change.
Names must contain 1–256 UTF-16 code units (JavaScript `string.length`); longer
names reject rather than truncate.
There is no snapshot overwrite or deletion API, and `maxSaves`, `save()` and
`delete()` never affect snapshots. Snapshots can grow until storage is full;
the application chooses when preservation is needed.

`SnapshotListOptions` accepts `limit` (integer 1–500, default `listLimit`) and
`beforeId` (positive safe integer, exclusive). Pass the last record's id as the
next cursor until an empty page. Snapshot ids belong to their own table.

Both save kinds use the same serializer, migrations, UTF-8 byte cap, encryption
and connection. On web, `createSnapshot` resolves only after IndexedDB flush;
on native, the SQLite insert commits before resolution. If flushing rejects,
durability is uncertain and the in-memory row may still exist. Keep the active
state intact. A retry can load the exact immutable name, verify its expected
content, and await `flush()` before treating preservation as successful; trying
to create that name again cannot overwrite it.

### `SaveRecord<TState>`

`{ id: number; name: string; seedPhrase: string; savedAt: string; snapshot: TState }`,
where `savedAt` is an ISO timestamp and `snapshot` is already migrated and
deserialized.

### `CorruptSaveError`

Thrown by `load()`, `loadSnapshot()` and `listSnapshots()`. Has `recordId: number` and `cause: string`.

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
| `onError` | `(err: unknown) => void` | `console.error` | Background save failures; awaited `flush()` and `flushPending()` failures reject instead. |

The returned `AutoSaveScheduler`:

| Method | Behaviour |
| --- | --- |
| `schedule()` | Queue a debounced save. |
| `scheduleThrottled(key, windowMs)` | Leading-edge throttle per `key` for per-frame callers; throws on a non-positive or non-finite window. |
| `flush()` | Save now, cancelling any pending debounce. Use on `pagehide` and in tests. |
| `flushPending()` | Save now only if a debounced or throttled save is pending, cancelling its timer so no duplicate trails; otherwise resolve without calling `provider` or `save`. Use to wait for saves already asked for (tests, unmount) without making one. Suppression, a `null` provider and rejections behave as in `flush()`. A save whose timer has already fired is not awaited. |
| `pending` | Read-only `boolean`: `true` while a debounced or throttled save is queued. A suppressed `schedule()` or a throttled call inside its window leaves it unchanged; `cancel()`, `flush()`, `flushPending()` and the timer firing clear it. |
| `suppress(fn)` | Run `fn` with autosave suppressed; re-entrant. Wrap state restores. |
| `cancel()` | Drop a pending debounced save. |
| `resetThrottle()` | Clear every throttle window, for example on session reset. |

## `createPreferencesKv(namespace)`

Returns a `PreferencesKv` whose keys are stored as `<namespace>.<key>`. The
namespace must be non-empty. Existing native Preferences values remain in
Preferences and are not migrated by this factory.

| Method | Behaviour |
| --- | --- |
| `get(key)` | The string value, or `null`. |
| `set(key, value)` | Write a string. |
| `remove(key)` | Remove; no-op when absent. |
| `clear()` | Remove only this namespace's keys. |
| `keys()` | This namespace's keys, prefix stripped. |
| `getParsed(key, parse, fallback)` | Parse the value; on a read failure or a parser throw, log and return `fallback`. Never rejects. |

## `createAtomicPreferencesKv(namespace)`

Returns an `AtomicPreferencesKv`, with the ordinary KV methods plus
`update(key, reduce)`. A synchronous reducer receives the latest stored string
(or `null`), writes its string result (or removes on `null`), verifies it, and
returns the committed value. A thrown reducer writes nothing. Reducers must not
return promises or perform storage operations.

### Atomic web updates

All package `set`, `remove`, `clear` and `update` calls share an exclusive
origin-wide Preferences mutation lock across same-origin tabs and workers. Failed writes or
verification restore and verify the prior value before releasing the lock; if
restoration fails, an `AggregateError` reports uncertain storage. `update`
rejects before reading or writing when Web Locks are unavailable (including
insecure web contexts). Ordinary setters use a realm-local queue as fallback.

### Atomic native updates

The atomic factory uses a dedicated SQLite database on native Capacitor, with
`BEGIN IMMEDIATE` read/reduce/write/verify/commit transactions. A shared queue
protects the connection in one JavaScript realm; SQLite's writer lock and a
five-second busy timeout coordinate independent connections and processes.
Failures before commit roll back. A failed commit acknowledgement can leave
uncertain storage; a failed rollback is reported with `AggregateError`, never
by writing compensating old values over another committed transaction.

Native reads first query the atomic table, falling back to the existing
namespaced Preferences key only if no row exists. The first write migrates only
that addressed key. Removes and clears store NULL tombstones, so old Preferences
values cannot reappear. Legacy Preferences are never erased or rewritten, and
ordinary settings namespaces are untouched. Use the atomic factory for every
reader and writer of keys that adopt this backend; the ordinary native factory
continues reading Preferences and cannot see migrated SQLite values.

### Coordination limits

Do not write the same keys through raw Preferences, localStorage or older
package versions: those writers do not participate. Reads and `getParsed`
remain read-only and may observe a pending web attempt before its promise
resolves. Browser termination or storage failure can leave uncertain bytes;
the web contract is coordination, not a durable multi-key transaction. Native
storage availability and lock-timeout errors reject rather than discarding
history. Device integration must still be verified on the target Capacitor app;
file-backed SQLite driver tests do not establish device acceptance.
