# 인물 비율과 구도 수정 시안

사용자 피드백: 이전 투샷은 남녀 몸 크기 차이가 과하고 참고 영상과 구도가 너무 달랐다.
이전 `original-couple-draft/02-master-two-shot.png`의 몸 비율과 배치는 채택하지 않는다.

## 이번 수정

- 참고 영상의 27초 프레임을 시각적으로 확인해 배치만 설명했다.
  원본 프레임은 생성 모델에 넣지 않았다.
- 남성은 왼쪽 소파에 앉고, 여성은 오른쪽에 선다. 가운데 낮은 테이블과 뒤쪽 큰 창.
- 인체 전체는 다시 생성한다. 두 사람의 얼굴만 기존 신규 캐릭터 기준 이미지
  `original-couple-draft/01-cast-room.png`에서 **nodal image.Crop**으로 추출해
  FLUX.2 Klein의 독립 참조 두 개로 입력했다.
- 두 사람의 머리 크기, 바닥 접점, 앉은 사람과 선 사람의 상대 높이를 시각적으로 검토했다.
  실제 키를 측정한 결과나 수치적으로 동일한 카메라 재현이라고 주장하지 않는다.
- 기준 이미지는 `01-corrected-wide.png`, 1536×864 정지 시안이다.
- 이미지 생성·크롭은 모두 로컬 nodal 노드/MCP 경로다. 외부 이미지 생성은 사용하지 않았다.

## 재현 기록

- 실행 ID: `e24745af6c2048a9952ec0e88820a4c3`
- 에셋: `8ff9e10d004c1b44209a6bf352d2ff6a`
- 모델: FLUX.2 Klein Base 4B / 28 steps / seed 920271
- 노드 팩 소스: 기존 `codex/flux2-base-test`, `5758ea2eefba20de97c02487dd6ec1b2eaa5f57b`

프롬프트·모델 경로·기준 이미지·실행 결과·출력 SHA-256은 동봉한 JSON에 보존한다.
크롭 범위와 노드 연결은 `templates/flux2_klein_multi_reference.nodal.json`에 있다.

## 영상 시안 (2026-09-21)

사용자가 수정 이미지에서 영상으로 진행하도록 요청해 같은 투샷을 약 5.17초로 생성했다.
원본 릴 전체를 재제작한 완성 편집본이 아니라, 승인된 구도에서 두 사람이 대화하는 첫 영상 시안이다.

- 재생 파일: `03-couple-video-1080p.webm`, 미리보기: `preview.html`.
- 기준 입력: `01-corrected-wide.png`. 인스타그램 원본 프레임은 모델에 입력하지 않았다.
- nodal MCP `run_template_h3_image_video`, 로컬 MiniMax-H3-Pruned,
  `pruned_convrot_int8_offload`, seed 921271, steps 20 (실제 추론 반복 19회).
- 생성 해상도 1024×576, 124프레임, 24fps. 영상 생성 실행 ID:
  `50aacccff3364b829f9d79858d63a9a1`, 에셋 `47924abbc86cff98021f137972867209`.
- nodal MCP `run_template_upscale_video`와 로컬 RealESRGAN_x4plus로 1920×1080 업스케일.
  처음부터 1080p로 생성한 영상은 아니다. VP9 CRF 18, 생성 음성은 Opus로 보존한다.
- 화면 자막·제목은 추가하지 않았다. 외부 이미지·영상·음성 생성 서비스를 사용하지 않았다.

### 결과 검토

- 시작부터 끝까지 22개 프레임을 추출해 확인했다. 남성은 왼쪽 소파에 앉고 여성은 오른쪽에 서며,
  두 사람의 크기와 발 위치, 가운데 테이블과 뒤쪽 창 배치가 유지된다.
- 움직임은 작은 표정 변화와 고개 움직임 위주다. 배경과 얼굴의 미세한 생성 변화까지 없는
  픽셀 단위의 고정 영상이라고 주장하지 않는다.
- 로컬 Whisper small이 한국어로 `이건 어때?` (0–1.44초), `귀여워` (3.00–3.94초)를 인식했다.
  이는 자동 음성 인식 검증이며, 사람이 청취해 발음·성별·립싱크를 확정한 기록은 아니다.
- 검토 자료는 `native-qa/`, `restored-qa/`, `generated-transcript.json`, `video-qa-review.json`에 있다.
  자동 추출 파일의 `visual_identity_verified`와 `speech_accuracy_verified`는 자동 판정하지 않아 false이며,
  별도 검토 기록에서 실제 확인한 범위를 설명한다.

영상의 요청·seed·실행 결과와 출력 SHA-256은 `02-*`, `03-*`, `video-qa-review.json`에 보존한다.

이번 변경은 제작 기록과 템플릿뿐이며 앱 코드는 수정하지 않았다.
작업 Python 파일 ruff lint/format 통과. 전체 `tools/ci-local.sh`를 실행했으며
이전과 같은 Python lint/format, 웹 prettier, 생성 API 타입 drift 실패가 남아 있다.
영상 작업에서도 전체 `tools/ci-local.sh`를 실행했다: 21 통과, 4 실패, 10 건너뜀.
상세 결과는 로컬 `ci-local.log`, `ci-video.log`에 보존한다.
