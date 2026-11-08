// ビューア（出力する単一 HTML に埋め込む JS）のビルド。1 つの IIFE にまとめ、out/viewer/viewer.js に出す。
// アプリのビルド（electron-vite）の後に実行する（npm run build）。docs/architecture.html 10.2。
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  resolve: { alias: { '@domain': resolve('src/domain') } },
  build: {
    lib: { entry: resolve('src/viewer/index.ts'), formats: ['iife'], name: 'ScheduleViewer', fileName: () => 'viewer.js' },
    outDir: 'out/viewer',
    emptyOutDir: true,
    minify: true,
    target: 'es2022',
    sourcemap: false,
  },
});
