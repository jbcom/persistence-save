import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const packageRoot = path.resolve(import.meta.dirname, '..');
const run = promisify(execFile);

describe('web SQLite WASM ABI asset', () => {
  it('pins the exact sql.js ABI used to compile current jeep-sqlite', async () => {
    const sqlPackagePath = require.resolve('sql.js/package.json');
    const sqlPackage = JSON.parse(await readFile(sqlPackagePath, 'utf8')) as { version: string };
    expect(sqlPackage.version).toBe('1.11.0');
  });

  it('copies a non-empty WebAssembly module into the published dist tree', async () => {
    await run(process.execPath, [path.join(packageRoot, 'scripts/copy-wasm.mjs')]);
    const assetPath = path.join(packageRoot, 'dist/assets/sql-wasm.wasm');
    const asset = await readFile(assetPath);
    expect((await stat(assetPath)).size).toBeGreaterThan(500_000);
    expect([...asset.subarray(0, 4)]).toEqual([0, 97, 115, 109]);
    expect(() => new WebAssembly.Module(asset)).not.toThrow();
  });
});
