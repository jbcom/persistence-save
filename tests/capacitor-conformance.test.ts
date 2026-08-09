import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { CapacitorSQLite } from '@capacitor-community/sqlite';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const packageRoot = path.resolve(import.meta.dirname, '..');
const workspaceRoot = path.resolve(packageRoot, '../..');

interface PackageManifest {
  version: string;
  packageManager?: string;
  engines?: Record<string, string>;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

async function readManifest(packageJsonPath: string): Promise<PackageManifest> {
  return JSON.parse(await readFile(packageJsonPath, 'utf8')) as PackageManifest;
}

async function installedManifest(name: string): Promise<PackageManifest> {
  return readManifest(require.resolve(`${name}/package.json`));
}

describe('Capacitor 8.5 conformance', () => {
  it('pins the workspace release toolchain exactly', async () => {
    const workspaceManifest = await readManifest(path.join(workspaceRoot, 'package.json'));
    const harnessManifest = await readManifest(
      path.join(workspaceRoot, 'packages/test-harness/package.json'),
    );
    const nodeVersion = (await readFile(path.join(workspaceRoot, '.node-version'), 'utf8')).trim();
    const consumerVerifier = await readFile(
      path.join(packageRoot, 'scripts/verify-packed-consumer.mjs'),
      'utf8',
    );

    expect(nodeVersion).toBe('24.18.1');
    expect(workspaceManifest.packageManager).toBe('pnpm@11.18.0');
    expect(workspaceManifest.devDependencies?.['@types/node']).toBe('24.13.3');
    expect(harnessManifest.devDependencies?.['@types/node']).toBe('24.13.3');
    expect(consumerVerifier).toContain("npmVersion !== '11.16.0'");
    expect(consumerVerifier).toContain("runChecked('npm', ['pack'");
  });

  it('pins the admitted toolchain, current runtime matrix, and bounded peer ranges', async () => {
    const manifest = await readManifest(path.join(packageRoot, 'package.json'));

    expect(manifest).toMatchObject({
      version: '0.2.0',
      engines: { node: '>=24.18.1 <25' },
      scripts: {
        'test:consumer': 'node scripts/verify-packed-consumer.mjs',
        verify: 'pnpm typecheck && pnpm test && pnpm test:consumer',
      },
      dependencies: {
        '@arcade-cabinet/jeep-sqlite': '2.8.0-arcade.2',
        'sql.js': '1.14.1',
      },
      devDependencies: {
        '@capacitor-community/sqlite': '8.1.0',
        '@capacitor/core': '8.5.0',
        '@capacitor/preferences': '8.0.1',
        '@types/node': '24.13.3',
        '@types/sql.js': '1.4.11',
        rimraf: '6.1.3',
        typescript: '7.0.2',
        vite: '8.2.0',
        vitest: '4.1.10',
      },
      peerDependencies: {
        '@capacitor-community/sqlite': '>=8.1.0 <9',
        '@capacitor/core': '>=8.5.0 <9',
        '@capacitor/preferences': '>=8.0.1 <9',
      },
    });

    await expect(installedManifest('@capacitor/core')).resolves.toMatchObject({ version: '8.5.0' });
    await expect(installedManifest('@capacitor/preferences')).resolves.toMatchObject({
      version: '8.0.1',
    });
    await expect(installedManifest('@capacitor-community/sqlite')).resolves.toMatchObject({
      version: '8.1.0',
    });
  });

  it('makes the packed consumer mandatory in package, root, and CI verification', async () => {
    const packageManifest = await readManifest(path.join(packageRoot, 'package.json'));
    const workspaceManifest = await readManifest(path.join(workspaceRoot, 'package.json'));
    const ciWorkflow = await readFile(path.join(workspaceRoot, '.github/workflows/ci.yml'), 'utf8');

    expect(packageManifest.scripts?.verify).toContain('pnpm test:consumer');
    expect(workspaceManifest.scripts?.['verify:packages']).toContain(
      '@arcade-cabinet/persistence-save run test:consumer',
    );
    expect(workspaceManifest.scripts?.verify).toContain('pnpm verify:packages');
    expect(ciWorkflow).toContain('run: pnpm verify:packages');
  });

  it('is dogfooded by the Aethelgard winner without a duplicate connection manager', async () => {
    const workspaceManifest = await readManifest(path.join(workspaceRoot, 'package.json'));
    const facadeSource = await readFile(
      path.join(workspaceRoot, 'src/persistence/persistence.ts'),
      'utf8',
    );
    const copyWasmSource = await readFile(
      path.join(workspaceRoot, 'scripts/copy-wasm.mjs'),
      'utf8',
    );

    expect(workspaceManifest.dependencies?.['@arcade-cabinet/persistence-save']).toBe(
      'workspace:*',
    );
    expect(facadeSource).toContain('createPersistence as createSaveStore');
    expect(facadeSource).toContain('const saveStore = createSaveStore<GameSnapshot, GameSnapshot>');
    expect(facadeSource).toContain('encryptionKeyPreference: PREF_KEYS.dbKey');
    expect(facadeSource).not.toContain('new SQLiteConnection(');
    expect(facadeSource).not.toContain('CapacitorSQLite');
    expect(copyWasmSource).toContain('@arcade-cabinet/persistence-save/assets/');
  });

  it('uses public plugin surfaces that remain present on the admitted matrix', () => {
    expect(typeof Capacitor.getPlatform).toBe('function');
    expect(typeof Preferences.get).toBe('function');
    expect(typeof Preferences.set).toBe('function');
    expect(typeof Preferences.remove).toBe('function');
    expect(typeof Preferences.keys).toBe('function');
    expect(typeof CapacitorSQLite.createConnection).toBe('function');
    expect(typeof CapacitorSQLite.saveToStore).toBe('function');
  });
});
