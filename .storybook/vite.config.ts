// Storybook 전용 Vite 설정.
// 루트 vite.config.ts는 vite-plugin-electron(-renderer)을 로드해 Electron을
// 스폰하므로 재사용하지 않는다 — react 플러그인 + @ alias만 필요.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('../src', import.meta.url)),
    },
  },
})
