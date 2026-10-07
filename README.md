# persistence-save

[![npm](https://img.shields.io/npm/v/persistence-save.svg)](https://www.npmjs.com/package/persistence-save)
[![CI](https://github.com/jbcom/persistence-save/actions/workflows/ci.yml/badge.svg)](https://github.com/jbcom/persistence-save/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Save-game persistence for [Capacitor](https://capacitorjs.com) games. One API
stores saves in SQLite on every platform: [jeep-sqlite](https://www.npmjs.com/package/jeep-sqlite-current-sqljs)
over [sql.js](https://sql.js.org) and IndexedDB on the web, and native SQLite
(optionally SQLCipher-encrypted) on iOS and Android.

- **A save/load/list/delete facade** over `@capacitor-community/sqlite`, opened
  lazily and isolating corrupt rows instead of failing the whole list.
- **Chained snapshot migrations**: pure `N → N+1` steps that are validated, frozen
  and walked to the exact target version, so old saves load safely.
- **An autosave scheduler** with debounce, a leading-edge throttle and re-entrant
  suppression, for games that save every tick.
- **A namespaced key-value bridge** over `@capacitor/preferences` for small
  settings.
- **The matching sql.js WebAssembly binaries**, shipped as package assets.

[Documentation](https://jonbogaty.com/persistence-save/) ·
[API](docs/API.md) · [Architecture](docs/ARCHITECTURE.md) ·
[Changelog](CHANGELOG.md)

## Install

```sh
npm install persistence-save @capacitor/core @capacitor-community/sqlite @capacitor/preferences
```

The three Capacitor packages are peer dependencies. The 0.2 line is verified
against `@capacitor/core` 8.5, `@capacitor-community/sqlite` 8.1 and
`@capacitor/preferences` 8.0. Node.js 22, 24 and 26 are supported.

On the web, copy both WebAssembly assets into the directory you pass as
`wasmAssetsPath` (for example with your bundler's static-copy step):

```text
node_modules/persistence-save/dist/assets/sql-wasm.wasm
node_modules/persistence-save/dist/assets/sql-wasm-browser.wasm
```

They are also exported as `persistence-save/assets/sql-wasm.wasm` and
`persistence-save/assets/sql-wasm-browser.wasm`.

## Quick start

```ts
import { createPersistence } from 'persistence-save';

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

await saves.save('Slot 1', { name: 'Player One', gold: 7 });
const [latest] = await saves.list(); // newest first; corrupt rows are isolated, not thrown
const record = latest ? await saves.load(latest.id) : null;
console.log(record?.snapshot.gold); // 7
```

### Migrations

Every source version, target version and migration output is a safe integer.
Each migration receives a deeply frozen clone and is a pure `N → N+1` step.
Mutation attempts, null or non-object output, skips, overshoots, fractions, and
a walk that does not end exactly at the target are rejected as typed version
errors. Reading an older save migrates it in memory without rewriting the stored
row; only an explicit `save()` writes the current format.

`serialize()` is validated before SQLite is opened: it must return a non-array
object whose version exactly equals `snapshotVersion`. Snapshot size caps are
measured in UTF-8 bytes on both read and write.

### Sharing the connection

Games with their own SQLite tables can pass an idempotent
`initializeSchema(connection)` callback and use `withConnection()` and `flush()`
for their own statements. This keeps one connection manager and one web-store
flush path. `encryptionKeyPreference` keeps an existing native SQLCipher key
name when you adopt the package in a game that already encrypts its database.

### Settings

Preferences store strings, so serialize structured values explicitly, and always
use a stable reverse-domain namespace:

```ts
import { createPreferencesKv } from 'persistence-save';

const settings = createPreferencesKv('com.example.game');
await settings.set('audio.muted', 'false');
```

### Autosave

```ts
import { createAutoSaveScheduler } from 'persistence-save';

const autosave = createAutoSaveScheduler({
  provider: () => (inMenu ? null : currentState()), // null skips the write
  save: (state) => saves.save('AutoSave', state),
  debounceMs: 400,
});

autosave.schedule(); // after a mutation; bursts coalesce into one write
autosave.scheduleThrottled('player.health', 2_000); // per-frame callers
addEventListener('pagehide', () => void autosave.flush());
```

See the [API reference](docs/API.md) for every option.

## Development

```sh
mise install            # or: npm install --global corepack && corepack enable
pnpm install
pnpm verify
```

`pnpm verify` runs Biome, markdownlint, strict TypeScript, the tests with
coverage, the ESM, CommonJS and type builds, `publint`, Are The Types Wrong, and
a packed-consumer proof. That proof packs the package, installs the tarball with
the exact Capacitor peers into a clean project with an empty home directory and
only the public registry, then runs the ESM and CommonJS entry points,
typechecks a separately written consumer, and compiles both WebAssembly assets.
Set `PERSISTENCE_SAVE_CONSUMER_SOURCE=persistence-save@<version>` to run the same
proof against a published version.

See [CONTRIBUTING.md](CONTRIBUTING.md). Releases are automated with Release
Please and published to npm with provenance.

## License

[MIT](LICENSE). The bundled sql.js WebAssembly binaries are MIT-licensed by the
sql.js authors; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
