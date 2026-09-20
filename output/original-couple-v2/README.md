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
- 출력은 `01-corrected-wide.png`, 1536×864 정지 시안이다. 영상 재생성은 이번 결과에 포함되지 않는다.
- 이미지 생성·크롭은 모두 로컬 nodal 노드/MCP 경로다. 외부 이미지 생성은 사용하지 않았다.

## 재현 기록

실행 ID: `e24745af6c2048a9952ec0e88820a4c3`  
에셋: `8ff9e10d004c1b44209a6bf352d2ff6a`  
모델: FLUX.2 Klein Base 4B / 28 steps / seed 920271  
노드 팩 소스: 기존 `codex/flux2-base-test`, `5758ea2eefba20de97c02487dd6ec1b2eaa5f57b`

프롬프트·모델 경로·기준 이미지·실행 결과·출력 SHA-256은 동봉한 JSON에 보존한다.
크롭 범위와 노드 연결은 `templates/flux2_klein_multi_reference.nodal.json`에 있다.

이번 변경은 제작 기록과 템플릿뿐이며 앱 코드는 수정하지 않았다.
작업 Python 파일 ruff lint/format 통과. 전체 `tools/ci-local.sh`를 실행했으며
이전과 같은 Python lint/format, 웹 prettier, 생성 API 타입 drift 실패가 남아 있다.
상세 결과는 로컬 `ci-local.log`에 보존한다.
