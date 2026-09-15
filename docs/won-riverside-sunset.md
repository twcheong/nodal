# 원 · 노을 강변 걷기

2026-09-15 사용자가 원의 걷기 영상 배경을 저녁 노을이 지는 강변으로 요청했다.
기존 캐릭터와 의상을 유지하고 장소·시간대만 바꾼 새 버전이다. 이전 영상은 보존한다.

## 생성 방식

회색 배경의 시작 이미지를 그대로 쓰면 첫 장면과 목표 배경이 충돌하므로,
내장 ImageGen으로 강변 시작 이미지를 먼저 편집하고 로컬 H3의 MCP 입력으로 쓴다.
Creative Production의 source-preservation 기준으로 얼굴·체형·의상을 보존한다.
Creative Production 보드의 직접 호출 경로는 이 환경에서 사용할 수 없어,
보드 대신 기존 로컬 파일과 nodal MCP 실행을 사용했다. 외부 영상 모델은 사용하지 않았다.

원본: `output/zimage-training/hwiwon-images/hwiwon (16).png`.
시작 이미지: `outputs/h3/won-riverside-sunset/first-frame.png`.
ImageGen 초안은 발밑 여백이 작아, 캐릭터를 유지하고 카메라만 뒤로 빼는 편집을
한 번 더 적용했다. 실제 생성 이미지에서 손은 여전히 약간 벌어진 상태여서
영상 프롬프트에 팔을 편하게 내리고 걷도록 명시했다.

MCP 실행 ID: `81c8e57384424526bd2f6d6d3f785ab1`.
템플릿: `run_template_h3_image_video`.
설정: 네이티브 **768×1152**, 16스텝, seed 7, 124프레임/24fps,
Pruned ConvRot INT8 offload. AI 업스케일은 적용하지 않는다.
전체 요청·실행 결과는 같은 출력 폴더의 `request.json`, `run.json`에 저장한다.

## 시작 이미지 프롬프트 · 내장 ImageGen

원본 이미지를 편집 대상으로 사용한 첫 호출:

```text
Use case: identity-preserve. Edit the supplied image to create ONE portrait 2:3 first-frame image for a walking video. Replace only the plain gray environment with a beautiful quiet riverside pedestrian path at evening sunset, a clearly visible broad river beside the path, orange-pink sunset reflected in gentle water ripples, distant riverbank trees, warm sky with soft clouds. Keep exactly this stylized 3D game character Won: same face geometry, clearly defined dark irises and natural sclera, short black hair shape, small hoop earrings, oversized black hoodie, white undershirt, loose blue jeans and beige sneakers. Do not reinterpret him as a real human or redesign his eyes. Preserve body proportions, outfit and neutral expression. He is already on the riverside path, standing ready to walk with arms relaxed at his sides. Eye-level full-body frontal three-quarter view similar to reference, with the entire head and both shoes visible and generous ground margin below his feet (about 10% frame height); character fills roughly 78% of frame height so the river and sunset read clearly. Match the original polished stylized 3D rendering, soft warm sunset rim light but gentle neutral fill on face to preserve clear eyes; no silhouette, excessive orange skin, harsh eye shadows, gray studio backdrop, extra people, props, text, logo or watermark. Single image, no comparison panels.
```

첫 결과를 편집 대상으로 사용한 구도 보정 호출:

```text
Edit only the camera framing of this image for a full-body walking video first frame. Pull the camera back moderately so the SAME character occupies about 80% of the image height, with visible empty riverside pavement below BOTH shoes of at least 12% of image height and sky margin over his head. Preserve this exact character face, eyes, hairstyle, body proportions, outfit, pose, lighting, and this exact sunset riverside location, river, railing, orange sky. Do not change character identity or eye details. Extend the existing environment naturally as needed. Portrait 2:3 image. No text, no panels, no new people. The important change is comfortable space around the whole character, especially below shoes; do not simply reproduce the tight existing crop.
```

## 영상 프롬프트

```text
The exact same stylized 3D male character from the first frame, preserving his face, natural dark irises and clear eyes, short black hair, small hoop earrings, oversized black hoodie, white undershirt, loose blue jeans and beige sneakers. He lowers his arms comfortably and walks steadily forward along the riverside pedestrian path, taking three or four natural unhurried steps with alternating footfalls, grounded heel-to-toe contact and gentle opposing arm swing. The camera smoothly tracks backward at his walking speed, maintaining a full-body view with generous space below both shoes, no zoom. The same beautiful evening sunset riverside location is present throughout: broad calm river beside the path, orange-pink clouds, warm golden reflections shimmering subtly on the water, railing and distant trees moving with consistent parallax. Soft sunset light and gentle fill keep his face and eyes clearly visible. Preserve the original stylized 3D game-character rendering and stable identity throughout one continuous shot. Subtle breeze in the foliage and clothing. Quiet footsteps, gentle riverside breeze and soft water ambience, no speech or music.
```

## 검증

실제 MCP 실행이 성공했다. 전체 실행 시간은 **2,465,673ms(41분 6초)**이며,
15회 샘플링 forward는 31분 51초였다.

- 결과: `outputs/h3/won-riverside-sunset/won-riverside-sunset.webm`.
- 에셋: `9a54e9813e08263ac1afe81b8101a910`, 2,324,356바이트.
- 실제 디코딩: **768×1152**, 124프레임, 24fps, 약 5.17초.
  모든 프레임 디코딩 성공, 타임스탬프 단조 증가, 생성 그래프 메타데이터 포함.
- 오디오: Opus 48kHz, 248,000샘플, RMS 약 0.0736. 디코딩과 비무음 여부를
  확인한 것으로, 물소리·발소리의 자연스러움이나 동기화의 청취 검증을 뜻하지 않는다.
- 시각 확인: 5프레임 간격과 마지막 프레임을 포함한 얼굴 26개 시점,
  전신/환경 9개 시점 및 마지막 프레임 원본 크기를 확인했다.
  원의 주요 얼굴 특징·눈동자·헤어·의상이 유지되고, 노을 하늘·강물·난간이
  처음부터 마지막까지 이어진다. 팔을 내린 뒤 발을 번갈아 내딛는 보행이 보인다.
- 한계: 카메라가 같은 거리를 유지하라는 지시를 완전히 따르지 않아 인물이 점점
  커진다. 약 3초 이후 신발이 화면 아래로 벗어나고 마지막은 무릎 부근까지 보이는
  구도다. 따라서 전신 유지 성공이라고 기록하지 않는다. 후반 얼굴은 더 크게 보인다.
  시작 이미지 대비 미세한 얼굴 재해석은 있으며 픽셀 단위 동일성은 보장하지 않는다.
  정적 표본 검토이므로 모든 중간 프레임의 무결함이나 실시간 움직임의 완전함을
  보장하지 않는다.

요청한 노을 강변 배경 변경 결과로 이 버전을 전달한다. 이전 회색 배경의 원본과
업스케일 결과는 그대로 보존했다. 프레임 검토 자료와 메타데이터는 실행 폴더의
`qa/face-sequence.png`, `qa/walking-sequence.png`, `qa/inspection.json`에 있다.
시작 이미지·영상·모델 가중치는 Git에 포함하지 않는다.

## 저장소 검사

제품 코드는 변경하지 않았다. `tools/ci-local.sh` 전체 실행 결과는
통과 20 · 실패 5 · 건너뜀 10이며, 로그는 실행 폴더의 `ci.log`다.
기존 로컬 스크립트의 ruff lint/format, Windows JS MIME 기대값 차이,
프론트 prettier 및 API 생성물 줄바꿈 drift 실패를 그대로 기록한다.
사용자 파일이나 다른 작업의 변경을 이 작업에서 수정하지 않는다.
