#!/usr/bin/env node
// Marks dist/cjs as CommonJS (dist/esm inherits the package's top-level
// "type": "module") so Node's dual-package resolution doesn't misinterpret
// the .js files under dist/cjs as ESM.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const cjsDir = resolve(import.meta.dirname, '..', 'dist', 'cjs');
mkdirSync(cjsDir, { recursive: true });
writeFileSync(
  resolve(cjsDir, 'package.json'),
  JSON.stringify({ type: 'commonjs' }, null, 2) + '\n',
);
