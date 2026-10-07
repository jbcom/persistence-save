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
  publishConfig?: Record<string, unknown>;
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
  it('is a public package built and released on the current toolchain', async () => {
    const manifest = await readManifest(path.join(packageRoot, 'package.json'));
    const nodeVersion = (await readRepoFile('.nvmrc')).trim();

    expect(manifest.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/jbcom/persistence-save.git',
    });
    expect(manifest.publishConfig).toEqual({ access: 'public', provenance: true });
    expect(nodeVersion).toBe('26');
    expect(manifest.packageManager).toMatch(/^pnpm@12\.\d+\.\d+$/);
    // A library: the floor is the oldest supported Node line, with no ceiling.
    expect(manifest.engines).toEqual({ node: '>=24' });
    expect(manifest.devDependencies?.['@types/node']).toMatch(/^24\./);
    // Everything resolves from the public registry; no scoped or private registry may creep back.
    const npmrc = await readRepoFile('.npmrc');
    expect(npmrc).toContain('registry=https://registry.npmjs.org/');
    expect(npmrc).not.toMatch(/^@[^:]+:registry=/m);
  });

  it('pins the admitted dependency matrix and bounded peer ranges', async () => {
    const manifest = await readManifest(path.join(packageRoot, 'package.json'));

    expect(manifest).toMatchObject({
      scripts: {
        'test:consumer': 'node scripts/verify-packed-consumer.mjs',
      },
      dependencies: {
        'jeep-sqlite-current-sqljs': '2.9.0',
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

  it('makes the full gate mandatory in CI and publishes verified tags by OIDC only', async () => {
    const manifest = await readManifest(path.join(packageRoot, 'package.json'));
    const ciWorkflow = await readRepoFile('.github/workflows/ci.yml');
    const cdWorkflow = await readRepoFile('.github/workflows/cd.yml');

    // `verify` is the one gate: lint, docs lint, types, coverage, build, package shape, packed consumer.
    for (const step of [
      'lint',
      'lint:docs',
      'typecheck',
      'coverage',
      'build',
      'package:check',
      'test:consumer',
    ]) {
      expect(manifest.scripts?.verify).toContain(`pnpm run ${step}`);
    }
    expect(ciWorkflow).toContain('run: pnpm verify');
    // The publish job runs from the release tag, re-verifies it, and publishes with provenance by
    // OIDC. No long-lived npm token exists for this package.
    const publishJob = cdWorkflow.slice(cdWorkflow.indexOf('  publish:'));
    expect(publishJob).toContain('id-token: write');
    expect(publishJob).toMatch(/ref: \$\{\{ steps\.release\.outputs\.tag \}\}[\s\S]+?pnpm verify/);
    expect(publishJob).toContain('npm publish --access public --provenance');
    expect(`${ciWorkflow}\n${cdWorkflow}`).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN/);
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
