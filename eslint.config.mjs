// ESLint（flat config）。レイヤ境界を強制する（docs/development-rules.html 3、CLAUDE.md）。
//   domain ← shared ← main / preload / renderer / viewer
//   domain: 純 TypeScript（electron / node / react / DOM を使わない）
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

const NODE_BUILTINS = ['assert', 'buffer', 'child_process', 'crypto', 'events', 'fs', 'fs/promises', 'http', 'https', 'net', 'os', 'path', 'stream', 'url', 'util', 'worker_threads', 'zlib'];
const REACT = ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'];
const GLOBALS_DOM_NODE = ['window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'fetch', 'XMLHttpRequest', 'process', 'Buffer', 'require', '__dirname', '__filename'];

/** 層ごとの import 制限を作る。ban = 使えないパッケージ名、layers = import できない他の層。 */
function layerRules(name, { ban = [], banNode = false, layers = [] }) {
  const paths = [...ban, ...(banNode ? ['electron', ...NODE_BUILTINS] : [])].map((p) => ({ name: p, message: `${name} 層では ${p} を import できない（レイヤ境界）` }));
  const patterns = [
    ...(banNode ? [{ group: ['node:*'], message: `${name} 層では node:* を import できない（レイヤ境界）` }] : []),
    ...(layers.length ? [{ group: layers.flatMap((l) => [`**/${l}/**`, `@${l}/*`]), message: `${name} 層から ${layers.join(' / ')} 層は import できない（レイヤ境界）` }] : []),
  ];
  return { files: [`src/${name}/**/*.{ts,tsx}`], rules: { 'no-restricted-imports': ['error', { paths, patterns }] } };
}

export default defineConfig([
  { ignores: ['out/**', 'dist/**', 'node_modules/**', 'coverage/**', 'test-results/**', 'playwright-report/**', 'spike/**', 'scripts/**', 'docs/**', '**/*.mjs', '**/*.js'] },
  tseslint.configs.recommended,
  layerRules('domain', { ban: REACT, banNode: true, layers: ['main', 'preload', 'renderer', 'viewer', 'shared'] }),
  { files: ['src/domain/**/*.ts'], rules: { 'no-restricted-globals': ['error', ...GLOBALS_DOM_NODE.map((g) => ({ name: g, message: 'domain 層は純 TypeScript（DOM / Node のグローバルを使わない）' }))] } },
  layerRules('shared', { ban: REACT, banNode: true, layers: ['main', 'preload', 'renderer', 'viewer'] }),
  layerRules('main', { ban: REACT, layers: ['renderer', 'viewer'] }),
  layerRules('preload', { ban: REACT, layers: ['main', 'renderer', 'viewer'] }),
  layerRules('renderer', { banNode: true, layers: ['main', 'preload'] }),
  layerRules('viewer', { ban: REACT, banNode: true, layers: ['main', 'preload', 'renderer'] }),
]);
