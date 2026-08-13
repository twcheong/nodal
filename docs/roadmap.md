# nodal — 로드맵

각 마일스톤은 **데모 가능한 것**으로 끝난다. 리팩터링만 하는 마일스톤은 없다.
총 예상 13~14주 (풀타임 1인, 순차 진행 기준).

**진행 규칙**: 마일스톤을 건너뛰지 않는다. 특히 M1은 UI도 GPU도 없이 CLI만으로 완성한다.

---

## M0 — 뼈대 (1주)

- [x] 모노레포 구조: `packages/core`, `packages/server`, `packages/nodes-core`, `apps/web`
- [x] Python 툴링: `uv` + `ruff` + `pytest`
- [x] JS 툴링: `pnpm` + `vite` + `vitest` + `eslint`
- [x] 캐논 그래프 포맷 pydantic 모델 (`design.md` §4.1)
- [x] JSON 스키마 export (프론트가 소비)
- [x] CI: lint · 타입체크 · 테스트
- [x] `NOTICE-provenance.md` 초기화, DCO 설정

**완료 기준**: 빈 그래프를 검증하고 유효/무효를 판정한다.

> ⚠️ LICENSE 파일은 만들지 않는다. `license.md` 참조.

---

## M1 — 실행 엔진 (2주) ★ 가장 중요

**여기서 프로젝트의 성패가 갈린다. UI도 GPU도 없이 완성한다.**

- [x] `@node` 데코레이터 + 스키마 리플렉션 (`design.md` §4.2)
- [x] 타입 시스템 + 호환성 규칙 + `types.json` 단일 소스 (§4.3)
- [x] `TopologicalSort` / `ExecutionList` — 용해 방식 (§5.1)
- [x] 사이클 탐지 (역방향 용해)
- [x] 입력 시그니처 캐시, 인메모리 LRU (§5.3)
- [x] 동기/비동기 노드 실행 (코루틴 자동 감지)
- [x] 출력 노드 우선 선택 휴리스틱 (§1.1 ②)
- [x] 진행률 이벤트 + 협조적 취소 (§5.4)
- [x] CLI: `nodal run graph.json`

**완료 기준**: 산술 노드 10개짜리 그래프를 CLI로 실행. 입력 하나를 바꾸면 그 아래만 재실행되는 것을 로그로 증명.

**필수 테스트** — 이 셋의 상호작용이 최대 기술 리스크:

- [x] 사이클 탐지
- [x] 다이아몬드 의존성 (A→B, A→C, B→D, C→D)
- [x] 캐시 무효화 전파
- [x] 실행 중 취소
- [x] 실패 노드가 어느 노드·어느 소켓인지 정확히 지목하는지

---

## M2 — 서버 + 최소 UI (2주)

- [ ] FastAPI 서버 + WS 이벤트 브로드캐스트 (`design.md` §6)
- [ ] 단일 워커 실행 큐
- [ ] React Flow 캔버스 — 노드 생성/연결/삭제/이동
- [ ] `/api/nodes`에서 팔레트 자동 생성
- [ ] 타입 기반 소켓 하이라이트 (드래그 중 호환 소켓만 밝게)
- [ ] 그래프 저장/불러오기
- [ ] 실시간 노드 상태 색상 (대기/실행/캐시/에러)
- [ ] 노드 검색 (더블클릭 → 퍼지 검색)

**완료 기준**: 브라우저에서 수학 그래프를 만들고 실행하고 결과를 본다.
**벤치마크**: 200노드 그래프에서 캔버스가 60fps 유지.

---

## M3 — 이미지 파이프라인 (1.5주)

- [ ] `Image` 텐서 타입 (PIL/numpy)
- [ ] 노드: Load / Save / Resize / Crop / Blend / Mask / Composite
- [ ] 노드 내 이미지 프리뷰 위젯
- [ ] `AssetStore` (content-addressed, 해시 파일명)
- [ ] PNG `tEXt` 메타데이터에 워크플로 임베딩
- [ ] PNG 드래그앤드롭 → 워크플로 복원

**완료 기준**: GPU 없이도 쓸모 있는 이미지 처리 도구가 된다.

> 📍 **이 시점에 이미 릴리스 가능.** 첫 공개를 검토한다면 여기. 공개 전에 라이선스를 결정해야 한다 (`license.md`).

---

## M4 — Diffusion (3주)

- [ ] `ModelManager` + `diffusers` 통합 (`design.md` §9)
- [ ] 모델 스캐너 (체크포인트/LoRA/VAE 디렉토리 발견)
- [ ] 노드: LoadCheckpoint / CLIPTextEncode / EmptyLatent / KSampler / VAEDecode
- [ ] 스텝별 latent 프리뷰 스트리밍
- [ ] LoRA 로더
- [ ] ControlNet
- [ ] 시드 컨트롤 위젯 (고정/증가/랜덤)

**완료 기준**: txt2img 워크플로가 SDXL에서 돌고 스텝 프리뷰가 보인다.

> ⚠️ VRAM 관리에서 ComfyUI `model_management.py`를 참조하고 싶어지는 지점. **코드 복사 금지.** 1차는 `accelerate`에 위임한다.

---

## M5 — 고급 실행 (2주)

- [ ] Lazy 입력 + `check_lazy_status` (`design.md` §1.1 ⑤)
- [ ] `ExecutionBlocker` + Switch/Router 노드 (§1.1 ④)
- [ ] 노드 확장(서브그래프 반환) + ephemeral 노드 부모 추적 (§5.2)
- [ ] 서브그래프 노드 (그룹 접기)
- [ ] 배치/리스트 처리 노드
- [ ] `IS_CHANGED` 훅

**완료 기준**: 조건 분기 그래프에서 안 쓰는 브랜치가 실행되지 않음을 로그로 증명.

**필수 테스트**: lazy + 노드 확장 + 캐시가 동시에 걸리는 케이스.

---

## M6 — 확장 + 배포 (2주)

- [ ] 확장 매니페스트 로더 (`design.md` §8)
- [ ] 확장별 격리 환경 (`uv`)
- [ ] 프론트 확장 ESM 동적 로딩
- [ ] Undo/redo (Yjs)
- [ ] 자동 저장 리비전
- [ ] 크로스플랫폼 패키징 (원클릭 런처)
- [ ] 문서 + 노드 저작 가이드

**완료 기준**: 서드파티가 노드 팩을 만들어 설치할 수 있다.

---

## 의도적으로 뺀 것

멀티 GPU, 원격 워커, 클라우드 실행, 협업 편집, 노드 마켓플레이스, API 전용 모드, ComfyUI 워크플로 임포터.

전부 M6 이후 논의.
