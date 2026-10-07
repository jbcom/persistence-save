---
title: Architecture
description: The modules, the invariants they protect, and where the boundaries are.
---

## Modules

| Module | Owns |
| --- | --- |
| `src/persistence.ts` | The connection manager (one per store, opened lazily), the `saves` table, the SQLCipher key, the web-store flush, and the save/load/list/delete facade. |
| `src/migrations.ts` | The pure snapshot walker and `SnapshotVersionError`. No I/O. |
| `src/autosave.ts` | The instanced autosave scheduler. No module-level state. |
| `src/preferences-kv.ts` | The namespaced Preferences bridge. |
| `src/index.ts` | The public surface. Nothing else is exported. |

`scripts/copy-wasm.mjs` copies the sql.js binaries into `dist/assets` at build
time; `scripts/verify-packed-consumer.mjs` is the packed-tarball proof.

ESM and CommonJS exports have separate declarations matching their module kind.
The CommonJS declarations inherit `dist/cjs/package.json`'s `type: commonjs`.
Are The Types Wrong checks JavaScript and JSON entrypoints; `.attw.json` excludes
only the two binary WASM assets, whose paths, bytes and compilation are checked
by the packed consumer instead. That consumer typechecks both `.ts` and `.cts`.

## Invariants

These are why the package exists. A change that breaks one reintroduces the bug
it was built to prevent.

1. **Every statement is parameterized.** No SQL is built from strings.
2. **Corruption is never "no save".** `load()` returns `null` only when the row is
   absent; any failure to parse, migrate or deserialize an existing row throws
   `CorruptSaveError`. `list()` skips corrupt rows one at a time instead of
   failing the list.
3. **Migrations are exact.** Pure `N → N+1` steps over a frozen clone, ending
   exactly on the target; anything else is a typed error, never a guess.
4. **Reads never write.** Migrating a stored snapshot happens in memory; only
   `save()` writes the current format.
5. **Inputs are bounded before they are trusted.** Snapshot bytes are capped
   before `JSON.parse`, names are capped, and row counts are capped on write and
   on list.
6. **The web store is durable when a write resolves.** Every write flushes the
   in-memory sql.js database to IndexedDB before its promise resolves, and flush
   failures propagate.
7. **Encryption fails closed.** Without WebCrypto there is no key generation and
   therefore no encrypted database, rather than a weak key.
8. **One connection manager.** Games extend the database through
   `initializeSchema` and `withConnection` on the same connection; the package
   never opens a second one.

## Platform boundary

`@capacitor-community/sqlite` provides the native connection on iOS and Android
and drives the jeep-sqlite web component on the web. persistence-save registers
that component (from `jeep-sqlite-current-sqljs`) on first use in a browser and
points it at `wasmAssetsPath`. Capacitor packages are peers, so a game controls
their versions; the sql.js and jeep-sqlite versions are pinned here because the
WebAssembly binaries must match them exactly.
