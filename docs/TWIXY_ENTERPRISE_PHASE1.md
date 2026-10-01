# Twixy Enterprise 초기 구현 전략 (Option C)

## 현재 접근 방식: Same repo, different entry point

빠른 시작을 위해 Twixy 레포 안에서 `APP_MODE` 환경변수로 분기하는 방식으로 진행합니다.

```
Twixy Marketing Copilot/
  src/
    admin/          ← Twixy Enterprise 전용 어드민 패널 코드만 추가
  electron/
    main.ts         ← APP_MODE env로 Twixy / Twixy Enterprise 분기
  twixy-enterprise.html       ← 어드민이 포함된 Twixy Enterprise entry point
  index.html        ← 기존 Twixy entry point (그대로)
```

### 핵심 원리

- Twixy 코드는 **100% 그대로** 유지
- `APP_MODE=twixy-enterprise` 빌드 시 → `src/admin/` 코드가 추가로 로드됨
- `APP_MODE=twixy` 빌드 시 → 기존 Twixy 그대로

### 빌드 명령

```bash
# Twixy 빌드 (기존과 동일)
npm run build

# Twixy Enterprise 빌드
APP_MODE=twixy-enterprise npm run build:twixy-enterprise
```

---

## 이 방식의 한계

- 앱이 2개 이상으로 늘어나면 한 레포에서 관리하기 복잡해짐
- 각 앱의 어드민 패널이 Twixy 레포 안에 뒤섞이기 시작함
- 나중에 생길 앱B, 앱C의 core 코드를 공유할 방법이 없음

---

## 이후 방향 (Option B: Monorepo)

앱이 추가되거나 구조가 복잡해지는 시점에 모노레포로 이전합니다.

> 자세한 내용은 [MONOREPO_ARCHITECTURE.md](./MONOREPO_ARCHITECTURE.md) 참조
