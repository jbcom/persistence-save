---
title: persistence-save
description: Save-game persistence for Capacitor games, on SQLite everywhere.
---

persistence-save stores a game's saves in SQLite on every platform Capacitor
targets. On the web it runs [jeep-sqlite](https://www.npmjs.com/package/jeep-sqlite-current-sqljs)
over [sql.js](https://sql.js.org) and IndexedDB; on iOS and Android it uses the
native SQLite plugin, optionally encrypted with SQLCipher. Your game writes one
code path.

It is deliberately small. It does not model your game state; you give it a
`serialize` and `deserialize` pair and a table of migrations, and it handles the
parts that are easy to get subtly wrong.

## Why use it?

| Problem | persistence-save |
| --- | --- |
| An old save crashes the new build | Chained, validated `N → N+1` snapshot migrations walked to the exact target |
| One corrupt row breaks the whole load screen | `list()` isolates corrupt rows; `load()` throws a typed `CorruptSaveError` |
| A tampered save makes `JSON.parse` hang | Snapshot byte caps on write and read |
| React StrictMode writes a save twice | Saves UPSERT by name |
| The web build loses the last save on reload | The web store is flushed after every write |
| An autosave fires every frame | A scheduler with debounce, throttle and re-entrant suppression |
| Settings keys collide with another app's | A namespaced Preferences key-value bridge |

Start with [Getting started](./getting-started/), read the
[migrations guide](./migrations/), then use the [API reference](./API/) and the
[architecture notes](./ARCHITECTURE/).
