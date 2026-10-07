import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { CapacitorSQLite } from '@capacitor-community/sqlite';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const packageRoot = path.resolve(import.meta.dirname, '..');

interface PackageManifest {
  version: string;
  packageManager?: string;
  engines?: Record<string, string>;
  repository?: { type: string; url: string; directory?: string };
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

function readRepoFile(relativePath: string): Promise<string> {
  return readFile(path.join(packageRoot, relativePath), 'utf8');
}

describe('Capacitor 8.5 conformance', () => {
  it('is its own repository, built and released on the fleet toolchain', async () => {
    const manifest = await readManifest(path.join(packageRoot, 'package.json'));
    const nodeVersion = (await readRepoFile('.node-version')).trim();

    expect(manifest.repository).toEqual({
      type: 'git',
      url: 'https://github.com/jbcom/persistence-save.git',
    });
    expect(nodeVersion).toBe('26');
    expect(manifest.packageManager).toMatch(/^pnpm@12\.\d+\.\d+$/);
    // A library: the floor is the oldest runtime a fleet game still ships on, with no ceiling.
    expect(manifest.engines).toEqual({ node: '>=24.19.0' });
    expect(manifest.devDependencies?.['@types/node']).toMatch(/^24\./);
  });

  it('pins the admitted dependency matrix and bounded peer ranges', async () => {
    const manifest = await readManifest(path.join(packageRoot, 'package.json'));

    expect(manifest).toMatchObject({
      scripts: {
        'test:consumer': 'node scripts/verify-packed-consumer.mjs',
        verify: 'pnpm lint && pnpm typecheck && pnpm test && pnpm test:consumer',
      },
      dependencies: {
        '@arcade-cabinet/jeep-sqlite': '2.8.0-arcade.2',
        'sql.js': '1.14.1',
      },
      devDependencies: {
        '@capacitor-community/sqlite': '8.1.1',
        '@capacitor/core': '8.5.0',
        '@capacitor/preferences': '8.0.1',
      },
      peerDependencies: {
        '@capacitor-community/sqlite': '>=8.1.1 <9',
        '@capacitor/core': '>=8.5.0 <9',
        '@capacitor/preferences': '>=8.0.1 <9',
      },
    });

    await expect(installedManifest('@capacitor/core')).resolves.toMatchObject({ version: '8.5.0' });
    await expect(installedManifest('@capacitor/preferences')).resolves.toMatchObject({
      version: '8.0.1',
    });
    await expect(installedManifest('@capacitor-community/sqlite')).resolves.toMatchObject({
      version: '8.1.1',
    });
  });

  it('makes the packed consumer mandatory in CI and proves the published bytes anonymously', async () => {
    const ciWorkflow = await readRepoFile('.gitea/workflows/ci.yml');
    const releaseWorkflow = await readRepoFile('.gitea/workflows/release.yml');

    expect(ciWorkflow).toContain('run: pnpm verify');
    expect(releaseWorkflow).toContain('run: pnpm verify');
    expect(releaseWorkflow).toContain('secrets.NPM_TOKEN');
    expect(releaseWorkflow).toMatch(
      /PERSISTENCE_SAVE_CONSUMER_SOURCE="@arcade-cabinet\/persistence-save@\$\{RELEASE_TAG#v\}" pnpm test:consumer/,
    );
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
