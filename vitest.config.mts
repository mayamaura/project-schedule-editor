import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@domain': resolve('src/domain'),
      '@shared': resolve('src/shared'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // ドメイン層のカバレッジ閾値（ロードマップ Phase 1: 90%）
    coverage: {
      provider: 'v8',
      include: ['src/domain/**/*.ts', 'src/main/fileRepository.ts'],
      exclude: ['src/domain/index.ts'],
      reporter: ['text-summary', 'text'],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 85 },
    },
  },
});
