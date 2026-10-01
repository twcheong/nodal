# Electron / Qwen 통합 검증

2026-10-01, Windows. 대상: `twcheong/nodal`의 `electron` 브랜치.

## 병합 범위

- 앱 기준: 로컬 `Appggong/twixy-marketing-copilot`, `feature/nodal-studio`,
  `389066a` (2026-09-25). 로컬에만 있던 스튜디오 후속 작업도 포함한다.
- 엔진 추가: `twcheong/nodal`, `codex/qwen-image-21-mcp`, `faabeaf` (2026-09-23).
  공통 엔진 이력을 기준으로 `products/nodal/engine`에 subtree 경로를 맞춰 병합했다.
- Qwen 생성·편집·합성 노드/MCP 템플릿과 준비 도구, 기존 제작 provenance를 보존한다.
  앱 쪽의 ConcatVideo·Z-Image·H3 보호 기능과 API 확장은 그대로 유지한다.
- 원본 두 작업 폴더, 기존 `main`, 모델 및 미추적 미디어는 변경하지 않는다.

GitHub push 보호가 앱의 과거 커밋 `63acf6e`에 있는 Slack 토큰 형식 테스트
문자열을 거부했다. 현재 `shared/secretMask.test.ts`는 일반 fixture로 바꾸고,
앱 소스를 스냅샷으로 편입해 해당 과거 커밋을 전송 대상에서 제외했다. 엔진 main과
Qwen 이력은 부모로 유지하며, 원본 앱 이력을 포함한 첫 merge `49ae1cd`는 로컬
`codex/electron-source-history`에 보존한다. push 보호 예외 승인은 사용하지 않는다.

## 검사

검사 로그는 통합 worktree의 `tmp/electron-integration/`에 있으며 Git에는 넣지 않는다.
Electron 검사는 원본 앱의 기존 `node_modules`를 junction으로 재사용했다.
엔진 전체 CI는 스크립트가 만든 잡별 격리 환경과 고정 lock을 사용했다.

| 검사 | 결과 | 로그 |
|---|---|---|
| `npm run build:nodal` | 통과 — Electron main/preload 및 React 렌더러 빌드 | `app-build.log` |
| `npm run check:boundary` | 통과 | `app-boundary.log` |
| `tsc --noEmit` (앱 루트) | 통과 | `app-typecheck.log` |
| `vitest run products/nodal` | 12개 파일, 85개 테스트 통과, 1개 건너뜀 | `app-tests.log` |
| `vitest run shared/secretMask.test.ts` | 11개 테스트 통과 | `secret-mask-tests.log` |
| `bash products/nodal/engine/tools/ci-local.sh` | 25단계 통과, 실패 0, GitHub 전용 10단계 건너뜀 | `engine-ci-verified.log` |

초기 전체 검사의 실패는 Windows mypy 타입 경계 5건과 H3 비교 템플릿 테스트
2건이었다. 동적 파이프라인 타입과 ctypes·numpy 수치 반환형을 최소 수정했다.
모델을 모의 실행하는 비교 테스트는 실제 PC의 메모리 압력과 분리했다.
실제 H3 메모리 보호 기능 및 별도 부족 메모리 테스트는 유지한다.
앱 엔진의 `get_run` 기본 장기 대기에 맞춰 Qwen 검증 도구만 명시적 폴링으로 조정했다.

## 확인하지 않은 것

- 설치 파일(NSIS/DMG) 생성·설치 및 코드 서명은 이번 요청의 검증 범위에 포함하지 않았다.
- GPU 이미지·영상 생성은 새로 실행하지 않았다. Qwen의 기존 실측은 엔진 문서와
  provenance에 기록되어 있으며 이번 병합의 실측으로 재분류하지 않는다.
- Qwen의 선택적 개발판 런타임을 앱 설치 마법사가 자동 설치하지 않는다.
  기본 H3/Z-Image 런타임과 다른 준비 경로는 [앱 안내](README.md)에 적었다.
- 위 결과는 로컬 검사 결과이며 GitHub Actions 실행 결과가 아니다.
