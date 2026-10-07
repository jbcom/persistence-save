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
`@capacitor-community/sqlite` 8.1.1, and `@capacitor/preferences` 8.0.1.
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

## Install

```sh
pnpm add @arcade-cabinet/persistence-save @capacitor/core @capacitor-community/sqlite @capacitor/preferences
```

The package is served by the `arcade-cabinet` Gitea registry on the private
VPN. Reads are anonymous; the consumer only needs the scope mapped:

```ini
@arcade-cabinet:registry=https://registry.npmjs.org/
```

The engine floor is Node 24.19.0 with no ceiling: fleet games on Node 24 and
Node 26 both consume it.

## Development

This repository is the package's only home. It was extracted from
`Aethelgard-Chronicles-of-Strata/packages/persistence-save` on 2026-10-07 with its
history, so that no game is a dependency of a shared package; games prove the
package by installing it from the registry.

Built on the fleet toolchain, Node 26 (`.node-version`) and pnpm 12
(`packageManager`, through Corepack):

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm verify   # Biome, tsc, Vitest, then the packed-consumer proof
```

`pnpm test:consumer` packs the package with npm's publish packer, checks the
tarball carries the license, the sql.js third-party notice and both WASM assets,
then installs it with the exact Capacitor peers into a clean non-workspace
directory under an anonymous HOME (no registry credential can leak in). There it
exercises the ESM and CommonJS entry points, typechecks a separately authored
consumer, and compiles both exported WebAssembly assets. Set
`PERSISTENCE_SAVE_CONSUMER_SOURCE=@arcade-cabinet/persistence-save@<version>` to
run the same proof against a published version instead of the local tarball.

## Release

Conventional Commits drive release-please (`.gitea/workflows/release.yml`). Merging
its release pull request tags `v<version>`; the publish job then re-runs
`pnpm verify` on the tag, publishes with the CI organisation secret
`NPM_TOKEN` (Gitea's per-run Actions token cannot write packages),
and finally runs the consumer proof anonymously against the version it just
published. Never edit the `version` field by hand.

Aethelgard-Chronicles-of-Strata dogfoods the package and owns the headed
jeep-sqlite save/reload proof.
