# 테스터 시작 안내

2026-09-17. 공유받은 **main 브랜치**를 사용한다. 기능별 브랜치를 따로 합칠 필요가 없다.
저장소는 비공개이므로 먼저 소유자에게 접근 권한을 받아야 한다. 모델 가중치와 개인
캐릭터 원본, `outputs/`의 영상 결과는 Git으로 배포되지 않는다.

## 1. 체크아웃과 기본 실행

처음 받는 사람은 공유받은 저장소를 별도 폴더에 체크아웃한다. 기존 체크아웃은
`git status --short`가 비어 있을 때만 아래처럼 갱신한다. 변경이 있다면 먼저 커밋하거나
별도 복사본에 보존한다. `reset --hard`나 강제 pull은 사용하지 않는다.

```powershell
git fetch origin
git switch main
git pull --ff-only origin main
git rev-parse HEAD
```

준비물은 Git, uv, Node.js 20 이상, Corepack이다. `uv --version`, `node --version`,
`corepack --version`으로 확인한다. Corepack이 없는 Node 설치도 있으므로 별도 설치가
필요할 수 있다. pnpm 버전은 저장소의 `packageManager` 선언을 따른다.

아래는 **저장소 루트에서** 실행한다. 기본 설치에는 torch와 모델 가중치가 필요 없다.
`--templates examples/templates`가 중요하다. 원클릭 런처의 기본 사용자 템플릿 폴더는
처음에는 비어 있으므로, MCP 첫 테스트는 이 수동 명령을 권장한다.

```powershell
uv sync --frozen --python 3.11
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @nodal/web build
uv run --no-sync nodal launch --web apps/web/dist --templates examples/templates
```

- UI: `http://127.0.0.1:8188/`
- REST 설명: `http://127.0.0.1:8188/docs`
- MCP: `http://127.0.0.1:8188/mcp` (Streamable HTTP)
- 에셋·모델·확장 기본 폴더: 사용자 홈의 `.nodal/assets`, `.nodal/models`, `.nodal/extensions`.
- 종료: 서버 터미널에서 Ctrl+C. `--port 8193`처럼 바꾸면 클라이언트 URL도 같이 바꾼다.

UI에서 `examples/image.nodal.json`을 불러와 실행하면 샘플 이미지가 축소된다.
노드가 목록에 보이는 것과 해당 생성 모델의 런타임·가중치가 설치된 것은 다르다.

서버를 켜둔 채 새 터미널에서 아래를 실행하면 MCP 초기화, 썸네일 2회 실행,
128×128 PNG 에셋 읽기, 반복 실행의 캐시 히트를 자동 검사한다. GPU 생성은 하지 않으며
작은 테스트 이미지 에셋만 서버에 남긴다. 작업 큐가 빈 서버에서 실행한다.

```powershell
uv run --no-sync python tools/smoke_mcp.py
```

## 2. MCP 연결

MCP용 서버를 별도로 실행할 필요는 없다. 위 서버가 UI·REST·MCP를 함께 제공한다.
MCP 주소를 브라우저로 여는 것은 연결 시험이 아니다. MCP 클라이언트로 초기화해야 한다.

Codex에서는 사용자 설정 `~/.codex/config.toml`의 기존 내용을 보존하고 다음 항목을
추가한다. 이미 같은 이름의 항목이 있다면 중복으로 추가하지 않고 URL을 확인한다.

```toml
[mcp_servers.nodal]
url = "http://127.0.0.1:8188/mcp"
```

CLI를 사용한다면 동등한 등록 명령은 다음과 같다.

```powershell
codex mcp add nodal --url http://127.0.0.1:8188/mcp
```

설정 후 MCP 연결을 새로고침하거나 클라이언트를 다시 연다. Codex 연결 형식은
[공식 MCP 문서](https://developers.openai.com/codex/mcp)를 따른다. 다른 클라이언트에서는
Streamable HTTP 전송 방식과 위 URL을 선택한다. nodal 로컬 서버는 OAuth 로그인을
요구하지 않는다. 이 설정을 추가한다고 서버가 자동 시작되는 것은 아니다.

AI 클라이언트에 처음 줄 요청:

> nodal의 list_templates로 사용 가능한 템플릿과 거부 사유를 확인해줘.
> run_template_thumbnail에 source="examples/sample.png", size=128,
> use_cache=true를 전달하고, 반환된 run_id로 get_run을 조회해서 완료되면
> 결과 이미지 에셋을 보여줘. GPU 영상 생성은 실행하지 마.

| 도구 | 용도 |
|---|---|
| `list_templates` | 로드된 템플릿과 거부된 파일/이유 확인 |
| `run_template_<이름>` | 공개된 템플릿을 제출하고 `run_id`를 즉시 받음 |
| `get_run` | 상태·진행률·결과·`elapsed_ms`·실행/캐시 노드 확인 |
| `cancel_run` | 취소 요청. 이미 실행 중인 노드가 확인하기까지 시간이 걸릴 수 있음 |

`queued`/`running`이면 같은 실행을 조회한다. 응답이 늦다고 다시 제출하면 중복 생성된다.
`succeeded`의 이미지 결과는 `results.image.asset.hash`이며,
`http://127.0.0.1:8188/api/assets/<hash>`로 읽는다. 실패하면 `error`의 노드/입력을 확인한다.
서버를 재시작하면 실행 이력은 사라진다. 디스크에 저장한 에셋은 남는다.

Image 인자는 **서버 컴퓨터에서 읽을 수 있는 경로** 또는 `asset:<hash>`다. 외부 이미지
URL을 경로처럼 넣지 않는다. 업로드는 REST `POST /api/assets`의 multipart `file`로 한다.
일반 그래프 실행은 REST `POST /api/runs`, MCP 실행은 등록된 템플릿이 담당한다.
템플릿 추가/수정 후에는 서버를 재시작하고 MCP 도구 목록을 새로 읽는다.

`use_cache=true`는 기본값이다. 하지만 Save나 H3처럼 캐시하지 않는 노드는 재실행된다.
영상 재생성을 피하려면 이미 받은 실행 ID와 결과 에셋을 재사용한다.

## 3. 모델 생성은 다음 단계

기본 연결이 성공한 다음 필요한 런타임만 선택한다. CPU와 CUDA 옵션을 함께 쓰지 않는다.

```powershell
# NVIDIA GPU에서 이미지 생성
uv sync --frozen --python 3.11 --extra cuda

# H3 영상 + AI 업스케일을 사용할 경우 위 명령 대신
uv sync --frozen --python 3.11 --extra cuda --group h3 --group upscale
```

그다음 로컬 가중치를 준비하고, 같은 터미널에서 필요한 환경 변수를 지정한 뒤
앞의 `uv run --no-sync nodal launch ...` 명령으로 실행한다. 모델 이용 조건은 코드의
Apache-2.0 라이선스와 별개다. 자동 다운로드나 가중치 배포를 전제하지 않는다.

- H3: [설치·모델 검사·MCP](minimax-h3.md). `NODAL_DEVICE=cuda`,
  `NODAL_H3_MODEL`을 실제 모델 폴더로 지정하고 `h3_check`부터 통과시킨다.
- 업스케일: [로컬 업스케일 가중치와 노드](video-upscale.md).
- FLUX.2: [Base/distilled 설정 차이](flux2-base.md). SDXL·Z-Image·FLUX.2는 서로 다른
  모델 형식을 요구하므로 템플릿과 실제 로컬 모델을 맞춘다.
- 영상 방식 선택: [원 비교와 사용 기준](won-method-comparison.md).

**주의:** 일반 원클릭 런처는 core/cpu/cuda만 동기화한다. H3/upscale 그룹까지 설치한
환경에 다시 사용하면 선택적 패키지가 빠질 수 있다. 영상 테스트에서는 필요한 그룹을
명시적으로 설치하고 `uv run --no-sync`로 실행한다. `uv run`만 쓰는 것도 피한다.

RTX 5080 16GB / 약 64GB RAM에서 H3 768×1152, 5.17초, 16스텝 비교 영상 한 편은
약 32~45분이 걸렸다. 이는 그 장비/설정의 실측이며 모든 PC의 최소 사양이나 속도 보장이
아니다. 많은 디스크 공간과 페이지 파일이 필요할 수 있다. 테스터 첫날에 대형 가중치
다운로드부터 시작하지 말고 기본 이미지/MCP 시험과 생성 품질 시험을 나눈다.

## 4. 공유 범위와 문제 신고

기본은 각 테스터 PC에서 로컬 실행이다. `127.0.0.1`은 **그 PC 자신**을 가리킨다.
원격 GPU PC에 Parsec으로 접속했다면 설치·서버·클라이언트를 GPU PC 안에서 실행한다.
현재 인증·사용자별 에셋 격리가 없으므로 포트를 공개하거나 `0.0.0.0`으로 열지 않는다.
원격 연결이 꼭 필요하면 인증된 터널 등 접근 제어를 먼저 별도로 설계해야 한다.
같은 서버를 쓰면 실행 큐와 에셋을 공유한다. 서버에서 확장 코드는 같은 프로세스로
실행되므로 신뢰하는 확장만 설치한다.

문제 신고에는 `git rev-parse HEAD`, OS/GPU/RAM, 설치한 런타임 옵션, 실행 명령,
템플릿 이름·입력·seed, `run_id`, 오류 노드, 서버 로그를 포함한다. 개인 이미지·토큰·
비밀 설정은 로그에서 제외한다. 이미지 생성·편집과 영상 준비 이미지는 nodal 내부 모델만
사용하며, 외부 이미지 생성 서비스로 자동 대체하지 않는다.

## 이 통합본에서 확인한 범위

2026-09-17 Windows의 별도 깨끗한 worktree / Python 3.11.9에서 기본 `uv sync --frozen`,
프론트 설치·빌드, 전체 `tools/ci-local.sh`를 확인했다. 로컬 재현 검사 **25 통과 · 0 실패 ·
10 건너뜀**이다. 건너뜀은 GitHub 액션 설치 단계와 PR 전용 DCO 잡이며, 이를 원격 CI
통과라고 표현하지 않는다. 병합 대상 커밋의 Signed-off-by도 별도로 확인했다.

GPU/가중치 없는 실제 서버에서 노드 40개, MCP 템플릿 13개(거부 0개), UI/JS HTTP 200,
JavaScript MIME, MCP 초기화·썸네일 2회·128×128 PNG·캐시 히트를 검증했다.
Windows/Python별 MIME 차이는 빌드 웹에도 명시적인 JavaScript 타입을 적용해 해결했다.
로그는 작성자 작업 폴더의 `outputs/tester-integration-ci-verified.log`와 통합 worktree의
`outputs/tester-smoke/mcp-verified.log`에 남긴다.

이번 통합 검증에서 대형 모델 영상을 다시 생성하지는 않았다. GPU 품질 근거는
기존 [H3 비교 6편](won-method-comparison.md)의 조건에 한정하며, 다른 테스터의
하드웨어·드라이버·모델 조합은 해당 환경에서 별도로 검증해야 한다.
