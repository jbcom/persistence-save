---
title: Getting started
description: Install persistence-save, serve its web assets, and write your first save.
---

## Install

```sh
npm install persistence-save @capacitor/core @capacitor-community/sqlite @capacitor/preferences
```

The Capacitor packages are peers. The 0.2 line is verified against
`@capacitor/core` 8.5, `@capacitor-community/sqlite` 8.1 and
`@capacitor/preferences` 8.0.

## Serve the WebAssembly assets (web only)

The web runtime loads sql.js WebAssembly from the directory you pass as
`wasmAssetsPath` (default `/assets`). Copy both package assets there; see
[Web assets](./web-assets/).

## Create a store

```ts
import { createPersistence } from 'persistence-save';

interface State {
  name: string;
  gold: number;
}

interface Snapshot extends State {
  version: number;
}

export const saves = createPersistence<State, Snapshot>({
  dbName: 'com.example.game_v1',
  snapshotVersion: 1,
  serialize: (state) => ({ version: 1, ...state }),
  deserialize: ({ name, gold }) => ({ name, gold }),
  migrations: {},
});
```

`createPersistence()` is synchronous and opens nothing. The connection opens on
the first call that needs it.

## Save, list, load, delete

```ts
await saves.save('Slot 1', { name: 'Player One', gold: 7 });

const [latest] = await saves.list(); // newest first
if (latest) {
  const record = await saves.load(latest.id); // null when absent
  console.log(record?.snapshot.gold); // 7
  await saves.delete(latest.id);
}
```

`save()` replaces an existing save with the same name. `load()` returns `null`
when no row exists and throws `CorruptSaveError` when the row exists but cannot
be restored, so your resume screen can tell the two apart.

## Encrypt on device

```ts
createPersistence({ ...config, encrypted: true });
```

On iOS and Android this enables SQLCipher with a per-install key minted from
`crypto.getRandomValues` and kept in Capacitor Preferences (the Keychain on iOS,
encrypted shared preferences on Android). The web build ignores it, because
sql.js has no SQLCipher.

## Next

- [Migrations](./migrations/): change your save format without breaking old saves.
- [API reference](./API/): every option and method.
