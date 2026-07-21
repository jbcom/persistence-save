/**
 * Facade tests over an in-memory fake of the `@capacitor-community/sqlite`
 * driver. The fake dispatches on the exact parameterized statements the
 * facade issues — string-built SQL would not match and fails the test,
 * which doubles as a regression guard on the zero-injection-surface policy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VersionedSnapshot } from '../src/migrations.js';
import type { PersistenceConfig } from '../src/persistence.js';
import { CorruptSaveError, createPersistence } from '../src/persistence.js';

// ---------------------------------------------------------------------------
// Hoisted fake-driver state
// ---------------------------------------------------------------------------

interface FakeRow {
  id: number;
  name: string;
  seed: string;
  saved_at: string;
  snapshot: string;
}

const state = vi.hoisted(() => ({
  databases: new Map<string, { rows: Array<Record<string, unknown>>; nextId: number }>(),
  connections: new Map<string, unknown>(),
  createConnectionCalls: [] as Array<{
    dbName: string;
    encrypted: boolean;
    mode: string;
    version: number;
  }>,
  saveToStoreCalls: [] as string[],
  platform: 'web',
  failOpen: false,
  prefs: new Map<string, string>(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => state.platform },
}));

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({ value: state.prefs.get(key) ?? null }),
    set: async ({ key, value }: { key: string; value: string }) => {
      state.prefs.set(key, value);
    },
    remove: async ({ key }: { key: string }) => {
      state.prefs.delete(key);
    },
    keys: async () => ({ keys: Array.from(state.prefs.keys()) }),
  },
}));

vi.mock('@capacitor-community/sqlite', () => {
  function getDb(dbName: string) {
    let db = state.databases.get(dbName);
    if (!db) {
      db = { rows: [], nextId: 1 };
      state.databases.set(dbName, db);
    }
    return db;
  }

  class FakeConnection {
    constructor(private readonly dbName: string) {}

    async open(): Promise<void> {
      if (state.failOpen) throw new Error('fake: cannot open DB');
    }

    async close(): Promise<void> {
      /* fake driver: nothing to release */
    }

    async execute(_sql: string): Promise<void> {
      // Schema DDL — the fake pre-creates its table shape.
    }

    async run(sql: string, params: unknown[] = []): Promise<void> {
      const db = getDb(this.dbName);
      if (/DELETE FROM saves WHERE name = \?/.test(sql)) {
        db.rows = db.rows.filter((r) => r.name !== params[0]);
        return;
      }
      if (
        /INSERT INTO saves \(name, seed, saved_at, snapshot\) VALUES \(\?, \?, \?, \?\)/.test(sql)
      ) {
        db.rows.push({
          id: db.nextId++,
          name: params[0],
          seed: params[1],
          saved_at: params[2],
          snapshot: params[3],
        } as Record<string, unknown>);
        return;
      }
      if (
        /DELETE FROM saves WHERE id IN \(\s*SELECT id FROM saves ORDER BY saved_at DESC LIMIT -1 OFFSET \?/.test(
          sql,
        )
      ) {
        const keep = params[0] as number;
        const sorted = [...db.rows].sort((a, b) =>
          String(b.saved_at).localeCompare(String(a.saved_at)),
        );
        const keepIds = new Set(sorted.slice(0, keep).map((r) => r.id));
        db.rows = db.rows.filter((r) => keepIds.has(r.id));
        return;
      }
      if (/DELETE FROM saves WHERE id = \?/.test(sql)) {
        db.rows = db.rows.filter((r) => r.id !== params[0]);
        return;
      }
      throw new Error(`fake driver: unrecognized run() statement: ${sql}`);
    }

    async query(sql: string, params: unknown[] = []): Promise<{ values: unknown[] }> {
      const db = getDb(this.dbName);
      if (/SELECT \* FROM saves WHERE id = \?/.test(sql)) {
        return { values: db.rows.filter((r) => r.id === params[0]) };
      }
      if (/SELECT \* FROM saves ORDER BY saved_at DESC LIMIT \?/.test(sql)) {
        const sorted = [...db.rows].sort((a, b) =>
          String(b.saved_at).localeCompare(String(a.saved_at)),
        );
        return { values: sorted.slice(0, params[0] as number) };
      }
      throw new Error(`fake driver: unrecognized query() statement: ${sql}`);
    }
  }

  class SQLiteConnection {
    async initWebStore(): Promise<void> {
      /* fake driver: no web store to init */
    }

    async saveToStore(dbName: string): Promise<void> {
      state.saveToStoreCalls.push(dbName);
    }

    async isConnection(dbName: string, _readonly: boolean): Promise<{ result: boolean }> {
      return { result: state.connections.has(dbName) };
    }

    async retrieveConnection(dbName: string, _readonly: boolean): Promise<FakeConnection> {
      const conn = state.connections.get(dbName);
      if (!conn) throw new Error(`fake driver: no connection for ${dbName}`);
      return conn as FakeConnection;
    }

    async createConnection(
      dbName: string,
      encrypted: boolean,
      mode: string,
      version: number,
      _readonly: boolean,
    ): Promise<FakeConnection> {
      state.createConnectionCalls.push({ dbName, encrypted, mode, version });
      const conn = new FakeConnection(dbName);
      state.connections.set(dbName, conn);
      return conn;
    }

    async closeConnection(dbName: string, _readonly: boolean): Promise<void> {
      state.connections.delete(dbName);
    }

    async setEncryptionSecret(_secret: string): Promise<void> {
      /* fake driver: secret accepted */
    }
  }

  return { CapacitorSQLite: {}, SQLiteConnection };
});

// ---------------------------------------------------------------------------
// Test state/snapshot pair with a real migration chain
// ---------------------------------------------------------------------------

interface TestState {
  seedPhrase: string;
  gold: number;
  towers: string[];
}

interface TestSnapshot extends VersionedSnapshot {
  seedPhrase: string;
  gold: number;
  towers: string[];
}

const CURRENT_VERSION = 2;

function makeConfig(
  dbName: string,
  overrides: Partial<PersistenceConfig<TestState, TestSnapshot>> = {},
): PersistenceConfig<TestState, TestSnapshot> {
  return {
    dbName,
    snapshotVersion: CURRENT_VERSION,
    serialize: (s) => ({ version: CURRENT_VERSION, ...s }),
    deserialize: (snap) => ({
      seedPhrase: snap.seedPhrase,
      gold: snap.gold,
      towers: snap.towers,
    }),
    migrations: {
      // v1 predates `towers` — default to empty.
      1: (snap) => ({ ...snap, version: 2, towers: [] }),
    },
    seedPhraseOf: (s) => s.seedPhrase,
    ...overrides,
  };
}

let dbCounter = 0;
function freshDbName(): string {
  return `com.test.persistence_v${++dbCounter}`;
}

/** Insert a raw row directly into the fake store (bypassing the facade). */
function insertRawRow(dbName: string, row: Omit<FakeRow, 'id'>): number {
  let db = state.databases.get(dbName);
  if (!db) {
    db = { rows: [], nextId: 1 };
    state.databases.set(dbName, db);
  }
  const id = db.nextId++;
  db.rows.push({ id, ...row });
  return id;
}

const STATE_A: TestState = { seedPhrase: 'ember-vale', gold: 120, towers: ['north', 'east'] };

describe('createPersistence', () => {
  beforeEach(() => {
    state.databases.clear();
    state.connections.clear();
    state.createConnectionCalls.length = 0;
    state.saveToStoreCalls.length = 0;
    state.prefs.clear();
    state.platform = 'web';
    state.failOpen = false;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-21T10:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('round-trips save → load byte-faithfully', async () => {
    const p = createPersistence(makeConfig(freshDbName()));
    await p.save('Slot 1', STATE_A);
    const records = await p.list();
    expect(records).toHaveLength(1);
    const rec = records[0];
    expect(rec).toBeDefined();
    const loaded = await p.load(rec!.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.snapshot).toEqual(STATE_A);
    expect(loaded!.name).toBe('Slot 1');
    expect(loaded!.seedPhrase).toBe('ember-vale');
    expect(loaded!.savedAt).toBe('2026-07-21T10:00:00.000Z');
  });

  it('UPSERTs by name — same-name saves replace, StrictMode-safe (M_SEC.26)', async () => {
    const dbName = freshDbName();
    const p = createPersistence(makeConfig(dbName));
    await p.save('AutoSave', STATE_A);
    vi.advanceTimersByTime(1000);
    await p.save('AutoSave', { ...STATE_A, gold: 999 });
    const records = await p.list();
    expect(records).toHaveLength(1);
    expect(records[0]!.snapshot.gold).toBe(999);
  });

  it('load() returns null when no row exists', async () => {
    const p = createPersistence(makeConfig(freshDbName()));
    expect(await p.load(42)).toBeNull();
  });

  it('load() throws CorruptSaveError on unparseable JSON — never masks as "no save" (M_SEC.22)', async () => {
    const dbName = freshDbName();
    const p = createPersistence(makeConfig(dbName));
    await p.save('good', STATE_A); // forces the connection open + table
    const id = insertRawRow(dbName, {
      name: 'bad',
      seed: 's',
      saved_at: '2026-07-21T09:00:00.000Z',
      snapshot: '{not json',
    });
    await expect(p.load(id)).rejects.toThrow(CorruptSaveError);
    await expect(p.load(id)).rejects.toMatchObject({ recordId: id });
  });

  it('load() throws CorruptSaveError on an over-budget snapshot BEFORE parsing (M_AUDIT2.SEC2.9)', async () => {
    const dbName = freshDbName();
    const p = createPersistence(makeConfig(dbName, { maxSnapshotBytes: 64 }));
    const id = insertRawRow(dbName, {
      name: 'huge',
      seed: 's',
      saved_at: '2026-07-21T09:00:00.000Z',
      snapshot: JSON.stringify({ version: 2, blob: 'x'.repeat(200) }),
    });
    await expect(p.load(id)).rejects.toThrow(/too large/);
  });

  it('load() throws CorruptSaveError on an unknown future snapshot version', async () => {
    const dbName = freshDbName();
    const p = createPersistence(makeConfig(dbName));
    const id = insertRawRow(dbName, {
      name: 'future',
      seed: 's',
      saved_at: '2026-07-21T09:00:00.000Z',
      snapshot: JSON.stringify({ version: 99, seedPhrase: 'x', gold: 0, towers: [] }),
    });
    await expect(p.load(id)).rejects.toThrow(CorruptSaveError);
    await expect(p.load(id)).rejects.toThrow(/newer app version/);
  });

  it('load() migrates an old-version snapshot through the chain', async () => {
    const dbName = freshDbName();
    const p = createPersistence(makeConfig(dbName));
    const id = insertRawRow(dbName, {
      name: 'legacy',
      seed: 'old-seed',
      saved_at: '2026-07-20T09:00:00.000Z',
      snapshot: JSON.stringify({ version: 1, seedPhrase: 'old-seed', gold: 5 }),
    });
    const rec = await p.load(id);
    expect(rec).not.toBeNull();
    // The v1→v2 migration filled the missing `towers` field.
    expect(rec!.snapshot).toEqual({ seedPhrase: 'old-seed', gold: 5, towers: [] });
  });

  it('list() returns newest-first and skips corrupt rows individually (M_SEC.21)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
      /* silence expected warn */
    });
    try {
      const dbName = freshDbName();
      const p = createPersistence(makeConfig(dbName));
      await p.save('older', STATE_A);
      vi.advanceTimersByTime(60_000);
      await p.save('newer', { ...STATE_A, gold: 1 });
      insertRawRow(dbName, {
        name: 'corrupt',
        seed: 's',
        saved_at: '2026-07-21T09:59:00.000Z',
        snapshot: 'garbage',
      });
      const records = await p.list();
      expect(records.map((r) => r.name)).toEqual(['newer', 'older']);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('skipping corrupt save row'),
        expect.anything(),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('list() caps rows at listLimit (M_SEC.13)', async () => {
    const p = createPersistence(makeConfig(freshDbName(), { listLimit: 3 }));
    for (let i = 0; i < 5; i++) {
      await p.save(`slot-${i}`, STATE_A);
      vi.advanceTimersByTime(1000);
    }
    const records = await p.list();
    expect(records).toHaveLength(3);
    expect(records[0]!.name).toBe('slot-4');
  });

  it('save() prunes the oldest rows past maxSaves (M_AUDIT2.SEC2.7)', async () => {
    const p = createPersistence(makeConfig(freshDbName(), { maxSaves: 3, listLimit: 10 }));
    for (let i = 0; i < 5; i++) {
      await p.save(`slot-${i}`, STATE_A);
      vi.advanceTimersByTime(1000);
    }
    const records = await p.list();
    expect(records.map((r) => r.name)).toEqual(['slot-4', 'slot-3', 'slot-2']);
  });

  it('save() truncates names over 256 chars (M_SEC.12)', async () => {
    const p = createPersistence(makeConfig(freshDbName()));
    await p.save('x'.repeat(300), STATE_A);
    const records = await p.list();
    expect(records[0]!.name).toHaveLength(256);
  });

  it('save() rejects an over-budget snapshot on WRITE, symmetric with the read cap', async () => {
    const p = createPersistence(makeConfig(freshDbName(), { maxSnapshotBytes: 64 }));
    await expect(
      p.save('big', { ...STATE_A, towers: Array.from({ length: 50 }, (_, i) => `tower-${i}`) }),
    ).rejects.toThrow(/too large to save/);
  });

  it('save() defaults seedPhrase to empty when seedPhraseOf is unset', async () => {
    const config = makeConfig(freshDbName());
    delete config.seedPhraseOf;
    const p = createPersistence(config);
    await p.save('slot', STATE_A);
    const records = await p.list();
    expect(records[0]!.seedPhrase).toBe('');
  });

  it('flushes the web store after every mutation (M_V13.PERSIST.WEB-FLUSH)', async () => {
    const dbName = freshDbName();
    const p = createPersistence(makeConfig(dbName));
    await p.save('slot', STATE_A);
    expect(state.saveToStoreCalls).toEqual([dbName]);
    const records = await p.list();
    await p.delete(records[0]!.id);
    expect(state.saveToStoreCalls).toEqual([dbName, dbName]);
  });

  it('does NOT flush a web store on native platforms', async () => {
    state.platform = 'ios';
    const p = createPersistence(makeConfig(freshDbName()));
    await p.save('slot', STATE_A);
    expect(state.saveToStoreCalls).toEqual([]);
  });

  it('delete() removes exactly the addressed row', async () => {
    const p = createPersistence(makeConfig(freshDbName()));
    await p.save('keep', STATE_A);
    vi.advanceTimersByTime(1000);
    await p.save('drop', STATE_A);
    const before = await p.list();
    const dropId = before.find((r) => r.name === 'drop')!.id;
    await p.delete(dropId);
    const after = await p.list();
    expect(after.map((r) => r.name)).toEqual(['keep']);
  });

  it('opens unencrypted on web even when encrypted: true (sql.js has no SQLCipher)', async () => {
    const p = createPersistence(makeConfig(freshDbName(), { encrypted: true }));
    await p.save('slot', STATE_A);
    expect(state.createConnectionCalls[0]).toMatchObject({
      encrypted: false,
      mode: 'no-encryption',
    });
    expect(state.prefs.size).toBe(0); // no key minted on web
  });

  it('mints + persists a per-install SQLCipher key on native when encrypted (M_SEC.4)', async () => {
    state.platform = 'android';
    const dbName = freshDbName();
    const p = createPersistence(makeConfig(dbName, { encrypted: true }));
    await p.save('slot', STATE_A);
    expect(state.createConnectionCalls[0]).toMatchObject({ encrypted: true, mode: 'encryption' });
    const key = state.prefs.get(`${dbName}.dbKey`);
    expect(key).toBeDefined();
    expect(key!.length).toBeGreaterThanOrEqual(32);
    // Second open reuses the SAME key instead of minting a fresh one.
    await p.close();
    const p2 = createPersistence(makeConfig(dbName, { encrypted: true }));
    await p2.save('slot2', STATE_A);
    expect(state.prefs.get(`${dbName}.dbKey`)).toBe(key);
  });

  it('degrades to graceful no-ops when the DB cannot open', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
      /* silence expected warn */
    });
    try {
      state.failOpen = true;
      const p = createPersistence(makeConfig(freshDbName()));
      await expect(p.save('slot', STATE_A)).resolves.toBeUndefined();
      expect(await p.load(1)).toBeNull();
      expect(await p.list()).toEqual([]);
      await expect(p.delete(1)).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('SQLite unavailable'),
        expect.anything(),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('close() releases the connection and a later call re-opens lazily', async () => {
    const dbName = freshDbName();
    const p = createPersistence(makeConfig(dbName));
    await p.save('slot', STATE_A);
    expect(state.connections.has(dbName)).toBe(true);
    await p.close();
    expect(state.connections.has(dbName)).toBe(false);
    // Data survives (same fake backing store) and the facade re-opens.
    const records = await p.list();
    expect(records).toHaveLength(1);
    expect(state.connections.has(dbName)).toBe(true);
  });

  it('close() is safe to call when nothing was ever opened', async () => {
    const p = createPersistence(makeConfig(freshDbName()));
    await expect(p.close()).resolves.toBeUndefined();
  });

  it('concurrent first calls share a single open sequence', async () => {
    const dbName = freshDbName();
    const p = createPersistence(makeConfig(dbName));
    await Promise.all([p.save('a', STATE_A), p.save('b', STATE_A), p.list()]);
    expect(state.createConnectionCalls.filter((c) => c.dbName === dbName)).toHaveLength(1);
  });

  it('two instances with distinct dbNames stay isolated', async () => {
    const p1 = createPersistence(makeConfig(freshDbName()));
    const p2 = createPersistence(makeConfig(freshDbName()));
    await p1.save('one', STATE_A);
    await p2.save('two', { ...STATE_A, gold: 7 });
    expect((await p1.list()).map((r) => r.name)).toEqual(['one']);
    expect((await p2.list()).map((r) => r.name)).toEqual(['two']);
  });
});
