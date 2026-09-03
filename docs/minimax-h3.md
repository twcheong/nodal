# MiniMax H3 영상 생성 준비

`diffusion.MiniMaxH3`는 텍스트, 선택적인 시작/끝 이미지에서 소리를 포함한
24fps WebM(VP9 + Opus)을 생성한다. 결과 노드에서 재생하거나 **영상 저장**으로
다운로드한다. 기존 `Load Image` 또는 `Load Asset Image`의 출력을 `first_frame`에
연결할 수 있다. 이미지 배치는 한 장만 받는다.

**상태:** 로컬 어댑터와 영상 저장·재생 경로를 구현했다. H3 가중치를 사용한 원격
GPU 추론은 아직 검증하지 않았다. 레포에는 RTX 5080 약 16GB 사용 기록이 있지만
사용자의 기존 파일은 `C:\ComfyUI\models\diffusion_models\minimax_h3_fl2va_pruned_int8_convrot.safetensors`다.
원격 RAM 용량은 아직 확인하지 못했다. 사용자는 Parsec으로 원격
컴퓨터에 접속해 테스트한다. 아래 명령과 브라우저 조작은 모두 **Parsec 화면 안의
GPU 컴퓨터에서** 수행한다. SSH 주소나 SSH 터널은 필요하지 않다.

## 지원하는 모델 형식

diffusers 0.40의 `MiniMaxH3ModularPipeline`을 사용한다. 실행 시 외부 모델을
자동 다운로드하지 않는다. 로컬 폴더에 `modular_model_index.json`과
`transformer/`, `text_encoder/`, `tokenizer/`, `vae/`, `audio_vae/` 등 선택한
워크플로의 구성요소가 필요하다. 설정 파일과 샤드 전체를 함께 준비해야 한다.

MiniMax 원본 `FL2VA/` 형식, 단일 GGUF/FP8 파일, 다른 프로그램용 분할 모델은
현재 로더의 입력이 아니다. 아래 Pruned 경로도 사용자가 가진 ComfyUI INT8 단일 파일을
변환하거나 그대로 읽는 기능은 아니다. 가중치를 저장소에 넣지 않는다.

- [공식 모델과 파일 안내](https://huggingface.co/MiniMaxAI/MiniMax-H3)
- [공식 diffusers H3 사용법](https://huggingface.co/docs/diffusers/main/en/api/pipelines/minimax_h3)

## Pruned + ConvRot INT8 직접 실행 (실험적)

같은 `MiniMax H3 Video` 노드가
[multimodalart/MiniMax-H3-Pruned](https://huggingface.co/multimodalart/MiniMax-H3-Pruned)의
diffusers 확장 모델을 지원한다. 모델 설정으로 Pruned를 식별하고 축소된 AdaLN 구조로
로드한다. `memory_profile`을 `pruned_convrot_int8_offload`로 설정하면 모델의
`quantize_8bit`를 호출해 GPU에서 한 층씩 ConvRot와 INT8 동적 활성화 양자화를 적용한다.
텍스트 인코더는 INT8 weight-only, 모델은 CPU 그룹 오프로딩을 사용한다.
ComfyUI 서버를 실행할 필요가 없다.

모델 코드는 Apache-2.0이며 diffusers의 모델·forward를 확장한다. nodal에 복사하지 않고
모델 폴더에서 읽는다. 검토한 리비전과 SHA-256이 일치하는 소스만 실행한다. 일반적인
`trust_remote_code=True`는 사용하지 않는다. 모델 가중치는 별도의 MiniMax 모델 이용
조건을 따른다. 출처와 검토 범위는 [NOTICE-provenance.md](../NOTICE-provenance.md)에 있다.

**Parsec 화면 안의 원격 Windows PowerShell**에서, nodal 폴더를 현재 위치로 놓고 실행한다.
아래는 다운로드를 시작하는 명령이다. 기존 ComfyUI 폴더와 다른 새 모델 폴더를 사용한다.
이 배포본의 transformer는 약 40.24GB BF16, 텍스트 인코더는 약 52.48GB BF16이며
보조 모델 용량도 필요하다. 이미 준비한 구성요소가 있으면 중복 다운로드하기 전에 확인한다.

```powershell
uv sync --extra cuda --group h3
$h3Dir = 'C:\nodal-models\MiniMax-H3-Pruned'
uv run --no-sync hf download multimodalart/MiniMax-H3-Pruned --revision 1a0ef5e65b639e84af81d883817968532180e9c7 --local-dir $h3Dir --include 'modular_model_index.json' 'transformer/*' 'text_encoder/*'
uv run --no-sync hf download MiniMaxAI/MiniMax-H3 --revision 42ed227ee7df40d41602854ae760620d6eb651fe --local-dir $h3Dir --include 'tokenizer/*' 'processor/*' 'vae/*' 'audio_vae/*' 'scheduler/*' 'audio_scheduler/*'
$env:NODAL_DEVICE = 'cuda'
$env:NODAL_H3_MODEL = $h3Dir
uv run --no-sync python -m nodal_nodes_diffusion.h3_check
```

두 명령으로 모든 구성요소를 한 폴더에 모은다. 추론 로더는 모델 인덱스에 남아 있는
Hub 경로 대신 그 로컬 폴더만 사용한다. `transformer_ref`는 이번 t2va/fl2va에 필요 없다.
점검 결과의 `model_variant`가 `pruned`인지 확인하고, 아래 서버 실행 절차를 따라
`examples/h3-pruned-text-to-video.nodal.json`을 연다. 이미지 예제에서도 같은 프로필을
선택하면 시작/끝 이미지 입력을 사용할 수 있다.

**메모리와 속도:** 저장된 BF16 모델을 먼저 읽고 양자화하므로 ComfyUI의 미리 양자화된
파일과 로딩 중 RAM 사용량이 같지 않다. 16GB GPU에서의 성공과 필요한 호스트 RAM은
실측 전이다. Pruned 경로는 호스트 메모리 부담을 줄이기 위해 비동기 스트림 프리페치를
끄며, Windows 첫 호환성 검증을 위해 `torch.compile`도 적용하지 않는다. 제작자의
H100 속도 수치를 이 경로의 예상 속도로 쓰지 않는다. 컴파일 없는 동적 INT8은 느릴 수 있다.
`bf16_offload`로 같은 Pruned 모델을 비교할 수 있으나 더 많은 메모리가 필요하다.

## Parsec으로 접속한 GPU 컴퓨터에서 설치와 점검

원격 컴퓨터의 이 버전 nodal 폴더에서 실행한다. 기존 작업 중인 체크아웃을 덮어쓰지
않고 별도 폴더를 사용한다. 아래 모델 경로는 **원격 컴퓨터에 있는** 실제 경로로 바꾼다.
현재 컴퓨터에서 이 명령을 실행하면 원격 GPU를 사용하지 않는다.

원격 OS가 Windows라면 PowerShell에서:

```powershell
uv sync --extra cuda --group h3
$env:NODAL_DEVICE = "cuda"
$env:NODAL_H3_MODEL = 'D:\models\MiniMax-H3'
uv run --no-sync python -m nodal_nodes_diffusion.h3_check
```

원격 OS가 Linux라면 터미널에서:

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
16GB VRAM을 고려한 설정이지만 성공 보장은 아니다. 일반 H3의 공식 안내상 int8에도 약 75GB의
호스트 RAM이 필요할 수 있고 로딩 중 최고 사용량은 더 높을 수 있다. RAM이 부족하면
실행 전에 모델 형식과 대안을 다시 판단해야 한다. `bf16_offload`는 양자화를 끄며
더 많은 호스트 RAM이 필요하다. 첫 생성은 모델 로딩·양자화 때문에 오래 걸릴 수 있다.

점검에 사용한 **같은 원격 터미널**에서 서버를 시작한다. 서버와 브라우저가 모두
원격 컴퓨터에서 실행되므로 루프백 주소를 사용한다. 별도의 포트 공개나 터널 설정은
필요하지 않다. 아래 `h3-results`는 원격 컴퓨터의 영상 저장 폴더다.

```bash
# Parsec으로 접속한 GPU 컴퓨터
pnpm install --frozen-lockfile
pnpm --filter @nodal/web build
uv run --no-sync nodal serve --host 127.0.0.1 --port 8188 --assets ./h3-results --web apps/web/dist
```

웹 빌드/런처 설정은 [개발 안내](dev.md)를 따른다. **Parsec 화면 안의 원격 브라우저**에서
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

Pruned 추가 시 검토한 외부 클래스로 작은 무작위 모델을 생성해 safetensors 저장·로컬
재로딩, AdaLN rank 8 및 float32 버퍼 유지, 실제 torchao ConvRot INT8 연산을 CPU에서
확인했다. attention 출력 상대 오차는 해당 시험 입력에서 약 0.01이었다. 이는 출시된
H3 가중치의 영상 품질 검증이 아니다. 회귀 테스트는 소스 해시 불일치 차단, 일반 모델의
ConvRot 프로필 거부, Pruned 로더 선택, 양자화 실패 시 해제를 검사한다.
