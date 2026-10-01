# Watchtower (워치타워)

마케팅 플랫폼을 지속적으로 모니터링하고 KPI 변화에 알림을 보냅니다.

## 목적

Watchtower 는 Twixy 의 상시 감시 레이어입니다. 사용자 플랫폼의 핵심 지표를 추적하고, 의미 있는 변화(급등·급락·트렌드)를 감지하고, 액션이 필요할 때 다른 에이전트를 트리거합니다.

## 트리거 (Triggers)

아래 요청 시 활성화:
- "set up monitoring for [platform] / 모니터링 설정"
- "watch my [metric] / 지표 감시"
- "alert me when [condition] / 조건 발생 시 알림"
- "what's changed since last time / 지난 번 대비 뭐가 바뀌었어"
- 또는 cron 스케줄로 자동 실행

## 동작 (Behavior)

### 1. 감시 대상 정의
사용자에게 질문 (또는 컨텍스트에서 추론):
- **플랫폼:** Instagram / X (Twitter) / YouTube / LinkedIn / TikTok / 블로그 / 커스텀 URL
- **지표:** followers, engagement rate, post reach, clicks, comments, saves
- **임계값:** 예: "engagement 가 7일 평균 대비 >20% 하락 시 알림"
- **빈도:** 시간별 / 일별 / 주별

### 2. 모니터링 설정

`~/.openclaw/workspace/twixy/data/watches/<platform>.json` 에 watch 설정 생성:

```json
{
  "platform": "<platform>",
  "url": "<profile or dashboard url>",
  "metrics": ["<metric1>", "<metric2>"],
  "alert_rules": [
    { "metric": "<metric>", "condition": "drop_pct > 20", "window_days": 7 }
  ],
  "last_checked": null,
  "schedule": "0 9 * * *"
}
```

OpenClaw 스케줄링 툴을 통해 cron 으로 watch 예약.

### 3. 체크 실행

스케줄된 각 실행마다:
1. 브라우저 자동화로 플랫폼 이동
2. 현재 지표 값 추출
3. `~/.openclaw/workspace/twixy/data/raw/<platform>_metrics.json` 의 저장된 baseline 과 비교
4. 임계값 초과 시 → 사용자 알림 + `~/.openclaw/workspace/twixy/logs/watchtower.log` 에 로깅
5. 신선한 데이터로 baseline 업데이트
6. 큰 변화 시 → `data-scout` 트리거해 심층 수집

### 4. 리포트 포맷

알림 시 제공:
```
[Watchtower Alert] <platform>
Metric: <name>
Current: <value>  |  Previous avg: <value>  |  Change: <+/- %>
Triggered rule: <rule description>
Suggested action: [analyze] [scout more data] [ignore]
```

## 데이터 저장

- 원본 스냅샷: `~/.openclaw/workspace/twixy/data/raw/<platform>_metrics.json`
- Watch 설정: `~/.openclaw/workspace/twixy/data/watches/`
- 로그: `~/.openclaw/workspace/twixy/logs/watchtower.log`

## 주의사항

- 절대 콘텐츠 게시/수정 금지 — 읽기 전용 모니터링
- 로그인 필요 시 사용자에게 브라우저 인증 요청; 세션은 OpenClaw 채널 auth 로 저장
- 플랫폼 rate limit 준수; 요청 간 랜덤 딜레이 추가
