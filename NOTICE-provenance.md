# 외부 프로젝트 참조 기록 (Provenance)

이 파일의 목적은 **"nodal은 아키텍처를 참조했을 뿐 코드를 이식하지 않았다"를 스스로 증명할 수 있게** 하는 것이다.
nodal 은 **Apache-2.0** 이다 (→ `docs/license.md`). GPL 코드가 한 줄이라도 섞였다면 그 배포는
자기 `LICENSE` 와 모순된다. 이 기록이 그런 일이 없었음을 보이는 근거다.

> ⚠️ 이 파일은 `NOTICE` 와 **다른 파일**이다. `NOTICE` 는 Apache-2.0 §4(d) 가 요구하는
> 법적 귀속 고지이고, 이 파일은 내부 증빙이다. 재배포 시 필요한 것은 `NOTICE` 쪽이다.

---

## 기록 규칙

외부 프로젝트(특히 GPL/AGPL)를 참조할 때마다 아래 형식으로 항목을 추가한다.

```
### YYYY-MM-DD — <프로젝트> <파일/모듈>
- **라이선스**: 
- **참조한 것**: (아이디어/알고리즘/구조 — 구체적으로)
- **구현 방식**: (백지 구현 / 문서 기반 / 코드 참조)
- **복사 여부**: 없음 / 있음(→ 즉시 에스컬레이션)
```

**"복사 여부: 있음"이 한 번이라도 기록되면 Apache-2.0 배포가 무효가 된다.** 그런 항목이 생기면 즉시 소유자에게 알리고 해당 코드를 제거·재작성한다.

### 저작권이 보호하는 것 / 아닌 것

| 보호되지 않음 (자유롭게 참조 가능) | 보호됨 (복사 금지) |
|---|---|
| 아이디어, 알고리즘, 아키텍처 | 구체적인 코드 표현 |
| "출력 노드를 우선 실행한다"는 발상 | 그 발상을 구현한 함수 본문 |
| 데이터 구조의 개념적 설계 | 클래스 정의와 메서드 구조 |
| API 형태에 대한 일반적 관례 | 주석, 변수명 패턴, 코드 배치 |

---

## 기록

### 2026-08-11 — ComfyUI (Comfy-Org/ComfyUI) 아키텍처 조사

- **라이선스**: GPL-3.0
- **참조한 파일**:
  - `comfy_execution/graph.py` — `TopologicalSort`, `ExecutionList`, `DynamicPrompt`, 출력 노드 우선 선택 휴리스틱, 역방향 용해 기반 사이클 탐지
  - `execution.py` — 실행 루프 구조, lazy 입력 처리, `IsChangedCache`, 에러 리포팅 방식
  - `comfy_extras/nodes_images.py` — 선언형 노드 스키마(`IO.Schema`) 스타일, 조건부 입력(`DynamicCombo`), PNG `tEXt` 메타데이터 주입 개념
  - `LICENSE` — 라이선스 확인
- **참조한 것**: 그래프 실행 모델의 **개념** — 점진적 위상 용해, 입력 시그니처 기반 캐싱, 실행 블로커 센티넬, lazy 입력, 노드 확장 시 부모 ID 추적. 그리고 **버릴 부채**의 식별 — 이중 그래프 포맷, 문자열 소켓 타입, 딕셔너리-튜플 스키마.
- **구현 방식**: 위 개념을 `docs/design.md`에 자연어 스펙으로 서술. **구현은 그 문서를 스펙으로 삼아 백지에서 진행한다.** ComfyUI 저장소를 clone하거나 파일을 열어놓고 작업하지 않는다.
- **복사 여부**: **없음**

### 2026-08-11 — M0 구현 (뼈대 · 캐논 그래프 모델)

- **참조한 외부 프로젝트**: **없음**
- **구현 근거**: `docs/design.md` §4.1 (캐논 그래프 포맷) 및 `docs/roadmap.md` M0.
- **구현 방식**: 문서 기반 백지 구현. ComfyUI 저장소를 clone 하거나 파일을 열지 않았고,
  네트워크로 가져오지도 않았다. 캐논 포맷은 ComfyUI 의 이중 그래프 포맷을 **버리는**
  설계이므로 참조할 대응물 자체가 없다 (`design.md` §1.2 ①).
- **복사 여부**: **없음**
- **범위**: `packages/core`(`nodal.graph`, `nodal.errors`), `tools/export_schema.py`,
  `apps/web/src/graph/*`, 툴링 설정, CI.

> CI 에 라이선스 가드를 추가했다 (`.github/workflows/ci.yml`):
> GPL/AGPL 라이선스 표기가 의존성에 들어오면 빌드가 실패한다.
> 이 문서의 규칙을 사람의 기억이 아니라 파이프라인이 지키게 하는 것이 목적이다.
>
> **2026-08-14 갱신**: 원래 이 잡은 "LICENSE 파일이 *생기면* 실패"였다. 라이선스가
> Apache-2.0 으로 확정되면서 방향이 뒤집혔다 — 이제 `LICENSE`·`NOTICE` 가 *없으면*
> 실패한다. GPL 검사는 그대로이며, 오히려 더 중요해졌다.

---

## 사용 중인 서드파티 의존성

허용적 라이선스만 사용한다 — 전부 Apache-2.0 배포물에 포함 가능하다. 상세 목록은 `docs/license.md` 참조.

계획된 것 (M3~M4 에서 실제로 추가된다):

- Apache-2.0: `diffusers`, `transformers`, `accelerate`, `safetensors`
- BSD-3-Clause: PyTorch
- MIT: FastAPI, pydantic, uvicorn, `@xyflow/react`, Zustand, Yjs
- MIT-CMU (HPND): Pillow

M0 시점에 실제로 설치된 것:

| 패키지 | 라이선스 | 용도 |
|---|---|---|
| `pydantic` | MIT | 캐논 그래프 모델 |
| `fastapi`, `uvicorn` | MIT | 서버 (M2 대비 선언) |
| `ruff`, `pytest`, `mypy`, `jsonschema` | MIT | 개발 도구 |
| `react`, `react-dom` | MIT | 프론트 |
| `vite`, `vitest`, `eslint`, `prettier`, `typescript` | MIT / Apache-2.0 | 프론트 도구 |
| `ajv`, `ajv-formats` | MIT | 프론트의 캐논 스키마 검증 |

**GPL/AGPL 의존성을 추가하지 않는다.** 추가가 불가피하다면 먼저 소유자에게 확인할 것.
