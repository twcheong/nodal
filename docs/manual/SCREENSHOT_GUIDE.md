# 매뉴얼 스크린샷: 작업 방식과 현황

## 원칙 (고객용 문서 전반에 적용)

**고객·사용자용 문서에 스크린샷이 필요하면, 실기기 캡처를 기다리지 말고 UI 코드를 근거로 HTML 목업을 만들어 캡처한다. 화면이 비어 보이지 않도록 상황에 맞는 목데이터도 함께 만든다.**

앱이 로그인 게이트 뒤에 있어 캡처를 대신할 수 없고, 그렇다고 스샷 자리를 비워두면 문서가 반쪽이 되기 때문입니다. UI 가 인라인 스타일 + `src/design/tokens.css` 토큰이라 시각 스펙을 코드에서 그대로 뽑아 재현할 수 있습니다.

지킬 것:

1. **코드에서 스펙을 먼저 뽑는다.** 패널 px, 색 토큰, 폰트, 그리고 **정확한 UI 문자열과 글리프**(`＋` U+FF0B, `↓`, `▾` 등). 다른 문자를 쓰면 티가 납니다.
2. `demo/` 에 샷당 HTML 1개 + 공용 `tokens.css`. **`<html data-theme="light">` 로 고정.** 안 하면 보는 사람 OS 가 다크모드일 때 뒤집힙니다.
3. **목데이터는 문서 전체가 하나의 이야기로 이어지게** 만듭니다. 현재는 "카페 브랜드 클라이언트 경쟁사 조사 → 표 저장 → 월간 보고 덱".
4. 캡션에 **"(화면 예시)"** 를 붙입니다. 재현본임을 숨기지 않습니다.
5. **데모 HTML 을 레포에 남깁니다.** UI 가 바뀌면 목업만 고쳐 재캡처하면 되고, 실기기 캡처로 교체할 때도 같은 파일명으로 덮어쓰면 됩니다.

---

## 지금 상태: 데모 렌더 완료

앱이 로그인으로 잠겨 있어 실기기 캡처 대신, **UI 코드의 시각 스펙을 그대로 재현한 HTML 데모**(`demo/`)를 headless Chrome으로 캡처해 넣었습니다. 데모 데이터는 카페 브랜드 경쟁사 조사 시나리오로 채웠고, 문서에는 "(화면 예시)" 캡션이 붙어 있습니다.

| # | 파일 | 내용 | 데모 소스 |
|---|---|---|---|
| 1 | `images/01-first-screen.png` | 첫 화면 (빈 Chat + 모드 칩) | `demo/01-first-screen.html` |
| 2 | `images/02-mode-chips.png` | 모드 칩 + 입력창 확대 | `demo/02-mode-chips.html` |
| 3 | `images/03-run-browser.png` | 실행 중 3단 (계획·채팅·브라우저) | `demo/03-run-browser.html` |
| 4 | `images/04-ready-to-run.png` | ▶ Ready to run 확인 카드 | `demo/04-ready-to-run.html` |
| 5 | `images/05-deck-designer.png` | 덱 디자인 조작반 (1460px 폭) | `demo/05-deck-designer.html` |
| 6 | `images/06-workflow-canvas.png` | 워크플로 캔버스 (노드 3종) | `demo/06-workflow-canvas.html` |
| 7 | `images/07-human-review.png` | Human Review 노드 확대 | `demo/07-human-review.html` |
| 8 | `images/08-data-management.png` | Data Management + 우클릭 메뉴 | `demo/08-data-management.html` |

## 다시 캡처하는 법

```bash
cd docs/manual
CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$CH" --headless=new --screenshot=images/01-first-screen.png \
  --window-size=1200,800 --force-device-scale-factor=2 --hide-scrollbars \
  "file://$(pwd)/demo/01-first-screen.html"
```

확대 샷 크기: 02는 `760,240` · 04는 `660,330` · 07은 `750,420` · 05는 `1460,860`. 나머지는 `1200,800`.

캡처 후 웹페이지 재생성 (레포 루트에서):

```bash
node docs/manual/build/make.mjs
```

이 스크립트가 Markdown 원본 → 스타일 적용된 HTML 로 바꾸고, `images/` 의 PNG 를 data-URI 로 인라인합니다(웹 게시본은 외부 이미지 요청이 막혀 있어 인라인이 필수).

PDF 재생성:

```bash
node docs/manual/build/pdf.mjs
```

**엠대시 버전** 도 함께 관리합니다. `*.emdash.ko.md` 가 원본이고, 빌드할 때 인자를 붙입니다.

```bash
node docs/manual/build/make.mjs emdash && node docs/manual/build/pdf.mjs emdash
```

기본본을 고쳤으면 엠대시본에도 같은 수정을 반영해야 두 벌이 어긋나지 않습니다. 어느 쪽으로 정해지면 나머지 한 벌은 지우세요.

`make.mjs` 로 HTML 을 먼저 만든 뒤에 실행합니다. 인쇄용 CSS 는 `build/pdf.mjs` 안에 있습니다. **표는 화면에서 가로 스크롤로 처리하지만 종이에는 스크롤이 없어서 넘치면 잘립니다.** 그래서 인쇄에서만 머리글 줄바꿈을 풀고 글자를 줄입니다. 표에 열을 추가했다면 PDF 를 눈으로 한 번 확인하세요.

## 실기기 캡처로 교체하려면

실제 앱 화면을 같은 파일명으로 `images/` 에 덮어쓰고 위 재생성 스크립트를 돌리면 됩니다. UI가 바뀌었을 때는 `demo/*.html` 을 함께 고쳐두면 다음에도 재캡처가 됩니다.
