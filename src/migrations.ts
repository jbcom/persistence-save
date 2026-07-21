/**
 * Snapshot migration framework — the chained N→N+1 walker extracted from
 * Aethelgard-Chronicles-of-Strata's `serialize-game.ts` (M_AUDIT2.ARCH.36).
 *
 * Migration authors write pure `(oldSnap) => newSnap` functions keyed by the
 * version int they migrate FROM. `migrateSnapshot` walks the chain from
 * `snap.version` up to `targetVersion`, applying every entry along the way,
 * and hard-fails on gaps and on future versions — corruption and skew must
 * never be silently "handled".
 */

/** Every snapshot a Persistence store round-trips must carry a version int. */
export interface VersionedSnapshot {
  /** Snapshot format version — bumped on any breaking schema change. */
  version: number;
}

/**
 * One migration step: takes a snapshot at version N and returns one at
 * version N+1. Must be pure (no I/O, no mutation of the input) and MUST
 * set `version` on its output to a value strictly greater than its input
 * — the walker enforces this to rule out infinite loops from a buggy entry.
 */
export type SnapshotMigration = (snap: Record<string, unknown>) => Record<string, unknown>;

/** Migration table: `{ 1: v1→v2, 2: v2→v3, ... }` keyed by the FROM version. */
export type MigrationTable = Record<number, SnapshotMigration>;

/**
 * Thrown when a snapshot cannot be walked to `targetVersion`: unknown /
 * non-numeric version, a version from the future (newer app wrote it), a
 * gap in the migration table, or a migration that failed to advance the
 * version. Callers surface this as save corruption / version skew — they
 * must NOT fall back to loading the raw snapshot.
 */
export class SnapshotVersionError extends Error {
  constructor(
    /** The version the walk failed at. */
    public readonly version: number,
    /** The version the walk was trying to reach. */
    public readonly targetVersion: number,
    reason: string,
  ) {
    super(`snapshot version ${version} → ${targetVersion}: ${reason}`);
    this.name = 'SnapshotVersionError';
  }
}

/**
 * Walk `snap` from its own `version` up to `targetVersion` through
 * `migrations`. Returns the migrated snapshot (the input object is never
 * mutated). Throws {@link SnapshotVersionError} on:
 *
 * - a missing / non-finite `version` field,
 * - `version > targetVersion` (snapshot from a future app version),
 * - a gap in the table (no entry for a version on the path),
 * - a migration whose output version did not strictly increase.
 */
export function migrateSnapshot(
  snap: Record<string, unknown>,
  targetVersion: number,
  migrations: MigrationTable,
): Record<string, unknown> {
  const initial = snap.version;
  if (typeof initial !== 'number' || !Number.isFinite(initial)) {
    throw new SnapshotVersionError(Number.NaN, targetVersion, 'snapshot has no numeric version');
  }
  if (initial > targetVersion) {
    throw new SnapshotVersionError(
      initial,
      targetVersion,
      'snapshot is from a newer app version (no downgrade path)',
    );
  }
  let current = snap;
  let version = initial;
  while (version < targetVersion) {
    const migrate = migrations[version];
    if (!migrate) {
      throw new SnapshotVersionError(version, targetVersion, 'no migration registered');
    }
    current = migrate(current);
    const next = current.version;
    if (typeof next !== 'number' || !Number.isFinite(next) || next <= version) {
      throw new SnapshotVersionError(
        version,
        targetVersion,
        `migration did not advance the version (got ${String(next)})`,
      );
    }
    version = next;
  }
  return current;
}
