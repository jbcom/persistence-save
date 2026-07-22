import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const packageRoot = path.resolve(import.meta.dirname, '..');
const sqlDistRoot = path.dirname(require.resolve('sql.js'));
const destinationDirectory = path.join(packageRoot, 'dist/assets');

await mkdir(destinationDirectory, { recursive: true });
for (const assetName of ['sql-wasm.wasm', 'sql-wasm-browser.wasm']) {
  await copyFile(path.join(sqlDistRoot, assetName), path.join(destinationDirectory, assetName));
}
