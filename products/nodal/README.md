# Nodal (데스크톱 앱)

B2C 영상 생성 앱. **Twixy 와 같은 레포·같은 에이전트 코어**를 쓰고, 이 폴더에 Nodal 에만 있는 것을 둔다.
영상 엔진은 `engine/` 에 있다 — [twcheong/nodal](https://github.com/twcheong/nodal) 을 **git subtree 로 편입**한 것이고, 이제 이 레포가 원본이다. 앱은 엔진의 로컬 서버 MCP (`http://127.0.0.1:8188/mcp`, Streamable HTTP) 에 붙는 클라이언트다.

## electron 브랜치 통합 (2026-10-01)

`twcheong/nodal`의 `electron` 브랜치는 별도 로컬 앱 저장소
`Appggong/twixy-marketing-copilot`의 `feature/nodal-studio` 커밋 `389066a`를
기반으로 한다. 여기에 엔진 저장소의 Qwen 작업 `faabeaf`까지를
`products/nodal/engine/` 경로로 병합했다. 기존 엔진 전용 `main`과 원본 앱 브랜치는
변경하지 않는다. 앱의 과거 테스트 토큰이 GitHub push 보호에 걸려 앱은 현재 소스의
스냅샷으로 편입하고, 엔진 main/Qwen 이력을 부모로 보존한다. 원본 앱을 포함한
전체 merge 이력은 로컬 `codex/electron-source-history` 브랜치에 남긴다.

- 앱의 스튜디오·엔진 자동 복구·Z-Image 최적화·영상 이어 붙이기를 유지한다.
- Qwen Image 2.1 노드와 생성·편집·3장 합성 MCP 템플릿, 준비 도구 및 테스트를 포함한다.
- 기존 11컷 영상의 요청·실행·검수 기록도 `engine/output/`에 보존한다.
  모델 가중치와 미추적 이미지·영상 파일은 이 브랜치로 복사하지 않는다.

Qwen은 **별도 런타임 준비가 필요하다**. 앱의 기본 설치 마법사는 기존 H3/Z-Image
런타임을 설치하며 Qwen용 Diffusers 개발판을 자동 설치하지 않는다.
[Qwen 실행 안내](engine/docs/qwen-image-21.md)의 명령은 `products/nodal/engine/`에서
실행한다. 별도 Qwen 서버 기본 포트는 8210, 앱의 엔진 포트는 8188이다.
별도 서버를 시작하는 것만으로 앱의 MCP 연결이 바뀌지는 않는다.
Qwen 모델의 기존 비상업 연구·평가용 사용 조건도 유지한다.

개발 앱에서 Qwen을 사용할 때는 엔진 설치를 먼저 마친 뒤, 해당 엔진 가상환경에
Qwen 런타임을 준비하고 `NODAL_QWEN21_MODEL`을 실제 가중치 폴더로 지정한 같은
터미널에서 `npm run dev:nodal`을 실행한다. 앱은 `--no-sync`로 그 환경을 실행하므로
Qwen 노드와 번들 템플릿을 앱의 8188 엔진에서 사용할 수 있다. 설치 마법사를 다시
실행하면 고정 lock 환경으로 돌아가므로 Qwen 준비도 다시 필요하다. 이 경로의
실제 GPU 생성 및 Qwen 개발판에서 H3와의 동시 호환성은 이번 통합에서 재검증하지 않았다.

앱 및 엔진 검사 결과는 [통합 검증 기록](integration-validation.md)에 남긴다.

## 내가 일할 범위

| 위치 | 소유 | 비고 |
|---|---|---|
| `products/nodal/**` | **Nodal 팀** | 여기서만 일한다 |
| `electron/`, `src/`, `shared/`, `patches/`, `skills/` | Twixy 팀 (공용 코어) | 고치려면 Twixy 팀 리뷰 필수 (`.github/CODEOWNERS`) |
| `products/twixy*/` | Twixy 팀 | import 금지 |

코어를 고치고 싶어질 때는 먼저 "코어가 제품을 몰라도 되는 형태"인지 본다. 코어에 `if (제품 === 'nodal')` 을 쓰지 않는다 — 대신 `profile.ts` 의 `features` 에 값을 추가하고 코어는 그 값을 읽게 한다. `npm run lint` 의 `check:boundary` 가 이 규칙을 검사한다.

## 폴더

```
products/nodal/
  profile.ts      제품 설정 — appId, 포트, 상태 폴더, Supabase, 켜고 끄는 기능, 패키징(엔진·uv 동봉)
  engineConfig.ts 엔진 포트·MCP 주소 (profile 과 electron 이 같이 읽는 단일 출처)
  index.html      렌더러 진입 html
  renderer/       Nodal 전용 화면
    main.tsx        진입점 — App 렌더 전에 생성 모드·탭(노드·엔진)·로고를 등록, 첫 실행이면 엔진 탭으로
    videoMode.tsx   채팅 모드 정의 (코어의 src/lib/copilotModes.ts 에 등록)
    VideoPanel.tsx  오른쪽 패널 — 이 대화의 실행·결과, 취소, outputs/ 저장 (runOwnership.ts 가 대화 귀속)
    nodes/          노드 탭 — engine/apps/web 에디터를 복사 없이 탑재 (IPC 클라이언트·CSS 스코프·템플릿 변환)
    setup/          엔진·모델 탭 — 런타임 설치·모델 팩·로그
    engineApi.ts    렌더러 → 메인 호출 래퍼
  electron/       Nodal 전용 메인 프로세스 코드
    index.ts        registerMain — 엔진 수명주기 훅 + productInvoke('nodal-*') 핸들러
    engineManager.ts  엔진 기동·헬스·종료·로그 (uv run nodal serve)
    setup.ts        첫 실행 설치 — uv sync · 모델 팩 이어받기·sha256
    modelPacks.ts   모델 팩 목록 (출처·크기·라이선스)
    engine.ts       엔진 REST 클라이언트 + 렌더러 중계 (루프백 전용)
  scripts/        fetch-uv.mjs (uv 받기) · engine-e2e.ts (실제 엔진 E2E)
  backend/        웹 백엔드 (Vercel) — 로그인 핸드오프 페이지 + LLM 키·사용량·요금제 API
  supabase/       Nodal 전용 Supabase 프로젝트 (CLI workdir) — config.toml, migrations/
  workspace-seed/ 새 워크스페이스에 심는 SOUL.md · AGENTS.md (에이전트 시스템 프롬프트)
  assets/         icon.icns / icon.ico / entitlements.mac.plist — 있으면 공용 assets/ 대신 쓴다
  engine/         생성 엔진 (git subtree ← twcheong/nodal). Python 서버·MCP·노드 에디터·템플릿
```

## 엔진 (`engine/`)

- **닫힌 폴더다.** 엔진 코드는 앱(코어·`products/nodal` 의 다른 폴더)을 import 하지 않는다 — `check:boundary` 규칙 4. 앱 → 엔진 방향만 허용.
- 앱의 tsc·eslint·vitest 대상이 아니다. 엔진 자체 검사: `cd products/nodal/engine && uv run pytest` · `corepack pnpm install && corepack pnpm -r test`.
- 원래 레포에 새 커밋이 생겼으면: `git subtree pull --prefix=products/nodal/engine https://github.com/twcheong/nodal.git main`
- Apache-2.0 — 배포물에 `engine/LICENSE`·`engine/NOTICE` 를 같이 넣어야 한다. 모델 가중치는 라이선스가 따로다.

## 코어에 끼우는 자리 (코어를 고치지 않고 기능을 추가하는 법)

| 하고 싶은 것 | 자리 |
|---|---|
| 채팅 모드 + 오른쪽 패널 | `registerCopilotMode()` — `src/lib/copilotModes.ts` |
| 사이드바 탭 · 로고 · 탭 이동 | `registerProductView()` · `setProductLogo()` · `navigateToView()` — `src/lib/productShell.ts` |
| 게이트웨이 전에 띄울 것 · 종료 정리 · 게이트웨이 재시작 | `ctx.onBeforeGatewayStart` · `ctx.onQuit` · `ctx.restartAgentRuntime` |
| 설치 파일에 더 실을 것 | `profile.ts` 의 `packaging` |
| 메인 프로세스 기능 (IPC) | `registerMain(ctx)` 에서 `ctx.handle('이름', fn)` → 렌더러에서 `window.twixy.productInvoke('이름', payload)` |
| 에이전트가 쓸 툴 제한, 내장 MCP, 워크스페이스 폴더 | `profile.ts` 의 `features` |
| 에이전트 시스템 프롬프트 | `workspace-seed/SOUL.md` |

## 실행

```bash
npm install
npm run prepare:nodal-uv   # uv 받기 (tmp/nodal-uv, 한 번)
npm run dev:nodal          # 개발 — 엔진 탭에서 "설치하기" 한 번 (또는 아래 uv sync)
npm run dist:nodal:win     # Windows 설치 파일 (x64, 엔진 소스 + uv.exe 동봉)
```

개발 PC(Mac)에서 엔진만 손으로 설치: `tmp/nodal-uv/uv sync --project products/nodal/engine --frozen --group diffusion --group upscale --no-group dev`
실제 엔진 E2E (LLM·로그인 없이): `npx tsx products/nodal/scripts/engine-e2e.ts <빈 폴더>`

Mac 에서는 CPU/MPS 로 돌아 무모델 템플릿(thumbnail·product_card)과 UI 개발까지만 된다. 영상(H3)은 Windows + NVIDIA 전용.

`dev:nodal` 은 `APP_MODE=nodal` 로 `scripts/write-product.ts` 를 돌려 빌드 대상을 Nodal 로 구워 넣는다. Twixy 로 돌아가려면 `npm run dev`.

Twixy 와 같은 PC 에서 동시에 떠도 된다 — 상태 폴더(`~/.nodal-agent`), 게이트웨이 포트(18889), 딥링크 스킴(`nodal://`)이 전부 다르다. 엔진이 `~/.nodal` 을 쓰므로 앱은 그 이름을 피했다.

## Supabase

Twixy 와 **다른 프로젝트**다 ("Nodal Project", ref `vbwempftdyuuegcoqizl`). 레포 루트의 `supabase/` 는 Twixy 것이므로 건드리지 않는다 — Nodal 은 항상 `--workdir` 를 붙인다.

```bash
supabase migration list --workdir products/nodal
supabase db push --dry-run --workdir products/nodal   # 무엇이 올라갈지 먼저 본다
supabase db push --workdir products/nodal
```

스키마는 `docs/BACKEND_CONTRACT.md` §5 의 테이블들이다. OpenRouter 키는 Twixy 와 달리 클라이언트가 읽을 수 없는 별도 테이블(`user_openrouter_keys`)에 둔다.

## 백엔드 (로그인)

`backend/public/auth/desktop-callback.html` — 서버 코드 없는 정적 페이지. 앱이 이 주소를 브라우저로 열면 Google 로그인 → 세션 교환 → `nodal://auth#…` 로 앱에 넘긴다. supabase-js 는 CDN 이 아니라 `public/vendor/` 에 고정 버전으로 들어 있다.

```bash
cd products/nodal/backend
vercel            # 첫 배포 (프로젝트 연결 질문에 답한다) — 미리보기 주소
vercel --prod     # 프로덕션 주소
```

배포 후 할 일 두 가지:
1. Supabase 대시보드 → Authentication → URL Configuration → **Redirect URLs** 에 `https://<배포 주소>/auth/desktop-callback` 추가. 빠지면 로그인 후 Site URL 로 튕긴다(에러 없이 조용히 실패).
2. `profile.ts` 의 `webUrl` 에 `https://<배포 주소>` 를 넣는다 → 앱이 "백엔드 미설정" 대신 로그인 화면을 띄운다.

### API (`backend/api/`)

`docs/BACKEND_CONTRACT.md` §2–4 의 네 엔드포인트. 프레임워크 없이 Vercel 함수(`export function GET/POST`)이고, Supabase·OpenRouter 는 SDK 없이 REST 로 부른다 (`backend/lib/`).

Vercel 프로젝트 → Settings → Environment Variables 에 **직접** 넣어야 하는 값 (레포에 넣지 않는다):

| 이름 | 값 |
|---|---|
| `SUPABASE_URL` | `https://vbwempftdyuuegcoqizl.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_…` (profile.ts 와 같은 값) |
| `SUPABASE_SECRET_KEY` | Supabase → Settings → API Keys 의 **secret** 키 (`sb_secret_…`). RLS 를 우회한다 — 절대 앱·레포에 넣지 않는다 |
| `OPENROUTER_PROVISIONING_KEY` | OpenRouter **Management key** (예전 이름 Provisioning key). 사용자별 키를 만들고·조회하고·한도를 바꾸는 데 쓴다 |
| `OPENROUTER_WORKSPACE_ID` | OpenRouter 조직 안의 `nodal` 워크스페이스 id (UUID). 사용자 키를 이 워크스페이스에 만든다 — 비우면 조직 기본 워크스페이스(Twixy 쪽)에 생겨 비용·키 목록이 섞인다 |
| `NODAL_FREE_BUDGET_USD` / `NODAL_PRO_BUDGET_USD` | (선택) 월 LLM 예산. 기본 2 / 5 |

넣은 뒤 `vercel --prod` 로 다시 배포해야 반영된다. 테스트: `npx vitest run products/nodal/backend`

로컬에서 페이지만 볼 때: `npm run dev` (이 폴더에서) → http://localhost:3000/auth/desktop-callback

## 아직 없는 것

- 결제 (Stripe) — 지금은 전원 free 요금제다. `user_subscriptions.tier` 를 `pro` 로 바꾸는 경로가 아직 없다.
- **Vercel 백엔드 환경변수** — 배포된 `nodal-inky` 가 `SUPABASE_URL not set` 으로 500 을 낸다 (LLM 키 발급 불가 → 채팅 불가). `backend/` 위 표의 변수를 Vercel 에 넣고 `vercel --prod`.
- Windows 실기 검증 — CUDA 설치(uv sync --extra cuda)·모델 팩 다운로드·H3 영상 생성은 Windows+NVIDIA PC 에서 아직 안 돌려 봤다. Mac 에서는 엔진 기동·MCP·템플릿 저장까지 실제 엔진으로 확인했다.
- 모델 가중치 상용 라이선스 확인 — 특히 MiniMax H3 ("other"). `electron/modelPacks.ts` 머리 주석.
- 텍스트→이미지 템플릿 — 번들의 `ad_backdrop`·`product_ad_scene` 은 테스트용 초소형 SDXL(`hf-internal-testing/tiny-sd-pipe`)을 가리킨다. 실제 모델 템플릿이 필요하다.
- Nodal 아이콘(icon.ico/icns) — 지금은 사이드바 로고(assets/logo.svg)만 있다.
