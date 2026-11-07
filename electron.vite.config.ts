import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

const alias = {
  '@domain': resolve('src/domain'),
  '@shared': resolve('src/shared'),
};

// CSP（NF-007）。本番は外部通信・インラインスクリプトを全面禁止（スタイルの inline 属性のみ許可）。
// 開発（HMR）時だけ、dev サーバとの通信とインラインスクリプトを許可する。
const csp = {
  prod: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'",
  dev: "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://localhost:* http://localhost:*; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'",
};

export default defineConfig({
  main: { resolve: { alias } },
  preload: { resolve: { alias } },
  renderer: {
    root: 'src/renderer',
    resolve: { alias },
    plugins: [
      react(),
      {
        name: 'inject-csp',
        transformIndexHtml: (html, ctx) => html.replace('__CSP__', ctx.server ? csp.dev : csp.prod),
      },
    ],
    build: { rollupOptions: { input: resolve('src/renderer/index.html') } },
  },
});
