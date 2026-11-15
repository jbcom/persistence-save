import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SQLiteDBConnection } from '@capacitor-community/sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  legacy: new Map<string, string>(),
  driver: undefined as unknown as SQLiteDBConnection,
  available: true,
}));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({ value: state.legacy.get(key) ?? null }),
    keys: async () => ({ keys: [...state.legacy.keys()] }),
  },
}));
vi.mock('../src/persistence.js', () => ({
  createPersistence: (config: { initializeSchema: (db: SQLiteDBConnection) => Promise<void> }) => {
    const ready = config.initializeSchema(state.driver);
    return {
      withConnection: async (
        action: (db: SQLiteDBConnection) => Promise<unknown>,
        fallback: unknown,
      ) => {
        await ready;
        return state.available ? action(state.driver) : fallback;
      },
    };
  },
}));

let folder: string;
let path: string;
let sqlite: DatabaseSync;
let create: typeof import('../src/preferences-kv.js').createAtomicPreferencesKv;
let writeFailure = false;
let commitFailure = false;
let writeGate: (() => Promise<void>) | undefined;

beforeEach(async () => {
  vi.resetModules();
  state.legacy.clear();
  state.available = true;
  folder = mkdtempSync(join(tmpdir(), 'atomic-kv-native-'));
  path = join(folder, 'preferences.sqlite');
  sqlite = new DatabaseSync(path);
  writeFailure = false;
  commitFailure = false;
  writeGate = undefined;
  state.driver = {
    execute: async (sql: string) => {
      sqlite.exec(sql);
      if (sql === 'COMMIT;' && commitFailure) throw new Error('commit acknowledgement failed');
      return { changes: { changes: 0 } };
    },
    query: async (sql: string, values: (string | null)[] = []) => ({
      values: sqlite.prepare(sql).all(...values),
    }),
    run: async (sql: string, values: (string | null)[] = []) => {
      sqlite.prepare(sql).run(...values);
      await writeGate?.();
      if (writeFailure) {
        writeFailure = false;
        throw new Error('driver failed after write');
      }
      return { changes: { changes: 1 } };
    },
  } as unknown as SQLiteDBConnection;
  create = (await import('../src/preferences-kv.js')).createAtomicPreferencesKv;
});
afterEach(() => {
  sqlite.close();
  rmSync(folder, { recursive: true, force: true });
  vi.restoreAllMocks();
});

it('migrates only addressed legacy values and keeps removals tombstoned across new handles', async () => {
  state.legacy.set('a.route', 'legacy');
  state.legacy.set('ordinary.muted', '1');
  const a = create('a');
  expect(await a.get('route')).toBe('legacy');
  expect(sqlite.prepare('SELECT COUNT(*) AS n FROM atomic_preferences').get()?.n).toBe(0);
  await a.update('route', (raw) => `${raw}-new`);
  expect(await create('a').get('route')).toBe('legacy-new');
  expect(state.legacy.get('a.route')).toBe('legacy');
  await a.remove('route');
  expect(await create('a').get('route')).toBeNull();
  expect(await a.keys()).toEqual([]);
  expect(state.legacy.get('ordinary.muted')).toBe('1');
});

it('clear tombstones legacy and current keys only in its namespace', async () => {
  state.legacy.set('a.old', '1');
  state.legacy.set('other.keep', '1');
  const a = create('a');
  await a.set('new', '2');
  expect((await a.keys()).sort()).toEqual(['new', 'old']);
  await a.clear();
  expect(await a.get('old')).toBeNull();
  expect(await a.get('new')).toBeNull();
  expect(await create('other').get('keep')).toBe('1');
});

it('rolls back a partially applied driver write before a later writer reads', async () => {
  state.legacy.set('a.route', 'old');
  const a = create('a');
  const b = create('a');
  writeFailure = true;
  const failed = a.update('route', () => 'failed');
  const successful = b.update('route', (raw) => `${raw}-new`);
  await expect(failed).rejects.toThrow('driver failed');
  await expect(successful).resolves.toBe('old-new');
  expect(await a.get('route')).toBe('old-new');
});

it('rejects thrown/async reducers without changing SQLite or legacy data', async () => {
  const a = create('a');
  await expect(
    a.update('x', () => {
      throw new Error('invalid');
    }),
  ).rejects.toThrow('invalid');
  // @ts-expect-error JavaScript callers are also checked at runtime.
  await expect(a.update('x', async () => 'bad')).rejects.toThrow('synchronously');
  expect(await a.get('x')).toBeNull();
  expect(await a.update('x', (raw) => raw)).toBeNull();
  expect(sqlite.prepare('SELECT COUNT(*) AS n FROM atomic_preferences').get()?.n).toBe(0);
});

it('serializes overlapping native handles and respects an independent SQLite process lock', async () => {
  const a = create('a');
  const b = create('a');
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  writeGate = () => {
    started();
    return held;
  };
  const first = a.update('counter', (raw) => String(Number(raw ?? 0) + 1));
  await entered;
  const second = b.update('counter', (raw) => String(Number(raw ?? 0) + 1));
  const processWrite = () =>
    spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
    import {DatabaseSync} from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA busy_timeout = 10; BEGIN IMMEDIATE;');
    db.prepare('UPDATE atomic_preferences SET value = CAST(value AS INTEGER) + 1 WHERE key = ?').run('a.counter');
    db.exec('COMMIT;'); db.close();
  `,
        path,
      ],
      { encoding: 'utf8' },
    );
  const blocked = processWrite();
  expect(blocked.status).not.toBe(0);
  expect(blocked.stderr).toMatch(/locked/);
  writeGate = undefined;
  release();
  await Promise.all([first, second]);
  expect(processWrite().status).toBe(0);
  expect(await a.update('counter', (raw) => String(Number(raw) + 1))).toBe('4');
});

it('reports an uncertain committed transaction without compensating over its bytes', async () => {
  const a = create('a');
  commitFailure = true;
  await expect(a.update('x', () => 'new')).rejects.toThrow('storage is uncertain');
  commitFailure = false;
  expect(await a.get('x')).toBe('new');
});

it('fails closed on missing SQLite and keeps getParsed fallback behavior', async () => {
  state.available = false;
  const a = create('a');
  await expect(a.update('x', () => 'new')).rejects.toThrow('unavailable');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  expect(await a.getParsed('x', (raw) => raw, 'fallback')).toBe('fallback');
  expect(warn).toHaveBeenCalled();
  state.available = true;
  await a.set('x', 'yes');
  expect(await a.getParsed('x', (raw) => raw, 'fallback')).toBe('yes');
  await expect(async () => create('')).rejects.toThrow('non-empty');
});
