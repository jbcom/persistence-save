/**
 * Snapshot migration framework — the chained N→N+1 walker extracted from
 * Aethelgard-Chronicles-of-Strata's `serialize-game.ts` (M_AUDIT2.ARCH.36).
 *
 * Migration authors write pure `(oldSnap) => newSnap` functions keyed by the
 * safe integer version they migrate FROM. `migrateSnapshot` walks the chain from
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
 * set `version` on its output to exactly N+1. The walker enforces the exact
 * successor so a buggy entry cannot skip an unexecuted schema transition.
 */
export type SnapshotMigration = (snap: Record<string, unknown>) => Record<string, unknown>;

/** Migration table: `{ 1: v1→v2, 2: v2→v3, ... }` keyed by the FROM version. */
export type MigrationTable = Record<number, SnapshotMigration>;

/**
 * Thrown when a snapshot cannot be walked to `targetVersion`: unknown /
 * non-safe-integer version or target, a version from the future (newer app wrote
 * it), a gap in the migration table, or a migration that did not produce the
 * exact next safe integer version. Callers surface this as save corruption / version skew — they
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneSnapshot(
  snapshot: Record<string, unknown>,
  version: number,
  targetVersion: number,
): Record<string, unknown> {
  try {
    return structuredClone(snapshot) as Record<string, unknown>;
  } catch (error) {
    throw new SnapshotVersionError(
      version,
      targetVersion,
      `snapshot must be structured-cloneable (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

/**
 * Walk `snap` from its own `version` up to `targetVersion` through
 * `migrations`. Returns the migrated snapshot (the input object is never
 * mutated). Throws {@link SnapshotVersionError} on:
 *
 * - a missing / non-safe-integer `version` field or target,
 * - `version > targetVersion` (snapshot from a future app version),
 * - a gap in the table (no entry for a version on the path),
 * - a migration whose output version is not exactly the current version + 1,
 * - a completed walk whose final version does not exactly equal the target.
 */
export function migrateSnapshot(
  snap: Record<string, unknown>,
  targetVersion: number,
  migrations: MigrationTable,
): Record<string, unknown> {
  const initial = isRecord(snap) ? snap.version : undefined;
  if (!Number.isSafeInteger(targetVersion)) {
    throw new SnapshotVersionError(
      typeof initial === 'number' ? initial : Number.NaN,
      targetVersion,
      'target version must be a safe integer',
    );
  }
  if (typeof initial !== 'number' || !Number.isSafeInteger(initial)) {
    throw new SnapshotVersionError(
      Number.NaN,
      targetVersion,
      'snapshot has no safe integer version',
    );
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
    const protectedInput = deepFreeze(cloneSnapshot(current, version, targetVersion));
    let output: unknown;
    try {
      output = migrate(protectedInput);
    } catch (error) {
      throw new SnapshotVersionError(
        version,
        targetVersion,
        `migration threw (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    if (!isRecord(output)) {
      throw new SnapshotVersionError(
        version,
        targetVersion,
        `migration must produce a snapshot object (got ${output === null ? 'null' : typeof output})`,
      );
    }
    const next = output.version;
    const expected = version + 1;
    if (!Number.isSafeInteger(expected) || expected <= version) {
      throw new SnapshotVersionError(
        version,
        targetVersion,
        'migration cannot advance beyond the safe-integer range',
      );
    }
    if (typeof next !== 'number' || !Number.isSafeInteger(next)) {
      throw new SnapshotVersionError(
        version,
        targetVersion,
        `migration must produce safe integer version ${expected} (got ${String(next)})`,
      );
    }
    if (next !== expected) {
      throw new SnapshotVersionError(
        version,
        targetVersion,
        `migration must advance exactly one version to ${expected} (got ${String(next)})`,
      );
    }
    current = cloneSnapshot(output, next, targetVersion);
    version = next;
  }
  if (version !== targetVersion) {
    throw new SnapshotVersionError(
      version,
      targetVersion,
      'migration chain did not finish at the exact target version',
    );
  }
  return current;
}
