import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const packageRoot = path.resolve(import.meta.dirname, '..');
const sqlPackageRoot = path.dirname(require.resolve('sql.js/package.json'));
const source = path.join(sqlPackageRoot, 'dist/sql-wasm.wasm');
const destinationDirectory = path.join(packageRoot, 'dist/assets');

await mkdir(destinationDirectory, { recursive: true });
await copyFile(source, path.join(destinationDirectory, 'sql-wasm.wasm'));
