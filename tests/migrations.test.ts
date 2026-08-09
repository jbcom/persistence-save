import { describe, expect, it, vi } from 'vitest';
import { type MigrationTable, migrateSnapshot, SnapshotVersionError } from '../src/migrations.js';

const CHAIN: MigrationTable = {
  1: (snap) => ({ ...snap, version: 2, wildfires: [] }),
  2: (snap) => ({ ...snap, version: 3 }),
  3: (snap) => ({ ...snap, version: 4, renamed: true }),
};

describe('migrateSnapshot', () => {
  it('walks the full chain from v1 to the target version', () => {
    const out = migrateSnapshot({ version: 1, seed: 'abc' }, 4, CHAIN);
    expect(out).toEqual({ version: 4, seed: 'abc', wildfires: [], renamed: true });
  });

  it('applies only the remaining steps for a mid-chain version', () => {
    const out = migrateSnapshot({ version: 3, seed: 'abc' }, 4, CHAIN);
    expect(out).toEqual({ version: 4, seed: 'abc', renamed: true });
    expect(out).not.toHaveProperty('wildfires');
  });

  it('returns the snapshot untouched when already at the target version', () => {
    const snap = { version: 4, seed: 'abc' };
    const out = migrateSnapshot(snap, 4, CHAIN);
    expect(out).toBe(snap);
  });

  it('never mutates the input snapshot', () => {
    const snap = { version: 1, seed: 'abc' };
    migrateSnapshot(snap, 4, CHAIN);
    expect(snap).toEqual({ version: 1, seed: 'abc' });
  });

  it('rejects a mutating migration without changing the caller snapshot', () => {
    const snap = { version: 1, nested: { hp: 10 } };
    const hostile: MigrationTable = {
      1: (input) => {
        (input.nested as { hp: number }).hp = 0;
        input.version = 2;
        return input;
      },
    };

    expect(() => migrateSnapshot(snap, 2, hostile)).toThrow(SnapshotVersionError);
    expect(snap).toEqual({ version: 1, nested: { hp: 10 } });
  });

  it.each([null, undefined, [], 2, 'version-two'])(
    'rejects a migration that returns hostile output %s as a typed error',
    (output) => {
      const hostile: MigrationTable = {
        1: () => output as unknown as Record<string, unknown>,
      };
      expect(() => migrateSnapshot({ version: 1 }, 2, hostile)).toThrow(SnapshotVersionError);
      expect(() => migrateSnapshot({ version: 1 }, 2, hostile)).toThrow(
        /must produce a snapshot object/,
      );
    },
  );

  it('rejects unsafe versions without entering the migration loop', () => {
    const unsafe = Number.MAX_SAFE_INTEGER + 1;
    const migration = vi.fn((snap: Record<string, unknown>) => ({ ...snap, version: unsafe }));

    expect(() => migrateSnapshot({ version: unsafe }, unsafe + 2, { [unsafe]: migration })).toThrow(
      /safe integer/,
    );
    expect(migration).not.toHaveBeenCalled();
  });

  it('preserves the exact serialized bytes of a frozen legacy snapshot', () => {
    const legacy = {
      version: 1,
      seed: 'ember-vale',
      party: { knight: { hp: 41 }, hunter: { arrows: 7 } },
      discovered: ['millhaven', 'north-road'],
    };
    const legacyBytes = JSON.stringify(legacy);

    const migrated = migrateSnapshot(legacy, 4, CHAIN);

    expect(JSON.stringify(legacy)).toBe(legacyBytes);
    expect(migrated).toMatchObject({
      version: 4,
      seed: 'ember-vale',
      party: legacy.party,
      discovered: legacy.discovered,
      wildfires: [],
      renamed: true,
    });
  });

  it('hard-fails on a future version (no downgrade path)', () => {
    expect(() => migrateSnapshot({ version: 5 }, 4, CHAIN)).toThrow(SnapshotVersionError);
    expect(() => migrateSnapshot({ version: 5 }, 4, CHAIN)).toThrow(/newer app version/);
  });

  it('hard-fails on a gap in the migration table', () => {
    const gappy: MigrationTable = {
      1: CHAIN[1] as NonNullable<MigrationTable[number]>,
      3: CHAIN[3] as NonNullable<MigrationTable[number]>,
    };
    expect(() => migrateSnapshot({ version: 1 }, 4, gappy)).toThrow(SnapshotVersionError);
    expect(() => migrateSnapshot({ version: 1 }, 4, gappy)).toThrow(/no migration registered/);
  });

  it('hard-fails on a missing or non-integer version field', () => {
    expect(() => migrateSnapshot({}, 4, CHAIN)).toThrow(/no safe integer version/);
    expect(() => migrateSnapshot({ version: 'v1' }, 4, CHAIN)).toThrow(SnapshotVersionError);
    expect(() => migrateSnapshot({ version: Number.NaN }, 4, CHAIN)).toThrow(SnapshotVersionError);
    expect(() => migrateSnapshot({ version: 1.5 }, 4, CHAIN)).toThrow(/safe integer version/);
  });

  it('hard-fails when a migration does not advance exactly one version', () => {
    const stuck: MigrationTable = { 1: (snap) => ({ ...snap }) };
    expect(() => migrateSnapshot({ version: 1 }, 2, stuck)).toThrow(/advance exactly one version/);
  });

  it('carries error metadata on SnapshotVersionError', () => {
    try {
      migrateSnapshot({ version: 9 }, 4, CHAIN);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SnapshotVersionError);
      const e = err as SnapshotVersionError;
      expect(e.version).toBe(9);
      expect(e.targetVersion).toBe(4);
      expect(e.name).toBe('SnapshotVersionError');
    }
  });

  it.each([
    ['skipped successor', 3],
    ['unrelated high version', 99],
    ['fractional version', 1.5],
    ['NaN version', Number.NaN],
  ])('rejects a migration that emits a %s', (_label, emittedVersion) => {
    const hostile: MigrationTable = {
      1: (snap) => ({ ...snap, version: emittedVersion }),
    };
    expect(() => migrateSnapshot({ version: 1 }, 4, hostile)).toThrow(SnapshotVersionError);
  });

  it('rejects a wrong final version instead of accepting an overshot target', () => {
    const wrongFinal: MigrationTable = {
      3: (snap) => ({ ...snap, version: 5 }),
    };
    expect(() => migrateSnapshot({ version: 3 }, 4, wrongFinal)).toThrow(
      /advance exactly one version to 4/,
    );
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 4.5])(
    'rejects invalid target version %s',
    (targetVersion) => {
      expect(() => migrateSnapshot({ version: 1 }, targetVersion, CHAIN)).toThrow(
        /target version must be a safe integer/,
      );
    },
  );

  it('accepts a complete chain whose safe integer steps end exactly at the target', () => {
    const out = migrateSnapshot({ version: 1, seed: 'exact-chain' }, 4, CHAIN);
    expect(out).toEqual({
      version: 4,
      seed: 'exact-chain',
      wildfires: [],
      renamed: true,
    });
  });
});
