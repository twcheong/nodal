// electron-builder 설정 — 제품 프로필에서 파생한다.
//
// 제품별 값(appId, 이름, 딥링크 스킴, 동봉 리소스)은 여기 적지 않는다. 단일 출처는
// products/<id>/profile.ts 이고, scripts/write-product.ts 가 빌드 직전에 그 사본을
// tmp/product.json 으로 떨군다 (이 파일은 TS 를 import 할 수 없다).
// 제품 고유 자산(아이콘·entitlements)은 products/<id>/assets/ 에 같은 파일명으로 두면
// 공용 assets/ 대신 그걸 쓴다.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const productJson = path.join(ROOT, 'tmp', 'product.json')
if (!fs.existsSync(productJson)) {
  throw new Error('tmp/product.json 이 없다 — `npm run build` (또는 tsx scripts/write-product.ts) 를 먼저 실행할 것')
}
const product = JSON.parse(fs.readFileSync(productJson, 'utf8'))
const { displayName: name, features } = product

/** products/<id>/assets/<file> 가 있으면 그걸, 없으면 공용 assets/<file>. */
const asset = (file) => {
  const own = path.join('products', product.id, 'assets', file)
  return fs.existsSync(path.join(ROOT, own)) ? own : path.join('assets', file)
}

// 관리형 Chrome 을 띄워 화면을 읽고 조작하는 제품에만 필요한 권한 문구.
const browserUsage = features.browser ? {
  NSScreenCaptureUsageDescription: `${name} captures screenshots of websites you ask it to monitor and analyze, so it can read pages your browser is showing.`,
  NSAppleEventsUsageDescription: `${name} uses Apple Events to control your browser and other apps when you ask it to automate a task.`,
  NSAccessibilityUsageDescription: `${name} uses accessibility features to read on-screen content and operate the browser on your behalf.`,
  NSDownloadsFolderUsageDescription: `${name} moves browser downloads (CSV / images / PDFs) into your workspace so you can use them in the dashboard.`,
} : {}

export default {
  appId: product.appId,
  productName: name,
  directories: { output: 'release' },
  artifactName: `${name.replace(/\s+/g, '-')}-Setup-\${version}-\${os}-\${arch}.\${ext}`,
  files: [
    '**/*',
    '!.claude/**/*',
    '!.storybook/**/*',
    '!src/**/*',
    '!products/**/*',
    '!scripts/**/*',
    '!patches/**/*',
    '!docs/**/*',
    '!tmp/**/*',
    '!stories/**/*',
    '!*.md',
    '!tsconfig*.json',
    '!*.config.ts',
    '!*.config.mjs',
    // 어느 제품도 쓰지 않는 openclaw 확장 + 문서 (~112MB). 확장 로더는 manifest 스캔이
    // graceful 하고 config/enabledByDefault 로 lazy 활성화라, 디렉터리가 없으면 카탈로그에서
    // 빠질 뿐 크래시하지 않는다. 패치는 core dist 만 건드려 무관.
    '!node_modules/openclaw/dist/extensions/diffs/**',
    '!node_modules/openclaw/dist/extensions/feishu/**',
    '!node_modules/openclaw/dist/extensions/amazon-bedrock/**',
    '!node_modules/openclaw/docs/**',
    // …단 docs/reference/templates 는 문서가 아니라 런타임 자산이다. 세션이 워크스페이스를
    // 초기화할 때 AGENTS.md/SOUL.md 등을 여기서 읽고, 없으면 첫 턴이 통째로 죽는다
    // ("Missing workspace template: AGENTS.md"). 13개 파일 ~100KB 라 슬림화 효과도 없다.
    'node_modules/openclaw/docs/reference/templates/**',
  ],
  win: {
    icon: asset('icon.ico'),
    target: [{ target: 'nsis', arch: product.packaging?.winArch ?? ['x64', 'arm64'] }],
  },
  mac: {
    category: 'public.app-category.productivity',
    icon: asset('icon.icns'),
    target: [{ target: 'dmg', arch: ['arm64', 'x64'] }],
    entitlements: asset('entitlements.mac.plist'),
    entitlementsInherit: asset('entitlements.mac.plist'),
    hardenedRuntime: true,
    gatekeeperAssess: false,
    notarize: { teamId: 'W3RR3R43VQ' },
    extendInfo: {
      CFBundleURLTypes: [{ CFBundleURLName: `${name} Auth`, CFBundleURLSchemes: [product.protocolScheme] }],
      ...browserUsage,
      NSLocalNetworkUsageDescription: `${name} talks to its own local OpenClaw gateway over 127.0.0.1 to run agents and tools on your machine.`,
      NSDocumentsFolderUsageDescription: `${name} reads and writes files inside your workspace folder when you save or export data.`,
      NSDesktopFolderUsageDescription: `${name} may read files you drop on the Desktop when you ask it to.`,
      NSCameraUsageDescription: `${name} does not use the camera. This entry is required only because the embedded browser engine declares the capability.`,
      NSMicrophoneUsageDescription: `${name} does not record audio. This entry is required only because the embedded browser engine declares the capability.`,
    },
  },
  protocols: [{ name, schemes: [product.protocolScheme] }],
  asarUnpack: ['node_modules/**/*'],
  // openclaw 은 여기서 따로 싣지 않는다. 게이트웨이는 asarUnpack 된
  // app.asar.unpacked/node_modules/openclaw (patch-package 로 패치된 실 사본)에서 실행되고,
  // 예전에 tmp/openclaw-bundle/node_modules → resources/node_modules 로 한 벌 더 싣던 것은
  // 런타임에 아무도 참조하지 않는 ~626MB 죽은 무게였다 (설치 크기·백신 스캔의 최대 원인).
  extraResources: [
    ...(features.libreoffice  ? [{ from: 'tmp/libreoffice-bundle', to: 'libreoffice' }] : []),
    ...(features.bundledSkills ? [{ from: 'skills', to: 'skills' }] : []),
    // 워크스페이스에 심을 기본 프롬프트 — 제품마다 다른 폴더에서 가져와 같은 자리에 둔다.
    { from: path.posix.join(product.workspaceSeedDir, 'SOUL.md'), to: 'SOUL.md' },
    { from: path.posix.join(product.workspaceSeedDir, 'AGENTS.md'), to: 'AGENTS.md' },
    // 제품만 싣는 것 (예: Nodal 의 엔진 소스 + uv) — profile.packaging.extraResources.
    ...(product.packaging?.extraResources ?? []),
  ],
}
