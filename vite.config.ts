import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import path from 'path'
import fs from 'fs'

// 앱 버전을 렌더러에 주입 — 이슈 리포트(session_reports.app_version)의 트리아지에
// 필수다. "업데이트 후 깨졌어요" 에 답하려면 어느 빌드인지 알아야 한다.
const pkgVersion = (JSON.parse(
  fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'),
) as { version: string }).version

// 빌드 대상 제품 — scripts/write-product.ts 가 dev/build 직전에 떨군 프로필 사본.
// 제품의 진입 html 과, 그 제품이 켠 기능의 보조 창 html 만 번들에 넣는다
// (다른 제품의 화면은 빌드 산출물에 아예 들어가지 않는다).
const product = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, 'tmp/product.json'), 'utf8'),
) as { htmlEntry: string; features: { sidetab: boolean; workflows: boolean } }

export default defineConfig(({ command }) => {
  // Only emit sourcemaps for the dev server (`vite`, command === 'serve').
  // `vite build` (command === 'build') is our production/dist path — shipping
  // .map files there lets anyone reconstruct the original TSX/TS source from a
  // packaged app, so keep them out of production. NOTE: we key off `command`
  // rather than NODE_ENV because `npm run build` does NOT set NODE_ENV, so a
  // `process.env.NODE_ENV !== 'production'` check would wrongly stay `true`
  // during the production build and re-enable sourcemaps.
  const emitSourcemap = command === 'serve'

  return {
  define: {
    __APP_VERSION__: JSON.stringify(pkgVersion),
  },
  plugins: [
    react(),
    electron([
      {
        entry: 'electron/main.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            // Keep main-process sourcemaps out of the packaged app too.
            sourcemap: emitSourcemap,
            rollupOptions: {
              // ws ships optional native acceleration deps that we don't bundle.
              // sharp is a NATIVE module (platform-specific .node binaries
              // resolved by dynamic require) — bundling it breaks at app load
              // ("Could not dynamically require sharp-darwin-arm64.node").
              // It stays external and loads from node_modules at runtime;
              // packaging already ships node_modules via asarUnpack.
              external: ['bufferutil', 'utf-8-validate', 'sharp'],
            },
          },
        },
      },
      {
        entry: 'electron/preload.ts',
        onstart(options) {
          options.reload()
        },
        vite: {
          build: {
            outDir: 'dist-electron',
            sourcemap: emitSourcemap,
          },
        },
      },
    ]),
    renderer(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      // Nodal 노드 에디터(products/nodal/engine/apps/web)가 쓰는 별칭 — 그 앱의 vite.config 와 같은 값.
      // import 될 때만 풀리므로 다른 제품 번들에는 영향이 없다.
      '@nodal/schemas': path.resolve(__dirname, 'products/nodal/engine/schemas'),
      '@nodal/types': path.resolve(__dirname, 'products/nodal/engine/packages/core/src/nodal/types.json'),
    },
  },
  server: {
    port: 5173,
  },
  build: {
    // Sourcemaps are emitted ONLY under the dev server so production crashes
    // that surface in dev (e.g. React minified errors like #300) still resolve
    // to the original component/line in DevTools. In a production build
    // (`vite build`) we deliberately omit .map files so the shipped renderer
    // bundle cannot be trivially de-minified back to original source.
    sourcemap: emitSourcemap,
    rollupOptions: {
      input: {
        main:      path.resolve(__dirname, product.htmlEntry),
        guardrail: path.resolve(__dirname, 'guardrail.html'),
        ...(product.features.sidetab ? {
          sidetab:  path.resolve(__dirname, 'sidetab.html'),
          composer: path.resolve(__dirname, 'composer.html'),
        } : {}),
        ...(product.features.workflows ? {
          testOverlay: path.resolve(__dirname, 'test-overlay.html'),
        } : {}),
      },
    },
  },
  }
})
