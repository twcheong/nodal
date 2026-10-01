import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

// Standalone from vite.config.ts on purpose: that config loads vite-plugin-electron,
// which would try to build the Electron main process during test runs. Tests only
// need the React renderer + jsdom, so we keep a minimal config here.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      // vite.config.ts 와 같게 — Nodal 패널이 엔진 웹 에디터 코드를 가져다 쓰고, 그 코드가 이 별칭을 import 한다.
      '@nodal/types': path.resolve(__dirname, 'products/nodal/engine/packages/core/src/nodal/types.json'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'products/**/*.{test,spec}.{ts,tsx}', 'electron/**/*.{test,spec}.ts', 'shared/**/*.{test,spec}.ts'],
    // electron/ 테스트는 `electron` 을 import 하지 않는 순수 모듈만 대상으로 하고,
    // 파일 머리에 `// @vitest-environment node` 를 단다 (기본 환경이 jsdom 이라서).
    exclude: ['node_modules', 'dist', 'dist-electron', 'products/nodal/engine/**'],
  },
})
