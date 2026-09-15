# 원 · 시작/끝 제약과 Ref2VA 비교

2026-09-15 사용자 승인 실험. 결과가 나오기 전 방법의 우열을 확정하지 않는다.

## 고정 조건

- 원본: `output/zimage-training/hwiwon-images/hwiwon (16).png`, 1020×1532.
  외부 생성 결과를 원본 대신 쓰지 않는다. 실행 receipt에 파일 SHA-256을 기록한다.
- 방법 1 (`anchor`): 같은 원본을 첫 프레임과 마지막 프레임에 연결한 FL2VA.
- 방법 2 (`reference`): 원본 전신 + nodal `image.Crop`으로 자른 같은 원본의 얼굴을
  `reference_1/2`에 연결한 Ref2VA. 크롭은 x=380, y=10, width=360, height=340.
  생성된 얼굴이나 다른 인물 이미지를 참조로 추가하지 않는다.
- seed 7·19·31, 각 방법 3회. 768×1152, 124프레임, 24fps, 16스텝(15 forward).
- MiniMax H3 Pruned, ConvRot INT8 + CPU group offload. 모델 revision
  `1a0ef5e65b639e84af81d883817968532180e9c7`. Ref2VA는 별도 가중치다.
- Ref2VA 참조 짧은 변 768. 공식 기본 2048과 다르며, 이번 결과는 이 로컬 메모리
  절약 조건에 한정한다. FL2VA와 Ref2VA의 학습·조건 구조까지 같은 실험은 아니다.
- 회색 스튜디오, 고정 카메라·조명, 한 인물 전신. 팔/발 자세를 유지하면서 고개를
  약 10도 카메라 쪽으로 돌렸다 원래 방향으로 돌아온다. 조용한 실내음.
  보행·배경 편집·카메라 이동·업스케일을 제외해 실패 원인을 줄인다.

프롬프트의 공통 동작 문장은 `tools/h3_compare.py`의 `ACTION`이다. 모드마다
시작/끝 또는 Picture 1/2의 역할 설명만 다르다. 동일 seed라도 서로 다른 조건에서
동작/노이즈가 동일하지 않으며, Ref2VA는 시작 구도를 픽셀 단위로 고정하지 않는다.
참조 두 장은 독립된 두 시점이 아니라 한 원본의 전신/얼굴이다.

## 실행과 보존

기존 8190 서버와 에셋을 건드리지 않고 비교용 8191 서버에서 실행한다.

```powershell
$env:PYTHONUTF8 = '1'
$env:NODAL_DEVICE = 'cuda'
$env:NODAL_H3_MODEL = (Resolve-Path models/MiniMax-H3-Pruned).Path
uv run --no-sync nodal serve --host 127.0.0.1 --port 8191 --assets outputs/h3/won-method-comparison/assets --templates examples/templates --web apps/web/dist
# 별도 터미널
uv run --no-sync python tools/h3_compare.py
```

러너는 MCP로 한 편씩 생성·조회한다. `outputs/h3/won-method-comparison/` 아래에
모드-seed별 프롬프트/설정/입력 해시/모델 revision/실행 ID/서버 결과와 WebM을 보존한다.
WebM의 `NODAL_GRAPH` 메타데이터는 실제 실행 그래프다. 서버 재시작으로 실행 ID가
사라졌거나 제출 여부가 불확실하면 자동 재제출하지 않는다. 기존 결과를 덮어쓰지 않는다.
각 영상 저장 후 `tools/h3_compare_review.py`가 컨테이너 사실, 실제 그래프,
0.25초 간격 전체/얼굴 QA 시트를 만든다. 고정 얼굴 크롭은 추적 알고리즘이 아니며
얼굴이 이동하면 전체 프레임과 함께 확인한다. 컨테이너 검증으로 정체성을 자동 통과시키지 않는다.

## 판정 원칙

전체 6편을 공개하고 중간이 깨진 결과를 빼지 않는다. 시작/중간/끝의 원본 정체성,
영상 내 눈·코·입·턱·헤어라인·귀걸이의 연속성, 몸/옷과 구도, 동작 수행을 나눠 본다.
양 끝만 비슷하거나 움직이지 않는다고 좋은 동영상으로 통과시키지 않는다.
0.25초 간격 표본으로 의심 구간을 찾고 인접 프레임과 재생으로 다시 확인한다.
이 실험 3회로 모델의 일반적 우열이나 일관성 보장을 주장하지 않는다.

## 현재 상태

- 연결 단위 테스트 32개 통과. 두 비교 템플릿의 실제 원본/크롭 그래프 경로도 포함한다.
  실제 Ref2VA 가중치 18파일(40,235,633,959바이트), 샤드 목록 및 소스 해시 확인 완료.
- 실제 GPU 비교 생성 진행 중. 아직 6편 완료 또는 캐릭터 일관성 통과 판정이 아니다.
- 첫 FL2VA 실행 ID: `89745dcb2b9a40039aeae2b54e45c90c` (seed 7).
- 전체 `tools/ci-local.sh`: 통과 20 · 실패 5 · 건너뜀 10.
  기존 `output/zimage-training` 스크립트 ruff lint/format, Windows JS MIME 기대값,
  프론트 prettier 49파일 및 API 생성물 줄바꿈 drift 실패가 남는다.
  이번 H3 소스·러너의 ruff, diffusion mypy, H3 테스트, `git diff --check`는 통과했다.
  전체 로그는 `outputs/h3/won-method-comparison/ci-final.log`에 보존한다.
