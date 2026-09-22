# Qwen-Image-2.1 로컬 실행과 MCP

`diffusion.QwenImage21`은 공식 Diffusers의 `QwenImage21Pipeline`에 추론을
위임한다. 생성·편집·RGBA 출력과 순서가 있는 참조 이미지 최대 10장을 받는다.
노드 등록에는 torch가 필요 없고, 실행에만 별도 Qwen 런타임이 필요하다.

## 모델 사용 조건

가중치는 **Qwen Research License: 비상업적 연구·평가용**이다. 상업적 사용은
Qwen의 별도 허가가 필요하다. nodal의 Apache-2.0 라이선스가 모델에 적용되는 것은
아니다. 가중치와 Qwen 저장소의 코드를 nodal 배포물에 포함하지 않는다.
사용자가 사용 조건 안내 후 로컬 설치와 MCP 연결을 요청했다.

- 모델: <https://huggingface.co/Qwen/Qwen-Image-2.1>
- 모델 라이선스: <https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE>
- 고정 가중치 revision: `790c92633540aa0cb11d9abf19eb46d861714758`
- Diffusers revision: `8b3c707ebd3ec4881f4190cf42931da07eaf3b65`

## 설치와 시작 (Windows NVIDIA)

Python 3.11+, PowerShell 7, CUDA PyTorch 환경이 필요하다. 가중치는 약 33GB다.
처음 설치하는 체크아웃은 먼저 저장소의 CUDA 환경을 준비한다.

```powershell
uv sync --extra cuda
pwsh -File tools/prepare-qwen21.ps1
pwsh -File tools/start-qwen21.ps1
```

준비 스크립트는 명시적으로 다운로드하고 `models/Qwen-Image-2.1/nodal-model.json`에
리비전을 기록한다. 실행 노드는 로컬 파일만 읽으며 암묵적으로 다운로드하지 않는다.
가중치가 이미 준비됐으면 `prepare-qwen21.ps1 -SkipDownload`를 쓸 수 있다.

Qwen이 필요한 최신 개발판은 `tools/qwen21-requirements.txt`에 고정했다.
기존 H3용 lock의 Diffusers 0.40과 다르므로 일반 `uv sync` 후에는 준비 스크립트를
다시 실행해야 한다. H3 동작을 이 문서의 Qwen 검사로 보장하지 않는다.

서버는 기본 `http://127.0.0.1:8210`에서 실행한다. 빌드된 웹 UI가 있으면 같은 주소로
제공한다. 생성한 PNG와 실행 기록은 `outputs/qwen21/` 아래에 남는다.
`-Port`와 `-ModelPath`로 변경할 수 있다. 시작 스크립트는 Qwen 템플릿 세 개를
전용 카탈로그에 복사하므로 기존 nodal MCP와 사용자 홈 템플릿은 변경하지 않는다.

## MCP

```powershell
codex mcp add nodal_qwen21 --url http://127.0.0.1:8210/mcp
codex mcp get nodal_qwen21
.venv/Scripts/python.exe tools/qwen21_mcp_test.py --list-only
```

클라이언트가 도구 목록을 이미 캐시했다면 MCP 연결을 새로고침하거나 새 대화를 연다.
서버 프로세스는 MCP 호출 중 실행 중이어야 한다. PC 재시작 후 시작 스크립트를 다시
실행한다. 이 설치는 Windows 시작 프로그램이나 외부 공개 서버를 만들지 않는다.

| 도구                           | 용도                                      |
| ------------------------------ | ----------------------------------------- |
| `run_template_qwen21_generate` | 텍스트에서 이미지 생성                    |
| `run_template_qwen21_edit`     | 이미지 한 장 편집                         |
| `run_template_qwen21_compose`  | 참조 이미지 세 장으로 합성                |
| `get_run`                      | 비동기 실행 상태·PNG 에셋·provenance 조회 |
| `cancel_run`                   | 실행 취소 요청                            |

편집 참조는 `reference_1`(합성은 1~~3)에 파일 경로나 `asset:<hash>`로 지정한다.
다른 서버의 에셋은 이 서버에 업로드해야 한다. 2장 또는 4~~10장 참조는 기본 노드의
소켓을 사용해 그래프를 구성한다. MCP 템플릿에서는 각각 0·1·3장만 노출한다.

기본은 1024×1024, 40 steps, seed 42다. 크기는 256~2048 사이의 32 배수다.
16GB GPU는 그룹 오프로딩을 기본으로 사용한다. 참조 입력은 기본 768 해상도로
리샘플되며 `reference_resolution`으로 조정한다. 이는 참조 세부정보에 영향을 준다.
여러 참조와 높은 해상도의 동시 사용은 메모리 실측 후 결정한다.

RGBA 요청은 프롬프트에 투명 배경과 alpha channel을 명시한다. 결과의 alpha를
그대로 PNG에 보존하지만 프롬프트만으로 원하는 투명 영역을 보장하지는 않는다.
PNG에는 실행 그래프를, MCP `metadata`에는 실제 모델 경로·리비전·런타임 버전·seed·
프롬프트·참조 픽셀 해시·실행 ID를 남긴다.

## 검증

```powershell
.venv/Scripts/python.exe -m pytest packages/nodes-diffusion/tests/test_qwen21.py
.venv/Scripts/python.exe tools/qwen21_mcp_test.py --output outputs/qwen21/smoke
```

동일 출력 폴더에 이미 요청 영수증이 있으면 중복 생성하지 않는다. `--resume`으로
진행 상태를 다시 확인하거나 새 출력 폴더를 지정한다. `--source`를 지정하면 실제
MCP 이미지 편집 경로를 검사한다. 단위 테스트는 실제 모델의 화질을 검증하지 않는다.

### 2026-09-23 장비 실측

RTX 5080 16GB / RAM 64GB / Windows / torch 2.13.0+cu130에서 검사했다.
모든 추론은 nodal 등록 노드와 실제 HTTP MCP 호출을 거쳤다.

| 검사 | 결과 | 실행 ID |
|---|---|---|
| 텍스트 생성, 512×512, 20 steps | 성공; 파란 찻주전자 PNG 확인 | `7463c1ac99114252a7879613c73fabbb` |
| 위 결과의 `asset:` 편집, 512×512, 20 steps | 성공; 빨간 찻주전자 PNG 확인 | `39789c98ba1e4323832ef30852773403` |
| 투명 이미지 생성, 1024×1024, 40 steps | 성공; RGBA, alpha 범위 0~255 확인 | `6ca4aa19daa64957bbf8b9ab54367112` |

요청·MCP 영수증·provenance·PNG는 `outputs/qwen21/smoke/`, `outputs/qwen21/edit/`,
`outputs/qwen21/rgba/`에
보존했다. 원본 참조와 편집 결과는 각각 별도 에셋으로 보존한다.
편집은 재생성이므로 색상 외 픽셀을 완전히 고정한다는 의미는 아니다.

`tools/ci-local.sh` 전체를 LF 체크아웃의 별도 worktree에서 실행해 **25단계 통과,
실패 0**을 확인했다. GitHub Actions 전용 설치/DCO 단계 10개는 스크립트 규약대로
건너뛰었다. 실행 로그는 `outputs/qwen21/ci-clean.log`에 있다. 원 작업 폴더에서는
기존 미추적 학습 스크립트와 CRLF 때문에 포맷/drift 검사도 실패했으므로 이를 지우거나
대량 재포맷하지 않고 이번 변경만 포함한 체크아웃에서 검사했다.

최대 10장 참조와 2048 해상도, sequential offload 프로필은 이 실측에 포함하지 않았다.
