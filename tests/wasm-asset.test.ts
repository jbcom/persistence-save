import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const packageRoot = path.resolve(import.meta.dirname, '..');
const run = promisify(execFile);

describe('web SQLite WASM ABI asset', () => {
  it('uses the current stable sql.js runtime', async () => {
    const sqlPackagePath = path.join(path.dirname(require.resolve('sql.js')), '..', 'package.json');
    const sqlPackage = JSON.parse(await readFile(sqlPackagePath, 'utf8')) as { version: string };
    expect(sqlPackage.version).toBe('1.14.2');
  });

  it.each(['sql-wasm.wasm', 'sql-wasm-browser.wasm'])(
    'copies a non-empty %s module into the published dist tree',
    async (assetName) => {
      await run(process.execPath, [path.join(packageRoot, 'scripts/copy-wasm.mjs')]);
      const assetPath = path.join(packageRoot, 'dist/assets', assetName);
      const asset = await readFile(assetPath);
      expect((await stat(assetPath)).size).toBeGreaterThan(500_000);
      expect([...asset.subarray(0, 4)]).toEqual([0, 97, 115, 109]);
      expect(() => new WebAssembly.Module(asset)).not.toThrow();
    },
  );

  it('initializes the published asset with its JavaScript loader and executes SQL', async () => {
    await run(process.execPath, [path.join(packageRoot, 'scripts/copy-wasm.mjs')]);
    const assetPath = path.join(packageRoot, 'dist/assets/sql-wasm.wasm');
    const SQL = await initSqlJs({ locateFile: () => assetPath });
    const database = new SQL.Database();

    database.run('CREATE TABLE proof (name TEXT NOT NULL, score INTEGER NOT NULL)');
    database.run('INSERT INTO proof VALUES (?, ?)', ['player-one', 1141]);
    expect(database.exec('SELECT name, score FROM proof')).toEqual([
      {
        columns: ['name', 'score'],
        values: [['player-one', 1141]],
      },
    ]);
    database.close();
  });
});
