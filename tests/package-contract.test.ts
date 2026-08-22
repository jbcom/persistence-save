import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const packageRoot = path.resolve(import.meta.dirname, '..');
const run = promisify(execFile);

describe('published package contract', () => {
  it('accepts only an exact scoped registry package spec from publication CI', async () => {
    const verifier = await readFile(
      path.join(packageRoot, 'scripts/verify-packed-consumer.mjs'),
      'utf8',
    );
    expect(verifier).toContain(
      'PERSISTENCE_SAVE_CONSUMER_SOURCE must be an exact @arcade-cabinet/persistence-save package spec',
    );
    expect(verifier).toContain('^@arcade-cabinet\\/persistence-save@');
  });

  it('packs every declared runtime, type, and WASM entrypoint from a clean build', async () => {
    const packDirectory = await mkdtemp(path.join(tmpdir(), 'persistence-save-pack-'));

    try {
      const { stdout: npmVersion } = await run('npm', ['--version'], { cwd: packageRoot });
      expect(npmVersion.trim()).toBe('11.17.0');
      await run('npm', ['pack', '--pack-destination', packDirectory], { cwd: packageRoot });
      const archives = (await readdir(packDirectory)).filter((entry) => entry.endsWith('.tgz'));
      expect(archives).toHaveLength(1);
      expect(archives[0]).toBe('arcade-cabinet-persistence-save-0.2.0.tgz');

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
