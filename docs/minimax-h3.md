# MiniMax H3 영상 생성 준비

`diffusion.MiniMaxH3`는 텍스트, 선택적인 시작/끝 이미지에서 소리를 포함한
24fps WebM(VP9 + Opus)을 생성한다. 결과 노드에서 재생하거나 **영상 저장**으로
다운로드한다. 기존 `Load Image` 또는 `Load Asset Image`의 출력을 `first_frame`에
연결할 수 있다. 이미지 배치는 한 장만 받는다.

**상태:** 로컬 어댑터와 영상 저장·재생 경로를 구현했다. H3 가중치를 사용한 원격
GPU 추론은 아직 검증하지 않았다. 레포에는 RTX 5080 약 16GB 사용 기록이 있지만
SSH 주소, 실제 H3 폴더, 원격 RAM 용량은 없다. 그 정보를 확인한 뒤 아래 순서로
첫 생성을 검증한다. GPU가 있는 컴퓨터에서 nodal 서버를 실행해야 한다.

## 지원하는 모델 형식

diffusers 0.40의 `MiniMaxH3ModularPipeline`을 사용한다. 실행 시 외부 모델을
자동 다운로드하지 않는다. 로컬 폴더에 `modular_model_index.json`과
`transformer/`, `text_encoder/`, `tokenizer/`, `vae/`, `audio_vae/` 등 선택한
워크플로의 구성요소가 필요하다. 설정 파일과 샤드 전체를 함께 준비해야 한다.

MiniMax 원본 `FL2VA/` 형식, 단일 GGUF/FP8 파일, 다른 프로그램용 분할 모델은
현재 로더의 입력이 아니다. 기존 모델의 형식을 먼저 확인하고, 불일치하면 공식
diffusers 형식으로 준비하는 작업을 별도로 진행한다. 가중치를 저장소에 넣지 않는다.

- [공식 모델과 파일 안내](https://huggingface.co/MiniMaxAI/MiniMax-H3)
- [공식 diffusers H3 사용법](https://huggingface.co/docs/diffusers/main/en/api/pipelines/minimax_h3)

## 원격 GPU 설치와 점검

원격 컴퓨터의 이 버전 nodal 폴더에서 실행한다. 기존 작업 중인 체크아웃을 덮어쓰지
않고 별도 폴더를 사용한다. 아래 모델 경로는 실제 경로로 바꾼다.

```bash
uv sync --extra cuda --group h3
export NODAL_DEVICE=cuda
export NODAL_H3_MODEL=/absolute/path/to/MiniMax-H3
uv run --no-sync python -m nodal_nodes_diffusion.h3_check
```

점검 명령은 파일과 라이브러리, 사용 가능한 GPU 메모리와 RAM을 JSON으로 보고한다.
가중치를 로드하거나 다운로드하지 않는다. `checks_passed: true`는 기본 검사 통과이고,
생성 성공을 의미하지 않는다(`inference_verified`는 항상 false).

기본 `int8_offload`는 torchao int8 가중치 양자화와 CPU 그룹 오프로딩을 사용한다.
16GB VRAM을 고려한 설정이지만 성공 보장은 아니다. 공식 안내상 int8에도 약 75GB의
호스트 RAM이 필요할 수 있고 로딩 중 최고 사용량은 더 높을 수 있다. RAM이 부족하면
실행 전에 모델 형식과 대안을 다시 판단해야 한다. `bf16_offload`는 양자화를 끄며
더 많은 호스트 RAM이 필요하다. 첫 생성은 모델 로딩·양자화 때문에 오래 걸릴 수 있다.

원격 서버는 루프백에 바인딩하고 SSH 터널로 접속한다. 인증 없는 서버를 인터넷에
직접 공개하지 않는다.

```bash
# 원격 GPU 컴퓨터
pnpm install --frozen-lockfile
pnpm --filter @nodal/web build
uv run --no-sync nodal serve --host 127.0.0.1 --port 8188 --assets ~/nodal-h3-assets --web apps/web/dist

# 현재 컴퓨터의 별도 터미널: USER와 GPU_HOST를 실제 접속 정보로 교체
ssh -N -L 8188:127.0.0.1:8188 USER@GPU_HOST
```

웹 빌드/런처 설정은 [개발 안내](dev.md)를 따른다. 브라우저에서
`http://127.0.0.1:8188`에 접속하고 `examples/h3-text-to-video.nodal.json`을 연다.
`model_path`를 비워 두면 **서버의** `NODAL_H3_MODEL`을 쓴다.

## 첫 실행과 검증

1. 텍스트 예제의 기본값 960×544, 124프레임(약 5.17초), 고정 seed로 한 번 실행한다.
2. 영상과 소리가 모두 재생되는지, 파일 저장 후 다시 재생되는지 확인한다.
3. `examples/h3-image-to-video.nodal.json`의 이미지 경로를 원격 파일로 바꾸고 실행한다.
4. 샘플링 중 취소 후 새 실행이 가능한지 확인하고, 서버 로그와 사용 메모리를 기록한다.

프레임 수는 124~345 사이에서 `17n+5`, 너비·높이는 32의 배수다. H3의 고정 24fps와
프레임 정렬에 맞춘다. `steps`는 끝점 0을 포함한 sigma 지점 수이므로 모델 계산은
`steps - 1`회다. negative prompt와 CFG 입력은 없다. 참조 이미지 여러 장을 쓰는
`ref2va`, 영상 이어 만들기, 배치 생성은 이번 범위에 포함하지 않았다.

영상 생성 노드는 매번 실행하고 종료 시 H3 구성요소를 해제한다. SD 등의 모델은
살아 있는 그래프 핸들을 보존하며 유휴 캐시만 비운다. 같은 그래프의 이미지 생성이
모델 핸들을 붙들고 있어 메모리가 부족하면 이미지를 먼저 저장한 뒤 별도 영상
워크플로에서 불러온다. 영상에 워크플로 JSON을 메타데이터로 넣지만 영상에서 그래프를
복원하는 UI는 아직 없다. `.nodal.json`도 함께 저장한다.

진행률은 로딩/샘플링/디코딩/인코딩 단계를 포함한다. 취소는 단계 사이와 샘플링 스텝,
인코딩 프레임 사이에서 확인한다. 실행 중인 가중치 로드나 GPU 연산을 즉시 중단하지는 않는다.

## 로컬 검증 범위

가중치 없이 노드 등록·입력 검사·키프레임 라우팅·시드 전달·취소·에셋 API/WS 경로를
검사한다. 합성 프레임과 사운드로 **실제 WebM 인코딩 및 영상·오디오 디코딩**을 검사한다.
이는 H3의 영상 품질이나 원격 GPU 메모리 사용량 검증을 대신하지 않는다.

```bash
uv sync --group diffusion --group h3
uv run --no-sync pytest packages/nodes-diffusion/tests/test_h3.py
```

PyAV는 선택적 의존성이다. 인코더는 VP9/Opus를 사용하며 libx264를 호출하지 않는다.


2026-09-03 브라우저 검사에서는 별도 검증 서버의 합성 영상으로 H3 노드 실행 → 영상
에셋 → 플레이어 표시 → 끝까지 재생을 확인했다(브라우저 디코딩 오류 없음). 이 검증용
서버와 그래프는 제품 코드에 포함하지 않는다. H3 가중치로 생성한 영상은 아니다.
