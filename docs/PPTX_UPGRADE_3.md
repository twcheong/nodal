# 덱 생성 고도화 3·4차 — 같은 프롬프트 실측 루프

> **대상:** Twixy 팀 (개발)
> **한 줄:** 같은 프롬프트를 Twixy와 Claude Code에 넣어 나온 두 .pptx를 XML 레벨로 X-ray → 격차를 수치로 좁히는 레버 도출 → 구현 → 재실측. 이 루프를 두 바퀴 돌린 기록. 2차(아키텍처 이식)가 "그들처럼 **볼 수** 있게" 만들었다면, 3·4차는 "그들만큼 **그리게**" 만드는 단계다.
> **상태:** 구현 + 로컬 검증 완료. 미완 1건 (§7 — 앱 재시작 E2E, 2차 §8과 동일 사유).
> **브랜치:** `feature/pptx-skill-upgrade` (커밋 93f5fca · e6f55ac · 78ef056 · 00f7aba)
> **선행 문서:** [PPTX_DECK_GENERATION.md](PPTX_DECK_GENERATION.md) (1차 — 공유 코어) · [PPTX_UPGRADE_2.md](PPTX_UPGRADE_2.md) (2차 — 목적×얼굴×브랜드 + 모델의 눈) · [DECK_TEMPLATE_CATALOG.md](DECK_TEMPLATE_CATALOG.md) (비즈니스 카탈로그)
> **후속 문서:** [PPTX_UPGRADE_4.md](PPTX_UPGRADE_4.md) (5–10차 — 실물 피드백 루프: 여백·타이포·디바이더·기하 검사·언어·페이지 타입)

---

## 1. 방법 — 프롬프트는 같고, 파일은 거짓말을 못 한다

비교 대상은 감상이 아니라 파일이다. 동일한 EDIS 계정 전략 프롬프트로 만든 두 덱을 unzip해서 슬라이드별 도형 수·prstGeom 종류·색 분포·네이티브 테이블·이미지(pic)를 세면, "Claude가 더 좋아 보인다"가 **어느 레버 몇 개짜리 격차인지**로 바뀐다.

**1차 실측 (3차 고도화 전):**

| | Twixy | Claude |
|---|---|---|
| 슬라이드 | 9장 | 20장 |
| 장당 도형 | 평균 14 | 평균 26 (최대 52) |
| 기술 스택 | 공유 코어 | 마스터 1개 · 그라데이션 0 · 커스텀 도형 0 |

결론: 격차는 기술이 아니라 **장당 조판 밀도와 서사 길이**였고, 서사 길이는 우리 프롬프트의 "10 slides max" 한 줄이 스스로 씌운 뚜껑이었다. → 3차 레버 4개 (§2).

**2차 실측 (3차 적용 후, 같은 프롬프트 재실행):**

> ⚠️ **정정 (2026-08-17).** 이 표는 처음 쓸 때 두 덱의 **귀속이 서로 바뀐 채**
> 기록됐다. 파일명만 보고 판단한 결과다. 나중에 페이지 배지의 기하로 확정했다
> — 우리 엔진은 배지가 `(12.38, 6.98, 0.55)`에 **평문 숫자**이고 푸터가 없다:
>
> | 파일 | 배지 | 정체 |
> |---|---|---|
> | `..._고도화2` (21장) | (12.38, 6.98, 0.55) 평문 | **Twixy** |
> | `EDIS_퍼널전략_내부덱_3` (15장) | (12.20, 7.06, 0.63) 제로패딩 + 푸터 | **Claude** |
>
> 정정된 사실: 장당 도형은 **우리 10 / 벤치마크 23** 으로 우리가 뒤졌고,
> **"01/02" 디바이더 8장은 우리 출력**이었다(그래서 §5-3 의 디바이더 제거가
> 더욱 옳은 수정이었다). 아이콘 0개도 우리 쪽이다.

| | Twixy (고도화2) | 벤치마크 (내부덱_3) |
|---|---|---|
| 슬라이드 | 21장 | 15장 |
| 장당 도형 | 평균 10 | **평균 23 (최대 44)** |
| 콘텐츠 페이지 | 13장 — **8장이 "01/02…" 디바이더** | 15장 전부 |
| 아이콘 | **0개** | 4개 |

남은 격차는 유저가 정확히 셋으로 짚었다 — ① 그래픽 장치 부족 ② 디바이더
페이지는 불필요 ③ 오버뷰가 늘 같은 모양. → 4차 (§5).

**교훈:** 파일명은 증거가 아니다. 생성기 지문(배지 좌표·푸터 유무·제로패딩)은
증거다. 이후 모든 비교는 지문으로 귀속을 먼저 확정하고 시작한다.

이 루프의 요점: **레버는 항상 파일 X-ray에서 나온다.** "고급스럽게"는 작업 지시가 못 되지만 "아이콘 0개, 오버뷰 얼굴 1개"는 된다.

---

## 2. 3차 — 밀도 격차 해소 (e6f55ac)

레버 4개, 전부 기존 프리미티브의 사정거리 안:

1. **복합 블록 3종** — `step`(번호 칩+제목+설명 행; span-12 스택 = Claude식 밀도 아젠다) · `chips`(아웃라인 메타 배지) · `funnel`(2–6 좁아지는 밴드 + 커넥터, 밴드별 `pickReadable` 텍스트색).
2. **프리미티브** — El `line`(커넥터) · roundRect `stroke`(+`transparency:100` = 아웃라인 칩) · `TextStyle.charSpacing`(키커 전용 — wrap 메트릭이 모델링하지 않으므로 짧은 단일행 라벨 한정 계약) · `Theme.accent2`(프리셋 7종 큐레이션 + deriveTheme 파생, 롤 폴백이 secondary라 미사용 시 바이트 동일).
3. **목적별 슬라이드 예산** — 일괄 "10 max" 삭제, `DeckPurpose.slideBudget`(pitch 10 · report 12 · decide 8 · align 16 · analyze 12 · teach 16)이 생성기 경유로 프롬프트에 "Budget: ~N slides"로 인쇄.
4. **리치 커버** — cover에 `kicker`+`chips`. 새 필드가 있을 때만 accent2 제2 데코 원 — 게이팅으로 레거시 커버 바이트 동일(스냅샷 실측).

작업 중 잡은 **기존 출하 버그**: night 커버 부제·메타가 `t.light`(다크에선 어두운 '표면'색)로 찍혀 안 보였다 → 롤 `onPrimary`(다크만 pickReadable, 라이트는 t.light 동결) 신설. 같은 이유로 `funnelRun` 롤(다크에서 secondary가 배경 아래로 가라앉음 → light 표면으로 교체).

---

## 3. 실전 사고 — 깨진 QA patch가 멀쩡한 덱을 죽였다 (93f5fca)

첫 실전 E2E(EDIS 17장)에서 파이프라인 전체가 설계대로 돌았고 — purpose 선언 → 시드 얼굴 → 구조 노트 → QA 이미지 → 모델의 복수 deck-patch — 마지막 고리에서 실사고가 났다. QA patch가 `{ type:'kv', label, text }`(스키마엔 `rows`)를 넣었고, 그대로 커밋되자 buildDeck이 위치 없는 TypeError로 죽어 **17장 멀쩡하던 프리뷰 전체가 "Can't render the deck"**이 됐다.

세 겹 수정 — 계약은 이름으로 실패하거나, 조용히 위반된다:

| 겹 | 위치 | 내용 |
|---|---|---|
| ① 이름 있는 검증 | `blocks.ts` `assertBlockBody` | 그리기 전에 바디 타입별 필수 필드 검증. kv 에러는 "there is no label/text on kv"까지 말한다 |
| ② 위치 부착 | `layout/index.ts` | 슬라이드별 try/catch로 `slide N (kind):` 프리픽스 — 모델이 고치려면 어디인지 알아야 한다 |
| ③ 커밋 전 검증 | `CopilotView.tsx` | 후보 덱(spec/patch 적용본)을 **커밋 전에** buildDeck으로 돌려보고, 실패 시 기존 덱 보존 + 위치 붙은 에러로 모델 1회 재시도 |

부수 발견: 한 블록에 `body` 키 중복(heading+paragraph) → JSON이 마지막만 남겨 heading이 **조용히** 사라졌다. soul gotcha에 "블록당 body 하나, 둘이면 두 블록" 명시.

---

## 4. 경고의 청중 교정 — 무손실은 ⚠가 아니다 (78ef056)

실사용 스크린샷에서 "Slide 21 — shrunk 20→15pt" ⚠가 유저 화면에 떴다. autofit은 60% 바닥까지 줄여도 안 들어가면 `shrunk`가 아니라 `overflow`를 낸다(`text/autofit.ts`) — 즉 **`shrunk`가 떴다는 것 자체가 내용이 전부 들어갔다는 증명**이다. 기존 "15% 미만만 접기" 기준을 폐기하고 `isMinor = (w.code === 'shrunk')`로 교체: 사람 화면엔 "N places auto-fitted" 한 줄, ⚠는 진짜 손실(잘림·넘침)에만. 모델 채널(툴 반환·QA 메시지·진단 Copy)은 전문 유지 — 청중 분리 원칙("모델은 전부, 사람은 손실만")의 경계선 교정.

---

## 5. 4차 — 유저 지적 3건의 근원 수정 (00f7aba)

### 5-1. "오버뷰는 왜 늘 하나옵션뿐?" → toc 서술형 + 회전

근원: `toc.sections`가 `string[]`만 받아서 설명 붙은 오버뷰는 soul의 "dense agenda" `layout` 레시피(리터럴 예시 1개)를 베끼는 수밖에 없었고, `layout`은 회전 축이 없다 → **모든 덱의 오버뷰가 같은 기하**. 수정:

- `sections: (string | { label, desc? })[]` (`spec.ts` `TocSection`/`tocEntry`) — 기존 문자열 덱은 그대로 유효, desc 없으면 **바이트 동일**.
- 3 faces(list/sidebar/cards) 전부 desc 렌더 — 오버뷰가 toc로 내려와 **시드 회전으로 덱마다 다른 얼굴**.
- 프롬프트: "아젠다는 toc+desc가 기본. layout 손조판은 번호/아이콘이 필요할 때만 — 손조판 아젠다는 모든 덱에서 같은 모양이 된다."

### 5-2. "좀더 graphic하게" → 어휘 확장 + 채택 강제

| 추가 | 내용 | 비고 |
|---|---|---|
| El `chevron` | prstGeom chevron ↔ SVG 폴리곤, 팁 = 짧은 변의 ½로 실루엣 일치 | adjust 강제 불필요 |
| El `ring` | 트랙 원 + 진행 호. pptx는 arc `angleRange` — OOXML 각도와 1:1 매핑을 avLst 실측으로 검증(270°=12시) | pct 0/100 경계 별도 처리 |
| timeline `chevron` face | 컨설팅 프로세스 스트립. 라벨은 화살표 안(`pickReadable`), desc는 아래 — **content-neutral이라 회전 포함** | 4번째 얼굴 |
| stat `pct` | 0–100이면 링 안에 값 — 비중/달성률 전용 | 미지정 시 기존 스탯 바이트 동일 |
| 코너 고스트 데코 | quote · stats `bare` · summary `takeaways`/`thanks`의 여백에 저채도 원(투명도 88–90) | 페인트 순서 맨 앞 = 항상 뒤 |
| **코드 강제** | structureReport: 6장+ 덱에 그래픽 페이지(chart/table/timeline/image/stats/그래픽 블록 든 layout) 0개면 노트. QA 체크리스트에 "산문만 이어지는 구간" 항목 | 실측에서 아이콘 0개 = 채택 문제였으므로 프롬프트만으론 부족 |

### 5-3. "01 역할 맵 같은 섹션 페이지 불필요" → 디바이더 강등

근원이 **우리 코드에도** 있었다: structureReport 레거시 체크의 `'no section divider — the deck has no parts'`가 디바이더를 넣으라고 훈련시키고 있었다. 수정:

- 그 라인 삭제 (+ 회귀 테스트 "no divider nudge").
- purpose 3곳(part 슬롯 guide): "dividers ONLY if the deck runs 14+ slides — 파트명은 페이지 제목에 접어라('FUNNEL · …')". 실제로 Twixy E2E 덱은 이미 그렇게 하고 있었다(제목 "역할 정의 · ROLE").
- soul/tskill/패치 툴 설명에 NO DIVIDER PAGES 규칙. `section` kind 자체는 유지 — 14장+ 대형 덱과 명시 요청용.

---

## 6. 검증 실록 (3·4차분)

| 검증 | 결과 |
|---|---|
| arc angleRange 의미 | 스크래치 pptx 생성 → avLst 확인: `[270,396]` → `stAng 16200000/adj2 2160000` — OOXML 도 단위 1:1, 시작 12시 확정 |
| 스냅샷 (4차) | **addText 3516→3516 (텍스트 손실 0)** · addShape 729→827 (+98, 전부 데코) · 신규 픽스처 8장(chevron/toc desc×2/ring) |
| roundtrip | 3,294 strings — toc desc·chevron 라벨/desc 생존 포함 |
| 눈검사 | 신규 4 faces × twixy/night + 데코 페이지 — SVG→sharp PNG로 직접 확인 (다크 대비 포함) |
| structure-check | 신규: all-prose 플래그 on/off · no-divider-nudge · bad-kv 이름+위치 · unknown block type |
| 스냅샷 (3차) | 다크 커버 6장(=onPrimary 버그픽스 정확히 그 범위) + composite 2종만 diff |
| 프롬프트 전파 | gen-prompt-block --write (마커 4곳) + check-prompt-schema OK — 패치 편집 시 ` \| ` 구분자 공백 3곳 깨진 것 grep으로 잡아 복구 |
| **실전 crash (231fb62)** | 모델이 쓴 "⚠️"(이모지 표현 시퀀스)가 QA 시트 래스터의 Pango를 **abort**시켜 앱 전체가 죽음 — VS16으로 재현(exit 133) 후 `stripEmojiForPango`(sharp 경로 한정 소독, Blink/PowerPoint는 이모지 유지) + roundtrip 스모크 회귀 |
| **crash 후유증 (a7eb7f1)** | 위 abort로 electron main이 SIGABRT → 게이트웨이 자식이 PID 1로 재양육되어 :18789를 계속 점유 → 이후 **모든 실행이 openclaw 락 재시도 루프에 영구 착륙**(앱 재시작으로도 복구 불가). `before-quit` 정리는 정상 종료에만 도는 게 근원 — `reclaimOrphanGateway()`로 시작 시 스윕(Chrome 스윕과 같은 규율). PID 파일 + 포트 점유 **두 조건 동시 충족** 시에만 kill하므로 유저 자신의 게이트웨이·재활용 PID는 안전 |

**교훈 반복 확인:** 이번에도 하네스가 사람보다 먼저 잡았다 — 스냅샷의 addText 불변 검사(데코가 텍스트를 밀어냈다면 즉시 보임), roundtrip의 kv 헤더 설계-부재 분류, 그리고 baseline diff를 "덮어쓰기 전에 읽는" 규율.

---

## 7. 남은 것 — 앱 재시작 E2E (2차 §8에 추가)

툴 설명(chevron·ring·toc desc·디바이더 규칙)은 스폰 시점에 읽히므로 **앱 재시작 후**:

1. 같은 EDIS 프롬프트 3회차 → 오버뷰가 toc 얼굴로 나오는지, 디바이더 0장인지, 그래픽 페이지 비율(체브론/링/아이콘 채택)
2. 제목만 바꾼 두 덱 → 오버뷰 얼굴이 서로 다른지 (toc 회전이 이제 오버뷰에 걸린다)
3. PowerPoint/Keynote에서 chevron·ring 실파일 렌더 확인 (arc는 XML 레벨 검증만 완료)
4. 2차 §8의 기존 체크리스트 (Content QA 루프 · 워크플로 이미지 · 편집 라우팅)
