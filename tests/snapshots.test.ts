/** Real SQLite statements through sql.js, with the platform flush boundary controlled. */
import initSqlJs, { type Database } from 'sql.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CorruptSaveError, createPersistence, SnapshotExistsError } from '../src/persistence.js';

const driver = vi.hoisted(() => ({
  platform: 'web',
  connection: null as unknown,
  durable: null as Uint8Array | null,
  failFlush: false,
  failOpen: false,
  insertError: null as Error | null,
  flushes: 0,
  flushGate: null as Promise<void> | null,
}));
vi.mock('@capacitor/core', () => ({ Capacitor: { getPlatform: () => driver.platform } }));
vi.mock('@capacitor/preferences', () => ({ Preferences: {} }));
vi.mock('@capacitor-community/sqlite', () => ({
  CapacitorSQLite: {},
  SQLiteConnection: class {
    async initWebStore() {}
    async isConnection() {
      return { result: false };
    }
    async createConnection() {
      return driver.connection;
    }
    async closeConnection() {}
    async saveToStore() {
      driver.flushes++;
      await driver.flushGate;
      if (driver.failFlush) throw new Error('IndexedDB quota');
      driver.durable = (driver.connection as { export(): Uint8Array }).export();
    }
  },
}));

let database: Database;
function attachDatabase(db: Database) {
  database = db;
  driver.connection = {
    open: async () => {
      if (driver.failOpen) throw new Error('unavailable');
    },
    close: async () => {},
    execute: async (sql: string) => {
      database.run(sql);
    },
    run: async (sql: string, params: (string | number)[]) => {
      if (driver.insertError && sql.includes('INSERT INTO snapshots')) throw driver.insertError;
      database.run(sql, params);
    },
    query: async (sql: string, params: (string | number)[] = []) => {
      const statement = database.prepare(sql);
      try {
        statement.bind(params);
        const values = [];
        while (statement.step()) values.push(statement.getAsObject());
        return { values };
      } finally {
        statement.free();
      }
    },
    export: () => database.export(),
  };
}
function store(overrides = {}) {
  return createPersistence({
    dbName: 'com.persistence.snapshots',
    snapshotVersion: 1,
    maxSaves: 2,
    serialize: (text: string) => ({ version: 1, text }),
    deserialize: (snapshot) => snapshot.text,
    migrations: {},
    ...overrides,
  });
}

beforeEach(async () => {
  const sqlite = await initSqlJs();
  attachDatabase(new sqlite.Database());
  driver.platform = 'web';
  driver.durable = null;
  driver.failFlush = false;
  driver.failOpen = false;
  driver.insertError = null;
  driver.flushes = 0;
  driver.flushGate = null;
});
afterEach(() => database.close());

describe('immutable snapshots', () => {
  it('preserves exact bytes across ordinary rotation, same-name saves and deletion', async () => {
    const saves = store();
    const text = ' {"money":3,"name":"🐔"}\n';
    const snapshot = await saves.createSnapshot('farm', text);
    for (let i = 0; i < 12; i++) {
      await saves.save(i === 0 ? 'farm' : `ordinary-${i}`, `state-${i}`);
    }
    expect(await saves.list()).toHaveLength(2);
    await saves.delete(snapshot.id);
    expect((await saves.loadSnapshot('farm'))?.snapshot).toBe(text);
    expect(await saves.listSnapshots()).toEqual([snapshot]);
  });

  it('arbitrates concurrent same-name writers without replacing the winner', async () => {
    const saves = store();
    const other = store();
    const results = await Promise.allSettled([
      saves.createSnapshot('same', 'first'),
      other.createSnapshot('same', 'second'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((result) => result.status === 'rejected');
    expect(failed?.status === 'rejected' && failed.reason).toBeInstanceOf(SnapshotExistsError);
    const loaded = await saves.loadSnapshot('same');
    expect(loaded?.snapshot).toBe('first');
    await expect(saves.createSnapshot('same', 'third')).rejects.toBeInstanceOf(SnapshotExistsError);
    expect((await saves.loadSnapshot('same'))?.snapshot).toBe('first');
  });

  it('preserves unrelated insert errors even when the name already exists', async () => {
    const saves = store();
    await saves.createSnapshot('existing', 'original');
    driver.insertError = new Error('disk full');
    await expect(saves.createSnapshot('existing', 'replacement')).rejects.toBe(driver.insertError);
    expect((await saves.loadSnapshot('existing'))?.snapshot).toBe('original');
  });

  it('bounds names in JavaScript UTF-16 code units without truncation', async () => {
    const saves = store();
    const name = '🐔'.repeat(128);
    await saves.createSnapshot(name, 'exact name');
    expect((await saves.loadSnapshot(name))?.name).toBe(name);
    await expect(saves.createSnapshot('🐔'.repeat(129), 'x')).rejects.toThrow('UTF-16 code units');
  });

  it('rejects failed flushes and permits an explicit durable retry without overwriting', async () => {
    const saves = store();
    driver.failFlush = true;
    await expect(saves.createSnapshot('held', 'original')).rejects.toThrow('IndexedDB quota');
    expect(driver.durable).toBeNull();
    expect((await saves.loadSnapshot('held'))?.snapshot).toBe('original');
    await expect(saves.createSnapshot('held', 'replacement')).rejects.toBeInstanceOf(
      SnapshotExistsError,
    );
    driver.failFlush = false;
    await saves.flush();
    expect(driver.durable?.byteLength).toBeGreaterThan(0);
  });

  it('orders web flushes across facades so an older export cannot finish last', async () => {
    let release: () => void = () => {};
    driver.flushGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = store().createSnapshot('first', 'a');
    await vi.waitFor(() => expect(driver.flushes).toBe(1));
    const second = store().createSnapshot('second', 'b');
    // Wait until the second INSERT has committed but its flush is still queued.
    await vi.waitFor(() => {
      expect(database.exec('SELECT COUNT(*) FROM snapshots')[0]?.values[0]?.[0]).toBe(2);
    });
    expect(driver.flushes).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(driver.flushes).toBe(2);
  });

  it('reopens flushed SQLite bytes in a fresh connection', async () => {
    const saves = store();
    await saves.createSnapshot('durable', 'preserved');
    await saves.close();
    const sqlite = await initSqlJs();
    database.close();
    attachDatabase(new sqlite.Database(driver.durable ?? undefined));
    expect((await store().loadSnapshot('durable'))?.snapshot).toBe('preserved');
  });

  it('commits native snapshots without requiring the web store', async () => {
    driver.platform = 'ios';
    const saves = store();
    await saves.createSnapshot('native', 'on disk');
    expect(driver.flushes).toBe(0);
    await saves.close();
    expect((await store().loadSnapshot('native'))?.snapshot).toBe('on disk');
  });

  it('paginates every snapshot beyond the ordinary maxSaves cap', async () => {
    const saves = store();
    for (let i = 0; i < 7; i++) await saves.createSnapshot(`archive-${i}`, `${i}`);
    const names = [];
    let beforeId: number | undefined;
    for (;;) {
      const page = await saves.listSnapshots({ limit: 2, ...(beforeId ? { beforeId } : {}) });
      if (!page.length) break;
      names.push(...page.map((record) => record.name));
      beforeId = page.at(-1)?.id;
    }
    expect(names).toEqual(Array.from({ length: 7 }, (_, i) => `archive-${6 - i}`));
  });

  it('rejects invalid names, cursors, sizes and unavailable storage', async () => {
    const saves = store({ maxSnapshotBytes: 100 });
    await expect(saves.createSnapshot('', 'x')).rejects.toThrow('snapshot name');
    await expect(saves.createSnapshot('x'.repeat(257), 'x')).rejects.toThrow('snapshot name');
    await expect(saves.loadSnapshot('')).rejects.toThrow('snapshot name');
    await expect(saves.createSnapshot('large', '🐔'.repeat(40))).rejects.toThrow('too large');
    for (const limit of [0, 501, Number.NaN, 1.5]) {
      await expect(saves.listSnapshots({ limit })).rejects.toThrow('page limit');
    }
    await expect(saves.listSnapshots({ beforeId: 0 })).rejects.toThrow('cursor');
    driver.failOpen = true;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(saves.createSnapshot('no', 'x')).rejects.toThrow('unavailable');
    await expect(saves.loadSnapshot('no')).rejects.toThrow('unavailable');
    await expect(saves.listSnapshots()).rejects.toThrow('unavailable');
    vi.restoreAllMocks();
  });

  it('returns null only for absence, and surfaces corrupt rows on load and list', async () => {
    const saves = store();
    expect(await saves.loadSnapshot('absent')).toBeNull();
    await saves.createSnapshot('broken', 'x');
    database.run('UPDATE snapshots SET snapshot = ? WHERE name = ?', ['invalid json', 'broken']);
    await expect(saves.loadSnapshot('broken')).rejects.toBeInstanceOf(CorruptSaveError);
    await expect(saves.listSnapshots()).rejects.toBeInstanceOf(CorruptSaveError);
  });
});
