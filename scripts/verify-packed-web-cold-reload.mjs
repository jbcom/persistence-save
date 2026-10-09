#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';
import { createAnonymousEnvironment } from './anonymous-environment.mjs';

const run = promisify(execFile);
const packageRoot = path.resolve(import.meta.dirname, '..');
const packageManifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
const pinnedPnpm = packageManifest.packageManager.replace(/^pnpm@/, '');
const devPin = (name) => packageManifest.devDependencies[name];
const scratchRoot = await mkdtemp(path.join(tmpdir(), 'persistence-save-web-cold-reload-'));
const packDirectory = path.join(scratchRoot, 'pack');
const consumerDirectory = path.join(scratchRoot, 'consumer');
let childEnvironment = process.env;
let viteProcess;
let browser;
const viteOutput = [];

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

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

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('could not allocate a local Vite port');
  }
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function waitForServer(url, output) {
  const deadline = Date.now() + 30_000;
  let lastError = 'server did not start';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = `server responded ${response.status}`;
    } catch (error) {
      lastError = errorMessage(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Vite did not become ready: ${lastError}\n${output.join('')}`);
}

async function stopVite() {
  if (!viteProcess || viteProcess.exitCode !== null) return;
  viteProcess.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => viteProcess.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (viteProcess.exitCode === null) {
    viteProcess.kill('SIGKILL');
    await new Promise((resolve) => viteProcess.once('exit', resolve));
  }
}

const appSource = `
import { createPersistence } from 'persistence-save';

const dbName = 'com.example.persistence.cold-reload-v1';
const mode = new URLSearchParams(location.search).get('mode');
const diagnostics = {
  dbName,
  mode,
  elementDefined: false,
  elementPresent: false,
  storeOpen: null,
  userVersion: null,
  records: [],
  error: null,
  done: false,
};
window.__persistenceColdReload = diagnostics;

function describeError(error) {
  return error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error);
}

async function main() {
  try {
    const saves = createPersistence({
      dbName,
      snapshotVersion: 1,
      serialize: (state) => ({ ...state, version: 1 }),
      deserialize: (snapshot) => ({ name: snapshot.name }),
      migrations: {},
    });

    if (mode === 'write') {
      await saves.save('slot-one', { name: 'Player One' });
    }

    diagnostics.records = (await saves.list()).map((record) => ({
      id: record.id,
      name: record.name,
      snapshot: record.snapshot,
    }));
    diagnostics.userVersion = await saves.withConnection(
      async (connection) => {
        const result = await connection.query('PRAGMA user_version;');
        return result.values?.[0]?.user_version ?? null;
      },
      null,
    );
    const element = document.querySelector('jeep-sqlite');
    diagnostics.elementDefined = Boolean(customElements.get('jeep-sqlite'));
    diagnostics.elementPresent = Boolean(element);
    diagnostics.storeOpen = element ? await element.isStoreOpen() : null;
  } catch (error) {
    diagnostics.error = describeError(error);
  } finally {
    diagnostics.done = true;
    const resultElement = document.querySelector('#result');
    if (resultElement) resultElement.textContent = JSON.stringify(diagnostics);
  }
}

void main();
`;

const indexSource = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <link rel="icon" href="data:,">
    <title>persistence-save cold reload probe</title>
  </head>
  <body><pre id="result">booting</pre><script type="module" src="/src/main.js"></script></body>
</html>
`;

async function readStoredBytes(page, dbName) {
  return page.evaluate(async (databaseName) => {
    const request = indexedDB.open('jeepSqliteStore');
    const database = await new Promise((resolve, reject) => {
      request.addEventListener('success', () => resolve(request.result), { once: true });
      request.addEventListener('error', () => reject(request.error), { once: true });
    });
    try {
      const transaction = database.transaction('databases', 'readonly');
      const valueRequest = transaction.objectStore('databases').get(`${databaseName}SQLite.db`);
      const value = await new Promise((resolve, reject) => {
        valueRequest.addEventListener('success', () => resolve(valueRequest.result), {
          once: true,
        });
        valueRequest.addEventListener('error', () => reject(valueRequest.error), { once: true });
      });
      return {
        key: `${databaseName}SQLite.db`,
        byteLength:
          value instanceof Uint8Array || value instanceof ArrayBuffer
            ? value.byteLength
            : ArrayBuffer.isView(value)
              ? value.byteLength
              : null,
        stored: value !== null && value !== undefined,
      };
    } finally {
      database.close();
    }
  }, dbName);
}

try {
  if (!(await readdir(packageRoot)).includes('dist')) {
    throw new Error('web cold-reload proof requires a built dist directory; run pnpm build first');
  }
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
    throw new Error(`packed web consumer requires pnpm ${pinnedPnpm}, got ${pnpmVersion}`);
  }

  await runChecked('npm', ['pack', '--ignore-scripts', '--pack-destination', packDirectory], {
    cwd: packageRoot,
  });
  const archives = (await readdir(packDirectory)).filter((entry) => entry.endsWith('.tgz'));
  if (archives.length !== 1) {
    throw new Error(`expected one packed tarball, found ${archives.length}`);
  }
  const archivePath = path.join(packDirectory, archives[0]);
  await writeFile(
    path.join(consumerDirectory, 'package.json'),
    `${JSON.stringify(
      {
        name: 'persistence-save-web-cold-reload-consumer',
        private: true,
        type: 'module',
        packageManager: packageManifest.packageManager,
        dependencies: {
          'persistence-save': `file:${archivePath}`,
          '@capacitor-community/sqlite': devPin('@capacitor-community/sqlite'),
          '@capacitor/core': devPin('@capacitor/core'),
          '@capacitor/preferences': devPin('@capacitor/preferences'),
        },
        devDependencies: { vite: devPin('vite') },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(consumerDirectory, '.npmrc'),
    ['registry=https://registry.npmjs.org/', 'audit=false', 'fund=false', ''].join('\n'),
  );
  await writeFile(path.join(consumerDirectory, 'pnpm-workspace.yaml'), 'packages: []\n');
  await runChecked('pnpm', ['install', '--ignore-workspace'], { cwd: consumerDirectory });

  const installedPackageRoot = await realpath(
    path.join(consumerDirectory, 'node_modules/persistence-save'),
  );
  const resolvedConsumerRoot = await realpath(consumerDirectory);
  if (!installedPackageRoot.startsWith(`${resolvedConsumerRoot}${path.sep}`)) {
    throw new Error(`installed package leaked outside the consumer: ${installedPackageRoot}`);
  }
  if (
    (await readFile(path.join(consumerDirectory, 'pnpm-lock.yaml'), 'utf8')).includes('workspace:')
  ) {
    throw new Error('web consumer lockfile contains a workspace dependency');
  }

  await mkdir(path.join(consumerDirectory, 'src'), { recursive: true });
  await cp(
    path.join(installedPackageRoot, 'dist/assets'),
    path.join(consumerDirectory, 'public/assets'),
    {
      recursive: true,
    },
  );
  await writeFile(path.join(consumerDirectory, 'index.html'), indexSource);
  await writeFile(path.join(consumerDirectory, 'src/main.js'), appSource);

  const port = await unusedPort();
  const url = `http://127.0.0.1:${port}`;
  viteProcess = spawn(
    process.execPath,
    [
      path.join(consumerDirectory, 'node_modules/vite/bin/vite.js'),
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
    ],
    {
      cwd: consumerDirectory,
      env: childEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  viteProcess.stdout.on('data', (chunk) => viteOutput.push(String(chunk)));
  viteProcess.stderr.on('data', (chunk) => viteOutput.push(String(chunk)));
  await waitForServer(url, viteOutput);

  browser = await chromium.launch({ headless: false, args: ['--mute-audio'] });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  await page.goto(`${url}/?mode=write`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__persistenceColdReload?.done === true);
  const write = await page.evaluate(() => window.__persistenceColdReload);
  if (write.error) throw new Error(`write realm error: ${JSON.stringify(write.error)}`);
  const stored = await readStoredBytes(page, write.dbName);
  if (!stored.stored || !stored.byteLength || stored.byteLength <= 0) {
    throw new Error(`save did not persist IndexedDB bytes: ${JSON.stringify(stored)}`);
  }

  // A full navigation tears down the module graph and facade, making this a
  // fresh JavaScript realm while preserving the browser origin's IndexedDB.
  await page.goto(`${url}/?mode=read`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__persistenceColdReload?.done === true);
  const read = await page.evaluate(() => window.__persistenceColdReload);
  if (read.error) throw new Error(`cold read realm error: ${JSON.stringify(read.error)}`);
  if (
    read.records.length !== 1 ||
    read.records[0]?.name !== 'slot-one' ||
    read.records[0]?.snapshot?.name !== 'Player One'
  ) {
    throw new Error(`cold read did not restore the saved row: ${JSON.stringify(read)}`);
  }
  if (!read.elementDefined || !read.elementPresent || read.storeOpen !== true) {
    throw new Error(`cold read jeep-sqlite was not ready: ${JSON.stringify(read)}`);
  }
  if (consoleErrors.length > 0) {
    throw new Error(`browser console errors: ${consoleErrors.join('\n')}`);
  }

  const evidence = {
    package: `persistence-save@${packageManifest.version}`,
    tarball: archives[0],
    source: 'npm-packed-tarball',
    browser: 'chromium-headed-muted',
    write,
    indexedDb: stored,
    coldRead: read,
    workspaceLeakage: false,
  };
  const diagnosticLog = process.env.PERSISTENCE_SAVE_WEB_PROBE_LOG;
  if (diagnosticLog) {
    await writeFile(diagnosticLog, `${JSON.stringify({ outcome: 'pass', evidence }, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
} catch (error) {
  const diagnosticLog = process.env.PERSISTENCE_SAVE_WEB_PROBE_LOG;
  if (diagnosticLog) {
    await writeFile(
      diagnosticLog,
      `${JSON.stringify(
        {
          outcome: 'fail',
          error: errorMessage(error),
          viteOutput,
        },
        null,
        2,
      )}\n`,
    );
  }
  throw error;
} finally {
  await browser?.close();
  await stopVite();
  await rm(scratchRoot, { force: true, recursive: true });
}
