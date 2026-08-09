# @arcade-cabinet/persistence-save

Reusable save-game persistence for Arcade Cabinet games. It provides:

- a lazy SQLite save/load/list/delete facade over
  `@capacitor-community/sqlite`;
- explicit chained snapshot migrations and corrupt-row isolation;
- a namespaced string KV bridge over `@capacitor/preferences`;
- a debounced/throttled autosave scheduler; and
- package-owned `sql.js` WebAssembly assets for the jeep-sqlite web runtime.

## Runtime contract

The 0.2 line is conformed against `@capacitor/core` 8.5.0,
`@capacitor-community/sqlite` 8.1.0, and `@capacitor/preferences` 8.0.1.
Consumers install those peers and copy both exported WASM assets to the
directory passed as `wasmAssetsPath`.

```ts
import { createPersistence } from '@arcade-cabinet/persistence-save';

interface State {
  name: string;
  gold: number;
}

interface Snapshot extends State {
  version: number;
}

const saves = createPersistence<State, Snapshot>({
  dbName: 'com.example.game_v1',
  snapshotVersion: 2,
  serialize: (state) => ({ version: 2, ...state }),
  deserialize: ({ name, gold }) => ({ name, gold }),
  migrations: {
    1: (old) => ({ ...old, version: 2, gold: old.gold ?? 0 }),
  },
});
```

Every source version, target version, and migration output is a safe integer.
Every migration receives a deeply frozen clone and is a pure `N → N+1` step:
mutation attempts, null/non-object output, skips, overshoots, fractions, and a
walk that does not end at the exact target are rejected as typed version
errors. Reading an older save migrates it in memory without rewriting the
stored row. Only an explicit `save()` writes the current snapshot format.

`serialize()` is validated before SQLite is opened: it must return a non-array
object whose safe-integer version exactly equals `snapshotVersion`. Snapshot
caps use UTF-8 bytes on both read and write.

Games with adjacent SQLite tables can provide an idempotent
`initializeSchema(connection)` callback and use `withConnection()` plus
`flush()` for their own operations. This keeps one connection manager and one
web-store flush path. `encryptionKeyPreference` preserves an established
native SQLCipher key name during adoption.

Preferences store strings. Serialize structured values explicitly with JSON,
and always use a stable reverse-domain namespace:

```ts
import { createPreferencesKv } from '@arcade-cabinet/persistence-save';

const settings = createPreferencesKv('com.example.game');
await settings.set('audio.muted', 'false');
```

## Verification

Run with Node 24.18.1, pnpm 11.18.0, and the bundled npm 11.16.0 publish
packer:

```text
pnpm verify
```

The consumer gate is part of the repository `verify:packages` and CI contract.
It uses npm's exact publish packer, inspects the package-local license and
sql.js third-party notice, installs the tarball and exact current Capacitor peers
into a clean non-workspace directory, exercises both ESM and CommonJS
entrypoints, typechecks a separately-authored consumer, and resolves, reads,
validates, and compiles both exported WebAssembly assets. Aethelgard dogfoods
the package and owns the headed jeep-sqlite save/reload proof.
