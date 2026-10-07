---
title: Web assets
description: Serve the sql.js WebAssembly binaries the web runtime needs.
---

On the web, saves live in an in-memory sql.js database inside the jeep-sqlite
web component, flushed to IndexedDB after every write. sql.js needs its
WebAssembly binary at runtime, and the binary must match the sql.js version
jeep-sqlite was built against. persistence-save ships both builds it needs, so
you never mix versions:

| Export | File |
| --- | --- |
| `persistence-save/assets/sql-wasm.wasm` | `dist/assets/sql-wasm.wasm` |
| `persistence-save/assets/sql-wasm-browser.wasm` | `dist/assets/sql-wasm-browser.wasm` |

Copy both into the directory you pass as `wasmAssetsPath` (default `/assets`).
With Vite, for example:

```ts
import { viteStaticCopy } from 'vite-plugin-static-copy';

export default {
  plugins: [
    viteStaticCopy({
      targets: [
        {
          src: 'node_modules/persistence-save/dist/assets/*.wasm',
          dest: 'assets',
        },
      ],
    }),
  ],
};
```

Native builds do not use these files.
