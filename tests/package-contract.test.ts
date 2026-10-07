import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const packageRoot = path.resolve(import.meta.dirname, '..');
const run = promisify(execFile);

describe('published package contract', () => {
  it('accepts only an exact registry package spec for a published-version proof', async () => {
    const verifier = await readFile(
      path.join(packageRoot, 'scripts/verify-packed-consumer.mjs'),
      'utf8',
    );
    expect(verifier).toContain(
      'PERSISTENCE_SAVE_CONSUMER_SOURCE must be an exact persistence-save package spec',
    );
    expect(verifier).toContain('^persistence-save@');
  });

  it('packs every declared runtime, type, and WASM entrypoint from a clean build', async () => {
    const packDirectory = await mkdtemp(path.join(tmpdir(), 'persistence-save-pack-'));

    try {
      const { version } = JSON.parse(
        await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
      ) as { version: string };
      await run('npm', ['pack', '--pack-destination', packDirectory], { cwd: packageRoot });
      const archives = (await readdir(packDirectory)).filter((entry) => entry.endsWith('.tgz'));
      expect(archives).toHaveLength(1);
      expect(archives[0]).toBe(`persistence-save-${version}.tgz`);

      const tarballPath = path.join(packDirectory, archives[0] as string);
      const { stdout: tarOutput } = await run('tar', ['-tzf', tarballPath]);
      const entries = new Set(tarOutput.trim().split('\n'));

      expect([...entries]).toEqual(
        expect.arrayContaining([
          'package/CHANGELOG.md',
          'package/LICENSE',
          'package/README.md',
          'package/THIRD_PARTY_NOTICES.md',
          'package/dist/assets/sql-wasm-browser.wasm',
          'package/dist/assets/sql-wasm.wasm',
          'package/dist/cjs/index.js',
          'package/dist/cjs/index.d.ts',
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
