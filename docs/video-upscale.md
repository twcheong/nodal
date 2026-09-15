# AI 영상 업스케일

`AI Upscale Video` (`diffusion.UpscaleVideo`)는 H3 WebM을 프레임별로
Real-ESRGAN 등의 초해상도 모델에 넣어 선명도를 보강한다. 모델 구현은
Spandrel 0.4 기본 패키지에 위임한다. 단순 Lanczos 확대나 새로운 영상 생성이 아니다.
모델의 원래 2x/4x 출력에서 목표 크기로 맞출 때만 Lanczos 축소를 사용한다.

## 설치

GPU 컴퓨터의 nodal 폴더에서 실행한다. 기존 CUDA/H3 설정을 유지한다.

```powershell
uv sync --locked --extra cuda --group h3 --group upscale
```

CPU 테스트 환경은 `uv sync --locked --group diffusion --group h3 --group upscale`을
사용한다. `upscale` 그룹만 단독으로 설치해 하드웨어별 torch 선택을 생략하지 않는다.

[공식 모델 목록](https://github.com/xinntao/Real-ESRGAN/blob/master/docs/model_zoo.md)의
`RealESRGAN_x4plus.pth`를 `models/upscale/`에 별도로 준비한다.
다운로드 주소는 공식
[v0.1.0 릴리스](https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth)다.
2026-09-15 확인 파일의 SHA-256은
`4fa0d38905f75ac06eb49a7951b426670021be3018265fd191d2125df9d682f1`이다.
이 값은 다운로드된 파일의 식별 기록이며 별도 서명 검증을 대신하지 않는다.
가중치는 Git에 포함하지 않는다. 자동 다운로드나 임의 모델 코드 실행은 하지 않는다.

선택적으로 서버 시작 전에 기본 모델을 지정한다:

```powershell
$env:NODAL_UPSCALE_MODEL = (Resolve-Path 'models/upscale/RealESRGAN_x4plus.pth').Path
.\tools\start-h3.ps1
```

## 노드 사용

팔레트에서 `업스케일` 또는 `AI Upscale Video`를 검색한다.

- 새 생성: H3의 `video` 출력을 이 노드의 `video` 입력에 연결하고 `source`는 비운다.
- 기존 영상: `video`는 연결하지 않고 `source`에 서버 로컬 WebM 경로를 넣는다.
  일반 그래프에서는 `asset:<hash>`도 받는다.
- `model_path`: 로컬 `.pth` 또는 `.safetensors`. 비우면 환경변수를 사용한다.
  `.pth`는 `torch.load(weights_only=True)`로만 읽고 TorchScript는 거부한다.
- `short_edge`: 짧은 변 `720` 또는 `1080`. 방향과 비율을 유지하며 긴 변은 짝수로 반올림한다.
  원본 384×576은 각각 **720×1080**, **1080×1620**이 된다. 512×288은 각각
  1280×720, 1920×1080이다. 크롭·늘이기·검은 여백을 자동으로 넣지 않는다.
- `tile_size`: 기본 256, 메모리 부족 시 줄인다. 타일에 문맥용 32픽셀 경계를 포함하고
  중앙부만 합친다. 모델과 타일 크기에 따라 경계 차이가 생길 수 있다.

`examples/h3-upscale-video.nodal.json`에서 `source`를 준비한 영상으로 바꾸면
생성 모델을 다시 로드하지 않고 업스케일만 실행할 수 있다. H3 생성은 캐시하지 않으므로
생성 노드가 연결된 그래프 전체를 다시 실행하면 H3도 재실행된다.

출력은 새 WebM 에셋으로 저장된다. 원본은 수정하지 않는다. 브라우저의 기존 영상
플레이어·저장 기능을 사용하며 24fps H3 입력의 프레임 수·타임스탬프를 유지한다.
Opus는 패킷 복사하므로 재압축하지 않는다. CPU/GPU 메모리를 아끼기 위해 한 프레임씩
처리한다. 취소는 프레임·타일 경계에서 확인하고 취소 결과는 에셋으로 저장하지 않는다.

## MCP

`examples/templates/upscale_video.nodal.json`을 사용자 홈
`.nodal/templates/`에 복사하고 실행 중인 작업이 없을 때 서버를 재시작한다.

```powershell
uv run --no-sync python tools/upscale_mcp_test.py --source 'C:\videos\character.webm' --model-path models/upscale/RealESRGAN_x4plus.pth --short-edge 720
```

`run_template_upscale_video`를 호출하고 `get_run`으로 완료를 확인한다.
`--run-id ID`로 관찰을 재개할 수 있다. MCP의 `asset:` 예약 입력은 기존 계약상
Image만 허용하므로 이 STRING 템플릿에는 **로컬 영상 경로**를 사용한다.
이 제약을 우회하거나 공용 MCP 스키마를 변경하지 않았다.

## 검증과 한계

2026-09-15 RTX 5080에서 원의 걷기 영상에 RealESRGAN_x4plus를 적용했다.
720×1080 실행 ID는 `98fc8e6966ea4556b4e181a0de91618a`,
에셋은 `89163a772b925dc5ad5775df680858e7`이다. 실행은 약 52.2초였다.
재디코딩으로 24fps/124프레임/약 5.17초, 전체 타임스탬프 일치,
Opus 패킷과 오디오 샘플의 완전 일치를 확인했다. 첫·중간·마지막 프레임을
같은 크기의 단순 확대본과 비교해 머리카락·의상·신발 윤곽 보강을 확인했다.
로컬 결과·요청·QA 기록은 `outputs/h3/won-upscale720/`에 있다.

1080×1620도 같은 원본에서 별도로 실행했다(720 결과를 재확대한 것이 아니다).
실행 ID `f35264a30f7e496182163deb2f1d24ac`, 에셋
`ec81753e9e9b3ea660aa11fa3cc4fbd2`, 약 55.4초였다. 124프레임의 타임스탬프와
Opus 패킷·디코딩 오디오의 완전 일치를 동일하게 확인했다.
결과는 `outputs/h3/won-upscale1080/won-walking-ai-1080.webm`에 있다.

현재 지원 입력은 단일 **8-bit VP9 WebM + 선택적인 Opus 트랙 하나**다.
MP4, HDR, 다중 오디오·자막, 배치 영상은 지원하지 않는다. 모델은 RGB 2x/4x 및
타일 지원 모델에 한정한다. 원본보다 작은 목표나 모델 배율을 넘는 확대는 거부한다.
Spandrel의 모든 모델을 실제 검증한 것은 아니다.

이 방식은 **시간축을 학습한 영상 복원 모델이 아니라 프레임별 초해상도**다.
깜박임이나 원본의 발·얼굴 형태 오류를 없앤다고 보장하지 않는다. 없던 세부는
추정되므로 원의 고유 얼굴을 정확히 복원하는 도구로 해석하지 않는다.
별도의 얼굴 복원/GFPGAN이나 프레임 보간은 적용하지 않는다.
