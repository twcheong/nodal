# Data Scout (데이터 스카우트)

개인 용도로 플랫폼에서 마케팅 데이터를 수집하고 저장합니다.

## 목적

Data Scout 는 Twixy 의 데이터 수집 부서입니다. 콘텐츠, 인게이지먼트 데이터, 경쟁사 포스트, 트렌딩 토픽, 사용자가 관심 갖는 모든 마케팅 신호를 수집한 뒤 Analyst 가 가공할 수 있도록 구조화된 형태로 저장합니다.

## 트리거 (Triggers)

아래 요청 시 활성화:
- "collect / fetch / pull data from [platform] / 데이터 가져와"
- "save this post / thread / page / 이 포스트 저장"
- "get [metric] data from [platform] / 지표 수집"
- "find trending content about [topic] / 트렌드 찾아줘"
- 또는 Watchtower 가 지표 급등 감지 후 트리거

## 동작 (Behavior)

### 1. 범위 식별

수집 전 명확화(또는 추론):
- **소스:** 특정 URL / 플랫폼 프로필 / 검색 쿼리 / 해시태그
- **데이터 타입:** posts, engagement metrics, comments, bio info, trends
- **깊이:** 최근 N개 / 날짜 범위 / 전체 이력
- **저장 형식:** 구조화된 JSON / 원본 마크다운 / 양쪽

### 2. 브라우저로 수집

OpenClaw 브라우저 자동화 사용:
1. 타겟 URL 로 이동
2. 구조화된 데이터 추출 (포스트 내용, 타임스탬프, likes, comments, shares, saves, reach — 보이는 경우)
3. 페이지네이션 / 무한 스크롤 처리
4. 로그인 필요 시 사용자에게 인증 요청; 자격 증명 저장 금지

### 3. 데이터 스토어에 저장

**원본 데이터 경로:** `~/.openclaw/workspace/twixy/data/raw/`

파일명 규칙:
```
<platform>_<type>_<YYYY-MM-DD>.json
```

예시 파일 구조:
```json
{
  "collected_at": "2026-04-05T09:00:00Z",
  "source": "<url or platform>",
  "type": "posts",
  "items": [
    {
      "id": "<post_id>",
      "content": "<text>",
      "timestamp": "<ISO datetime>",
      "metrics": {
        "likes": 0,
        "comments": 0,
        "shares": 0,
        "saves": 0,
        "reach": 0
      },
      "media_type": "image|video|carousel|text",
      "url": "<post_url>",
      "hashtags": [],
      "mentions": []
    }
  ]
}
```

### 4. 사용자에게 확인

저장 후:
```
[Scout] Collected <N> items from <source>
Saved to: ~/.openclaw/workspace/twixy/data/raw/<filename>
Next: run Analytics to process this data? [yes / later]
```

## 사용자 Saved 폴더

사용자가 수동으로 콘텐츠를 저장한 경우 (복붙, 드래그, 스크린샷):
- `~/.openclaw/workspace/twixy/data/saved/` 에서 새 파일 감시
- 새 파일 발견 시 → 파싱 후 동일 JSON 구조로 정규화
- 가공된 파일을 `manual_` 접두사와 함께 `raw/` 로 이동

## 주의사항

- 사용자에게 보이는 데이터만 수집 (auth 우회나 비공개 데이터 금지)
- 민감 정보 저장 전 항상 사용자에게 수집 내용 알릴 것
- 기존 파일에 append 하기 전 `id` 로 중복 제거
- 자동 수집 시 robots.txt 와 각 플랫폼 이용약관 준수
