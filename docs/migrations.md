---
title: Migrations
description: Evolve a save format with pure, validated N to N+1 steps.
---

Every snapshot carries a `version`. When you change the shape of your save,
bump `snapshotVersion` and add one migration keyed by the version it migrates
**from**:

```ts
const saves = createPersistence<State, Snapshot>({
  dbName: 'com.example.game_v1',
  snapshotVersion: 3,
  serialize: (state) => ({ version: 3, ...state }),
  deserialize: (snap) => fromSnapshot(snap),
  migrations: {
    1: (old) => ({ ...old, version: 2, gold: old.gold ?? 0 }),
    2: (old) => ({ ...old, version: 3, party: [] }),
  },
});
```

Loading a version 1 save walks `1 → 2 → 3`, then calls `deserialize`.

## The rules

The walker rejects anything that is not a pure, exact, one-step migration, with
a typed `SnapshotVersionError`:

- source, target and output versions must be safe integers;
- each step must return a non-null, non-array object whose version is exactly
  the next integer: no skips, no overshoots, no fractions;
- each step receives a deeply frozen clone, so mutating its input throws;
- a gap in the table, or a snapshot from a newer build than this one, fails
  instead of being silently "handled";
- the walk must end exactly on `snapshotVersion`.

## Reading does not rewrite

Loading an old save migrates it in memory only. The stored row keeps its old
format until your game calls `save()` again, which writes the current format.
A failed migration therefore never damages the row on disk.

## Using the walker directly

`migrateSnapshot(snapshot, targetVersion, migrations)` is exported for data that
does not live in the save table, such as an imported or cloud-synced snapshot.
