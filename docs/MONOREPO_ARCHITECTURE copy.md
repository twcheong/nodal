# Twixy Enterprise / Twixy 모노레포 아키텍처

## 전체 구조 설명

### 먼저 "왜 이 구조인가"부터

앱이 여러 개 생기면 자연스럽게 이런 문제가 생깁니다:

> "Twixy 채팅 버그 고쳤는데, Twixy Enterprise에도 똑같이 고쳐야 하나?"

이 문제를 없애는 게 핵심입니다. **코드를 한 곳에만 두고, 여러 앱이 가져다 쓰는** 구조가 해답입니다.

---

### 전체 폴더 구조

```
/workspace                   ← 모든 것의 루트 (새로 만드는 폴더)
  │
  ├── packages/              ← "재료 창고" - 앱들이 가져다 쓰는 공통 코드
  │     ├── twixy-core/      ← Twixy 앱의 모든 기능 (채팅, UI, hooks 등)
  │     └── appb-core/       ← 나중에 생길 앱B의 모든 기능
  │
  └── apps/                  ← "완성품" - 실제로 유저가 설치하는 앱들
        ├── twixy/           ← Twixy 앱 (twixy-core를 가져다 씀)
        ├── appb/            ← 앱B (appb-core를 가져다 씀)
        └── twixy-enterprise/          ← 어드민 앱 (core들을 가져다 씀 + 어드민 패널)
              src/
                shell/       ← Twixy Enterprise 공통 틀 (로그인, 사이드바, 라우팅)
                admin-twixy/ ← Twixy 전용 어드민 패널
                admin-appb/  ← 앱B 전용 어드민 패널
```

---

### 각 폴더가 뭘 하는지

**`packages/twixy-core`**
- 현재 Twixy의 `src/` 폴더가 이쪽으로 이사옴
- 채팅창, 훅, API 연결 등 Twixy의 실제 기능이 다 여기 있음
- 어드민이 뭔지 **모름**. 그냥 기능만 제공하는 "부품"

**`apps/twixy`**
- 유저가 다운받는 Twixy 앱
- 내부 코드는 거의 없음. `twixy-core`를 가져다가 창에 띄우는 역할만 함

```tsx
// apps/twixy/src/App.tsx
import { TwixyApp } from 'twixy-core'

export default function App() {
  return <TwixyApp />  // twixy-core가 다 해줌
}
```

**`apps/twixy-enterprise`**
- 어드민용 앱
- `twixy-core`를 가져와서 Twixy 기능을 그대로 띄우고
- 거기에 어드민 패널을 **추가로** 붙임

```tsx
// apps/twixy-enterprise/src/App.tsx
import { TwixyApp } from 'twixy-core'
import { TwixyAdminPanel } from './admin-twixy'

export default function App() {
  return (
    <>
      <TwixyApp />          // Twixy 그대로
      <TwixyAdminPanel />   // 어드민 패널 추가
    </>
  )
}
```

**`apps/twixy-enterprise/src/admin-twixy`**
- Twixy 어드민 패널 코드
- **오직 Twixy Enterprise 안에만 존재** — Twixy 앱 자체는 어드민 패널을 모름
- `twixy-core`가 노출하는 데이터를 읽어서 어드민 UI를 구성함

---

### 업데이트가 어떻게 흐르는가

```
twixy-core에서 채팅 버그 수정
           │
           ├──→ apps/twixy   ✅ 자동 반영 (같은 코드를 씀)
           └──→ apps/twixy-enterprise  ✅ 자동 반영 (같은 코드를 씀)
```

`twixy-core`만 고치면 끝. Twixy와 Twixy Enterprise 둘 다 동시에 반영됩니다.

---

### 앱B가 생기면

```
packages/appb-core/ 추가
apps/appb/ 추가

apps/twixy-enterprise/src/admin-appb/ 추가
```

Twixy Enterprise에 appb 어드민 패널만 꽂으면 됩니다. 기존 코드는 안 건드려도 됩니다.

---

### Twixy + 앱B 동시에 관리하는 Twixy Enterprise

```tsx
// apps/twixy-enterprise/src/App.tsx
import { TwixyApp } from 'twixy-core'
import { AppBApp } from 'appb-core'
import { TwixyAdminPanel } from './admin-twixy'
import { AppBAdminPanel } from './admin-appb'

export default function App() {
  return (
    <Shell>
      <TwixyApp />
      <AppBApp />
      <TwixyAdminPanel />
      <AppBAdminPanel />
    </Shell>
  )
}
```

---

### 핵심 원칙 3가지

| 원칙 | 내용 |
|------|------|
| **코드는 한 곳에** | 기능 코드는 `packages/`에만, 앱은 그걸 가져다 씀 |
| **앱은 어드민을 모름** | 어드민 패널은 오직 Twixy Enterprise 안에만 존재 |
| **조합으로 확장** | 새 앱 = core 패키지 하나 추가, Twixy Enterprise = 원하는 core 조합 |

---

## 현재 Twixy 구조 → 모노레포 구조 변환

### 지금 Twixy 구조

```
Twixy Marketing Copilot/
  src/
    App.tsx
    main.tsx                    ← 앱 진입점
    global.d.ts
    components/
      AdminPanel.tsx            ← ⚠️ 현재 Twixy 안에 있음
      ChatPanel.tsx
      ComposerBar.tsx
      ConnectingSplash.tsx
      DashboardPanel.tsx
      DataPanel.tsx
      LoginScreen.tsx
      MergeRequestPanel.tsx
      PlanCard.tsx
      SettingsPanel.tsx
      SetupScreen.tsx
      Sidebar.tsx
      SidetabOverlay.tsx
      SkillsPanel.tsx
      StatusBar.tsx
      UpgradeModal.tsx
    hooks/
      useAuth.ts
      useDashboardClaw.ts
      useEntitlements.ts
      useOpenClaw.ts
      useOverlaySync.ts
      usePlans.ts
      useProjectDir.ts
    lib/
      entitlements.ts
      supabase.ts
    styles/
      globals.css
    composer/
      main.tsx
    sidetab/
      main.tsx
  electron/
    main.ts
    preload.ts
    mr.ts
    planning.ts
    tsl-compiler.ts
    tsl-types.ts
  index.html
  package.json
  vite.config.ts
```

---

### 변환 후 모노레포 구조

```
workspace/                            ← 새로 만드는 루트 폴더
  package.json                        ← 워크스페이스 설정 (신규)
  │
  packages/
    twixy-core/                       ← ✅ 현재 src/ 대부분이 여기로 이사
      src/
        App.tsx                       ← 이사 (TwixyApp으로 export)
        global.d.ts                   ← 이사
        components/
          ChatPanel.tsx               ← 이사
          ComposerBar.tsx             ← 이사
          ConnectingSplash.tsx        ← 이사
          DashboardPanel.tsx          ← 이사
          DataPanel.tsx               ← 이사
          LoginScreen.tsx             ← 이사
          MergeRequestPanel.tsx       ← 이사
          PlanCard.tsx                ← 이사
          SettingsPanel.tsx           ← 이사
          SetupScreen.tsx             ← 이사
          Sidebar.tsx                 ← 이사
          SidetabOverlay.tsx          ← 이사
          SkillsPanel.tsx             ← 이사
          StatusBar.tsx               ← 이사
          UpgradeModal.tsx            ← 이사
          # AdminPanel.tsx 없음 ✅
        hooks/                        ← 이사 (그대로)
        lib/                          ← 이사 (그대로)
        styles/                       ← 이사 (그대로)
        composer/                     ← 이사 (그대로)
        sidetab/                      ← 이사 (그대로)
      package.json                    ← 신규
  │
  apps/
    twixy/                            ← ✅ 껍데기만 남음
      src/
        main.tsx                      ← 그대로 (진입점)
      electron/                       ← 이사 (그대로)
      index.html                      ← 그대로
      package.json                    ← 수정 (twixy-core 의존성 추가)
      vite.config.ts                  ← 수정 (경로 조정)
    │
    twixy-enterprise/                           ← ✅ 신규 생성
      src/
        main.tsx                      ← 신규 (진입점)
        App.tsx                       ← 신규 (TwixyApp + 어드민)
        shell/                        ← 신규 (공통 레이아웃)
        admin-twixy/
          AdminPanel.tsx              ← 현재 Twixy의 AdminPanel.tsx가 여기로 이사
      electron/                       ← twixy electron 복사 후 수정
      index.html                      ← 신규
      package.json                    ← 신규
```

---

### 파일별 행선지 요약

| 현재 위치 | 이동 후 위치 | 비고 |
|-----------|-------------|------|
| `src/components/ChatPanel.tsx` 외 대부분 | `packages/twixy-core/src/components/` | 코드 변경 없이 이사만 |
| `src/hooks/*` | `packages/twixy-core/src/hooks/` | 코드 변경 없이 이사만 |
| `src/lib/*` | `packages/twixy-core/src/lib/` | 코드 변경 없이 이사만 |
| `src/styles/*` | `packages/twixy-core/src/styles/` | 코드 변경 없이 이사만 |
| `src/App.tsx` | `packages/twixy-core/src/App.tsx` | `export`만 추가 |
| `src/main.tsx` | `apps/twixy/src/main.tsx` | 그대로 |
| `src/components/AdminPanel.tsx` | `apps/twixy-enterprise/src/admin-twixy/AdminPanel.tsx` | Twixy Enterprise로 이사 |
| `electron/*` | `apps/twixy/electron/` | 그대로 |

---

### 실제로 코드가 바뀌는 부분

대부분은 **파일 이동만**이고, 코드 변경은 딱 두 곳입니다.

**1. twixy-core: App.tsx에 export 추가**
```tsx
// packages/twixy-core/src/App.tsx
// 기존 코드 그대로 + 마지막 줄에 export 추가
export { App as TwixyApp }
```

**2. apps/twixy: twixy-core를 가져다 씀**
```tsx
// apps/twixy/src/main.tsx
import { TwixyApp } from 'twixy-core'  // ← import 경로만 바뀜
```

**3. apps/twixy-enterprise: Twixy + 어드민 조합**
```tsx
// apps/twixy-enterprise/src/App.tsx (신규)
import { TwixyApp } from 'twixy-core'
import { AdminPanel } from './admin-twixy/AdminPanel'

export default function App() {
  return (
    <>
      <TwixyApp />
      <AdminPanel />
    </>
  )
}
```

---

### 한 줄 요약

> 현재 `src/` 안에 뒤섞여 있는 코드를 **기능(core)** 과 **어드민** 으로 분리해서 각자 제자리에 두는 것

실제 파일 내용은 거의 안 바뀌고, **폴더 위치와 import 경로**가 바뀌는 게 전부입니다.
