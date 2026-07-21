import { describe, expect, it } from 'vitest';
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

  it('hard-fails on a missing or non-numeric version field', () => {
    expect(() => migrateSnapshot({}, 4, CHAIN)).toThrow(/no numeric version/);
    expect(() => migrateSnapshot({ version: 'v1' }, 4, CHAIN)).toThrow(SnapshotVersionError);
    expect(() => migrateSnapshot({ version: Number.NaN }, 4, CHAIN)).toThrow(SnapshotVersionError);
  });

  it('hard-fails when a migration does not advance the version (loop guard)', () => {
    const stuck: MigrationTable = { 1: (snap) => ({ ...snap }) };
    expect(() => migrateSnapshot({ version: 1 }, 2, stuck)).toThrow(/did not advance/);
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

  it('supports a migration that jumps multiple versions at once', () => {
    const jumping: MigrationTable = {
      1: (snap) => ({ ...snap, version: 3 }),
      3: CHAIN[3] as NonNullable<MigrationTable[number]>,
    };
    const out = migrateSnapshot({ version: 1 }, 4, jumping);
    expect(out.version).toBe(4);
  });
});
