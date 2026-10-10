#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createAnonymousEnvironment } from './anonymous-environment.mjs';

const run = promisify(execFile);
const packageRoot = path.resolve(import.meta.dirname, '..');
const packageManifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
const pinnedPnpm = packageManifest.packageManager.replace(/^pnpm@/, '');
const devPin = (name) => packageManifest.devDependencies[name];
const scratchRoot = await mkdtemp(path.join(tmpdir(), 'persistence-save-consumer-'));
const packDirectory = path.join(scratchRoot, 'pack');
const consumerDirectory = path.join(scratchRoot, 'consumer');
let childEnvironment = process.env;

async function runChecked(file, args, options = {}) {
  try {
    return await run(file, args, {
      ...options,
      env: options.env ?? childEnvironment,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    if (error && typeof error === 'object') {
      if ('stdout' in error && error.stdout) process.stderr.write(String(error.stdout));
      if ('stderr' in error && error.stderr) process.stderr.write(String(error.stderr));
    }
    throw error;
  }
}

try {
  await mkdir(packDirectory, { recursive: true });
  await mkdir(consumerDirectory, { recursive: true });
  const userConfig = path.join(scratchRoot, 'anonymous.npmrc');
  await writeFile(
    userConfig,
    ['registry=https://registry.npmjs.org/', 'audit=false', 'fund=false', ''].join('\n'),
  );
  childEnvironment = createAnonymousEnvironment({
    home: path.join(scratchRoot, 'home'),
    userConfig,
  });

  const pnpmVersion = (await runChecked('pnpm', ['--version'], { cwd: packageRoot })).stdout.trim();
  if (pnpmVersion !== pinnedPnpm) {
    throw new Error(`packed consumer requires pnpm ${pinnedPnpm}, got ${pnpmVersion}`);
  }
  const npmVersion = (await runChecked('npm', ['--version'])).stdout.trim();

  await runChecked('npm', ['pack', '--pack-destination', packDirectory], {
    cwd: packageRoot,
  });
  const archives = (await readdir(packDirectory)).filter((entry) => entry.endsWith('.tgz'));
  if (archives.length !== 1) {
    throw new Error(`expected one packed tarball, found ${archives.length}`);
  }
  const archivePath = path.join(packDirectory, archives[0]);
  const registryConsumerSource = process.env.PERSISTENCE_SAVE_CONSUMER_SOURCE;
  const registryConsumerMatch = registryConsumerSource?.match(
    /^persistence-save@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/,
  );
  if (registryConsumerSource && !registryConsumerMatch) {
    throw new Error(
      'PERSISTENCE_SAVE_CONSUMER_SOURCE must be an exact persistence-save package spec',
    );
  }
  // The consumer's dependency map takes a version or a file: specifier, never a full package spec.
  const consumerSource = registryConsumerMatch?.[1] ?? `file:${archivePath}`;
  const archiveBytes = await readFile(archivePath);
  const archiveSha256 = createHash('sha256').update(archiveBytes).digest('hex');
  const archiveEntries = new Set(
    (await runChecked('tar', ['-tzf', archivePath])).stdout.trim().split('\n'),
  );
  for (const requiredEntry of [
    'package/CHANGELOG.md',
    'package/LICENSE',
    'package/README.md',
    'package/THIRD_PARTY_NOTICES.md',
    'package/dist/assets/sql-wasm.wasm',
    'package/dist/assets/sql-wasm-browser.wasm',
  ]) {
    if (!archiveEntries.has(requiredEntry)) {
      throw new Error(`npm tarball is missing ${requiredEntry}`);
    }
  }
  if ([...archiveEntries].some((entry) => entry.includes('node_modules'))) {
    throw new Error('npm tarball contains node_modules leakage');
  }

  await writeFile(
    path.join(consumerDirectory, 'package.json'),
    `${JSON.stringify(
      {
        name: 'persistence-save-clean-consumer',
        private: true,
        type: 'module',
        packageManager: packageManifest.packageManager,
        dependencies: {
          'persistence-save': consumerSource,
          '@capacitor-community/sqlite': devPin('@capacitor-community/sqlite'),
          '@capacitor/core': devPin('@capacitor/core'),
          '@capacitor/preferences': devPin('@capacitor/preferences'),
        },
        devDependencies: {
          '@types/node': devPin('@types/node'),
          typescript: devPin('typescript'),
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(consumerDirectory, '.npmrc'),
    [
      'registry=https://registry.npmjs.org/',
      'audit=false',
      'fund=false',
      'auto-install-peers=false',
      'strict-peer-dependencies=true',
      '',
    ].join('\n'),
  );
  // Prevent an unrelated ancestor workspace file from absorbing this proof.
  await writeFile(path.join(consumerDirectory, 'pnpm-workspace.yaml'), 'packages: []\n');

  await runChecked('pnpm', ['install', '--ignore-workspace'], { cwd: consumerDirectory });

  const esmProof = `
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  createAutoSaveScheduler,
  createPersistence,
  migrateSnapshot,
} from 'persistence-save';

const legacy = { version: 1, name: 'player-one', gold: 7 };
const migrated = migrateSnapshot(legacy, 2, {
  1: (old) => ({ ...old, version: 2, party: [] }),
});
assert.deepEqual(migrated, {
  version: 2,
  name: 'player-one',
  gold: 7,
  party: [],
});
assert.equal(JSON.stringify(legacy), '{"version":1,"name":"player-one","gold":7}');
assert.equal(typeof createAutoSaveScheduler, 'function');
assert.equal(typeof createPersistence, 'function');

const wasmAssets = ['sql-wasm.wasm', 'sql-wasm-browser.wasm'];
for (const asset of wasmAssets) {
  const assetUrl = import.meta.resolve(
    \`persistence-save/assets/\${asset}\`,
  );
  const bytes = await readFile(fileURLToPath(assetUrl));
  assert.ok(bytes.byteLength > 500_000, \`\${asset} is unexpectedly small\`);
  assert.deepEqual([...bytes.subarray(0, 4)], [0, 97, 115, 109]);
  await WebAssembly.compile(bytes);
}

console.log('esm-ok:wasm=' + wasmAssets.join(','));
`;
  const cjsProof = `
const assert = require('node:assert/strict');
const persistence = require('persistence-save');

assert.equal(typeof persistence.createPersistence, 'function');
assert.equal(typeof persistence.createPreferencesKv, 'function');
assert.equal(typeof persistence.migrateSnapshot, 'function');
assert.equal(
  persistence.migrateSnapshot({ version: 2, hp: 41 }, 2, {}).hp,
  41,
);
console.log('cjs-ok');
`;
  const typeProof = `
import {
  createPersistence,
  type PersistenceConfig,
  type VersionedSnapshot,
} from 'persistence-save';

interface State {
  name: string;
  gold: number;
}

interface Snapshot extends VersionedSnapshot, State {}

const config = {
  dbName: 'com.example.external_consumer_v1',
  snapshotVersion: 2,
  serialize: (state: State): Snapshot => ({ ...state, version: 2 }),
  deserialize: ({ name, gold }: Snapshot): State => ({ name, gold }),
  migrations: {
    1: (snapshot: Record<string, unknown>) => ({ ...snapshot, version: 2 }),
  },
} satisfies PersistenceConfig<State, Snapshot>;

const persistence = createPersistence(config);
void persistence.load(1);
`;
  const typeConfig = {
    compilerOptions: {
      exactOptionalPropertyTypes: true,
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      noEmit: true,
      noUncheckedIndexedAccess: true,
      strict: true,
      target: 'ES2022',
      types: ['node'],
    },
    include: ['type-proof.ts', 'type-proof.cts'],
  };
  await writeFile(path.join(consumerDirectory, 'esm-proof.mjs'), esmProof);
  await writeFile(path.join(consumerDirectory, 'cjs-proof.cjs'), cjsProof);
  await writeFile(path.join(consumerDirectory, 'type-proof.ts'), typeProof);
  await writeFile(path.join(consumerDirectory, 'type-proof.cts'), typeProof);
  await writeFile(
    path.join(consumerDirectory, 'tsconfig.json'),
    `${JSON.stringify(typeConfig, null, 2)}\n`,
  );

  const esm = await runChecked(process.execPath, ['esm-proof.mjs'], { cwd: consumerDirectory });
  const cjs = await runChecked(process.execPath, ['cjs-proof.cjs'], { cwd: consumerDirectory });
  await runChecked('pnpm', ['exec', 'tsc', '--project', 'tsconfig.json'], {
    cwd: consumerDirectory,
  });
  const lockfile = await readFile(path.join(consumerDirectory, 'pnpm-lock.yaml'), 'utf8');
  const sourceReference = `specifier: ${consumerSource}`;
  if (!lockfile.includes(sourceReference)) {
    const persistenceLines = lockfile
      .split('\n')
      .filter((line) => line.includes('persistence-save') || line.includes('file:'))
      .join('\n');
    throw new Error(`consumer did not resolve ${sourceReference}:\n${persistenceLines}`);
  }
  if (/\b(?:link|workspace):/.test(lockfile)) {
    throw new Error('consumer lockfile contains a workspace or link dependency');
  }

  const installedPackageRoot = path.join(consumerDirectory, 'node_modules/persistence-save');
  const resolvedPackageRoot = await realpath(installedPackageRoot);
  const resolvedConsumerRoot = await realpath(consumerDirectory);
  if (!resolvedPackageRoot.startsWith(`${resolvedConsumerRoot}${path.sep}`)) {
    throw new Error(`installed package leaked outside the consumer: ${resolvedPackageRoot}`);
  }
  const installedManifest = JSON.parse(
    await readFile(path.join(installedPackageRoot, 'package.json'), 'utf8'),
  );
  const installedLicense = await readFile(path.join(installedPackageRoot, 'LICENSE'), 'utf8');
  const installedNotices = await readFile(
    path.join(installedPackageRoot, 'THIRD_PARTY_NOTICES.md'),
    'utf8',
  );
  if (!installedLicense.includes('Copyright (c) 2026 Jon Bogaty')) {
    throw new Error('installed package-local LICENSE is missing the copyright line');
  }
  if (
    !installedNotices.includes('Copyright (c) 2017 sql.js authors') ||
    !installedNotices.includes('Copyright 2017 Ryusei Yamaguchi')
  ) {
    throw new Error('installed third-party notice is missing sql.js MIT attribution');
  }
  // A second consumer with no Capacitor at all (a game on another Capacitor major, or none):
  // the autosave scheduler and the migration walker install and run without the peers.
  const freeDirectory = path.join(scratchRoot, 'capacitor-free-consumer');
  await mkdir(freeDirectory, { recursive: true });
  await writeFile(
    path.join(freeDirectory, 'package.json'),
    `${JSON.stringify(
      {
        name: 'persistence-save-capacitor-free-consumer',
        private: true,
        type: 'module',
        packageManager: packageManifest.packageManager,
        dependencies: { 'persistence-save': consumerSource },
        devDependencies: {
          '@types/node': devPin('@types/node'),
          typescript: devPin('typescript'),
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(freeDirectory, '.npmrc'),
    await readFile(path.join(consumerDirectory, '.npmrc'), 'utf8'),
  );
  await writeFile(path.join(freeDirectory, 'pnpm-workspace.yaml'), 'packages: []\n');
  await runChecked('pnpm', ['install', '--ignore-workspace'], { cwd: freeDirectory });
  for (const peer of ['@capacitor/core', '@capacitor-community/sqlite', '@capacitor/preferences']) {
    const present = await readFile(
      path.join(freeDirectory, 'node_modules', peer, 'package.json'),
      'utf8',
    ).then(
      () => true,
      () => false,
    );
    if (present) throw new Error(`the Capacitor-free consumer installed ${peer}`);
  }
  await writeFile(
    path.join(freeDirectory, 'free-proof.mjs'),
    `
import assert from 'node:assert/strict';
import { createAutoSaveScheduler } from 'persistence-save/autosave';
import { migrateSnapshot } from 'persistence-save/migrations';

let saves = 0;
const scheduler = createAutoSaveScheduler({ provider: () => ({ at: 1 }), save: async () => { saves += 1; } });
await scheduler.flush();
assert.equal(saves, 1);
assert.equal(migrateSnapshot({ version: 1, hp: 3 }, 2, { 1: (old) => ({ ...old, version: 2 }) }).version, 2);
console.log('capacitor-free-esm-ok');
`,
  );
  await writeFile(
    path.join(freeDirectory, 'free-proof.cjs'),
    `
const assert = require('node:assert/strict');
assert.equal(typeof require('persistence-save/autosave').createAutoSaveScheduler, 'function');
assert.equal(typeof require('persistence-save/migrations').migrateSnapshot, 'function');
console.log('capacitor-free-cjs-ok');
`,
  );
  await writeFile(
    path.join(freeDirectory, 'free-proof.ts'),
    `
import { type AutoSaveScheduler, createAutoSaveScheduler } from 'persistence-save/autosave';
import { migrateSnapshot, type VersionedSnapshot } from 'persistence-save/migrations';

const scheduler: AutoSaveScheduler = createAutoSaveScheduler({ provider: () => 1, save: async () => {} });
const saved = { version: 1 } satisfies VersionedSnapshot;
const snapshot: Record<string, unknown> = migrateSnapshot(saved, 1, {});
void scheduler;
void snapshot;
`,
  );
  await writeFile(
    path.join(freeDirectory, 'tsconfig.json'),
    `${JSON.stringify({ ...typeConfig, include: ['free-proof.ts'] }, null, 2)}\n`,
  );
  const freeEsm = await runChecked(process.execPath, ['free-proof.mjs'], { cwd: freeDirectory });
  const freeCjs = await runChecked(process.execPath, ['free-proof.cjs'], { cwd: freeDirectory });
  await runChecked('pnpm', ['exec', 'tsc', '--project', 'tsconfig.json'], { cwd: freeDirectory });

  // A third consumer on another Capacitor major (6), with default peer checking: the optional
  // peers are present at a version outside their range, so the install reports them unmet but
  // goes ahead, and the two Capacitor-free entries still load and run.
  const otherMajorDirectory = path.join(scratchRoot, 'other-capacitor-consumer');
  await mkdir(otherMajorDirectory, { recursive: true });
  await writeFile(
    path.join(otherMajorDirectory, 'package.json'),
    `${JSON.stringify(
      {
        name: 'persistence-save-other-capacitor-consumer',
        private: true,
        type: 'module',
        packageManager: packageManifest.packageManager,
        dependencies: { 'persistence-save': consumerSource, '@capacitor/core': '6.2.1' },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(otherMajorDirectory, '.npmrc'),
    [
      'registry=https://registry.npmjs.org/',
      'audit=false',
      'fund=false',
      'auto-install-peers=false',
      '',
    ].join('\n'),
  );
  await writeFile(path.join(otherMajorDirectory, 'pnpm-workspace.yaml'), 'packages: []\n');
  await runChecked('pnpm', ['install', '--ignore-workspace'], { cwd: otherMajorDirectory });
  await writeFile(
    path.join(otherMajorDirectory, 'free-proof.mjs'),
    await readFile(path.join(freeDirectory, 'free-proof.mjs'), 'utf8'),
  );
  const otherMajor = await runChecked(process.execPath, ['free-proof.mjs'], {
    cwd: otherMajorDirectory,
  });

  const installedVersions = {};
  for (const packageName of [
    '@capacitor-community/sqlite',
    '@capacitor/core',
    '@capacitor/preferences',
  ]) {
    const manifest = JSON.parse(
      await readFile(
        path.join(consumerDirectory, 'node_modules', packageName, 'package.json'),
        'utf8',
      ),
    );
    installedVersions[packageName] = manifest.version;
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        package: `${installedManifest.name}@${installedManifest.version}`,
        tarball: archives[0],
        sha256: archiveSha256,
        node: process.version,
        pnpm: pnpmVersion,
        npm: npmVersion,
        peers: installedVersions,
        esm: esm.stdout.trim(),
        cjs: cjs.stdout.trim(),
        capacitorFree: [freeEsm.stdout.trim(), freeCjs.stdout.trim(), 'types-ok'],
        capacitor6: otherMajor.stdout.trim(),
        types: 'external-consumer-ok',
        wasm: ['sql-wasm.wasm', 'sql-wasm-browser.wasm'],
        installedRoot: resolvedPackageRoot,
        workspaceLeakage: false,
        licenses: ['LICENSE', 'THIRD_PARTY_NOTICES.md'],
        source: process.env.PERSISTENCE_SAVE_CONSUMER_SOURCE
          ? `npm-registry:${registryConsumerSource}`
          : 'npm-packed-tarball',
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await rm(scratchRoot, { force: true, recursive: true });
}
