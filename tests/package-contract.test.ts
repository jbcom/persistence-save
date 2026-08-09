import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
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
      await run('npm', ['pack', '--pack-destination', packDirectory], { cwd: packageRoot });
      const archives = (await readdir(packDirectory)).filter((entry) => entry.endsWith('.tgz'));
      expect(archives).toHaveLength(1);

      const tarballPath = path.join(packDirectory, archives[0] as string);
      const { stdout: tarOutput } = await run('tar', ['-tzf', tarballPath]);
      const entries = new Set(tarOutput.trim().split('\n'));

      expect([...entries]).toEqual(
        expect.arrayContaining([
          'package/LICENSE',
          'package/README.md',
          'package/THIRD_PARTY_NOTICES.md',
          'package/dist/assets/sql-wasm-browser.wasm',
          'package/dist/assets/sql-wasm.wasm',
          'package/dist/cjs/index.js',
          'package/dist/cjs/package.json',
          'package/dist/esm/index.js',
          'package/dist/types/index.d.ts',
          'package/package.json',
        ]),
      );
      expect([...entries].some((entry) => entry.includes('node_modules'))).toBe(false);
    } finally {
      await rm(packDirectory, { force: true, recursive: true });
    }
  }, 30_000);
});
