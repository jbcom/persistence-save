import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const packageRoot = path.resolve(import.meta.dirname, '..');
const run = promisify(execFile);

describe('published package contract', () => {
  it('packs every declared runtime, type, and WASM entrypoint from a clean build', async () => {
    const packDirectory = await mkdtemp(path.join(tmpdir(), 'persistence-save-pack-'));

    try {
      const { stdout: packOutput } = await run(
        'pnpm',
        ['pack', '--pack-destination', packDirectory],
        { cwd: packageRoot },
      );
      const tarballName = packOutput.trim().split('\n').at(-1);
      expect(tarballName).toBeTruthy();

      const tarballPath = path.resolve(packageRoot, tarballName as string);
      const { stdout: tarOutput } = await run('tar', ['-tzf', tarballPath]);
      const entries = new Set(tarOutput.trim().split('\n'));

      expect([...entries]).toEqual(
        expect.arrayContaining([
          'package/LICENSE',
          'package/dist/assets/sql-wasm-browser.wasm',
          'package/dist/assets/sql-wasm.wasm',
          'package/dist/cjs/index.js',
          'package/dist/cjs/package.json',
          'package/dist/esm/index.js',
          'package/dist/types/index.d.ts',
          'package/package.json',
        ]),
      );
    } finally {
      await rm(packDirectory, { force: true, recursive: true });
    }
  });
});
