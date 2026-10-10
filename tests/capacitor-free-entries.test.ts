import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const packageRoot = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8')) as {
  exports: Record<string, unknown>;
  peerDependencies: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

/** The autosave scheduler and the migration walker, usable by a game on any Capacitor. */
const FREE_ENTRIES = { './autosave': 'autosave', './migrations': 'migrations' } as const;

describe('Capacitor-free entries', () => {
  it.each(Object.values(FREE_ENTRIES))('src/%s.ts imports nothing at all', async (name) => {
    const source = await readFile(path.join(packageRoot, 'src', `${name}.ts`), 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\bimport\(/);
    expect(source).not.toMatch(/\brequire\(/);
  });

  it.each(Object.entries(FREE_ENTRIES))('maps %s to its own built module', (subpath, name) => {
    expect(manifest.exports[subpath]).toEqual({
      import: { types: `./dist/types/${name}.d.ts`, default: `./dist/esm/${name}.js` },
      require: { types: `./dist/cjs/${name}.d.ts`, default: `./dist/cjs/${name}.js` },
    });
  });

  it('marks every Capacitor peer optional: only the root entry needs them', () => {
    const capacitor = Object.keys(manifest.peerDependencies).filter((name) =>
      name.startsWith('@capacitor'),
    );
    expect(capacitor.length).toBeGreaterThan(0);
    for (const name of capacitor)
      expect(manifest.peerDependenciesMeta?.[name]?.optional).toBe(true);
  });
});
