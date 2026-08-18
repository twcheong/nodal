/**
 * 위젯 힌트의 **닫힌 어휘** (docs/design.md §9.4).
 *
 * `/api/nodes` 의 `widget` 은 OpenAPI 에서 자유 딕셔너리라 `generated.ts` 가
 * `Record<string, unknown>` 을 준다. 그래서 여기에 리터럴 타입이 없으면
 * `"randomise"` 라고 오타를 내도 tsc 가 통과시키고, 백엔드도 자기 검증만 하므로
 * **양쪽 저장소가 다 초록인 채로 런타임에야 드러난다** (AGENTS.md 협업 규칙 7
 * 의 아래 칸 — 조용히 어긋나는 층).
 *
 * 어휘의 단일 소스는 `types.json` 의 `widget_vocabulary` 이고 Python 쪽
 * `Seed.CONTROLS` 도 거기서 읽는다. 아래 `SEED_CONTROLS` 는 그 배열을 **리터럴
 * 튜플로 다시 적은 것**인데, 그래야 하는 이유는 TypeScript 가 JSON 모듈의
 * 배열을 `string[]` 으로 넓혀 버려 리터럴 유니온을 뽑을 수 없기 때문이다.
 *
 * 그 중복은 `widgets.test.ts` 가 `types.json` 과 대조해 고정한다. 즉 층이 둘이다:
 *
 * - **tsc** 가 `"randomise"` 같은 오타를 잡는다 (이 파일의 리터럴 타입)
 * - **vitest** 가 이 리터럴이 `types.json` 에서 낡는 것을 잡는다
 */

import typesJson from "@nodal/types";

/**
 * 시드 위젯의 `control` 값.
 *
 * 순서가 UI 의 순서다. `types.json` 의
 * `widget_vocabulary.seed.control` 과 같아야 하며 테스트가 강제한다.
 */
export const SEED_CONTROLS = ["fixed", "increment", "randomize"] as const;

/** 시드 위젯의 `control` 값 타입. 프론트 상태를 이 타입으로 두면 오타가 컴파일 에러다. */
export type SeedControl = (typeof SEED_CONTROLS)[number];

/** `types.json` 이 실제로 싣고 있는 어휘. 위 리터럴과의 대조에 쓴다. */
export const SEED_CONTROLS_FROM_TYPES: readonly string[] =
  (typesJson as { widget_vocabulary?: { seed?: { control?: string[] } } }).widget_vocabulary?.seed
    ?.control ?? [];

/**
 * 시드 위젯 힌트. `/api/nodes` 의 `widget` 이 이 모양이면 시드 위젯이다.
 *
 * 인덱스 시그니처가 있는 이유는 `isSeedWidget` 이 타입 술어이기 때문이다 —
 * 좁히는 타입은 좁혀지는 타입(`Record<string, unknown>`)에 할당 가능해야 한다.
 * 실제로도 맞는 서술이다: 백엔드의 `widget` 은 자유 딕셔너리라 우리가 모르는
 * 키가 더 있을 수 있다.
 */
export interface SeedWidget extends Record<string, unknown> {
  seed: true;
  control: SeedControl;
  min: number;
  max: number;
  step: number;
}

/**
 * 서버가 보낸 `control` 문자열을 좁힌다.
 *
 * 리터럴 타입만으로는 **우리 코드**의 오타밖에 못 잡는다. 서버가 새 값을
 * 보내기 시작하면 (또는 구버전 백엔드에 붙으면) 그 값은 타입 검사를 우회해
 * 흘러들어온다. 그래서 경계에서 한 번 좁힌다.
 *
 * 모르는 값이면 `null` 이다 — 조용히 `"fixed"` 로 떨어뜨리지 않는다. 부르는
 * 쪽이 "이 백엔드는 내가 모르는 시드 모드를 쓴다" 를 사용자에게 말할 수 있어야
 * 한다. 시드는 재현성이 존재 이유라 조용한 대체가 특히 나쁘다.
 */
export function parseSeedControl(value: unknown): SeedControl | null {
  return SEED_CONTROLS.includes(value as SeedControl) ? (value as SeedControl) : null;
}

/**
 * 콤보 소켓이 제시할 옵션 목록.
 *
 * **`/api/nodes` 의 `widget.options` 가 유일한 출처다.** 서버는 고정 목록
 * (`Combo(options=[...])`) 이든 공급자 스캔 결과(`Combo.from_provider`) 든
 * 똑같이 `options` 에 채워 보낸다 (`nodal_server.wire._widget_model`).
 *
 * 한동안 공급자 콤보만 별도의 `/api/models` 응답을 읽었는데, 그 엔드포인트는
 * 언제나 빈 목록이라 체크포인트 드롭다운이 늘 "모델 없음" 이었다. 목록이 두
 * 경로로 오면 그중 하나는 반드시 낡는다 — 그래서 경로를 이 하나로 줄였다
 * (`decisions.md` 2026-08-18).
 *
 * 빈 배열은 **"고를 것이 없다"** 는 뜻이고 그것도 유효한 답이다. 공급자
 * 콤보라면 모델 폴더가 비었다는 말이므로 부르는 쪽이 그렇게 안내한다.
 */
export function comboOptions(widget: Record<string, unknown> | undefined): string[] {
  if (!Array.isArray(widget?.options)) return [];
  // `Array.isArray` 는 `any[]` 로만 좁힌다. `unknown[]` 로 다시 받아야 아래
  // `every` 가 실제 검사가 된다 (tsc 가 그 술어로 `string[]` 까지 좁혀 준다).
  const items: unknown[] = widget.options;
  return items.every((item) => typeof item === "string") ? items : [];
}

/**
 * 이 콤보의 옵션이 **서버가 디스크를 훑어 채운 것**인가.
 *
 * 참이면 목록이 비었을 때 "모델 폴더가 비어 있다" 고 말할 수 있다. 고정 옵션
 * 콤보(샘플러 이름 등)가 비는 것은 서버 버그이지 사용자가 고칠 일이 아니므로
 * 둘을 같은 말로 안내하면 안 된다.
 */
export function comboProvider(widget: Record<string, unknown> | undefined): string | null {
  const value = widget?.provider;
  return typeof value === "string" ? value : null;
}

/** 위젯 힌트 딕셔너리가 시드 위젯인지 판별한다. */
export function isSeedWidget(widget: Record<string, unknown> | undefined): widget is SeedWidget {
  return (
    widget !== undefined &&
    widget.seed === true &&
    parseSeedControl(widget.control) !== null &&
    typeof widget.min === "number" &&
    typeof widget.max === "number" &&
    typeof widget.step === "number" &&
    Number.isSafeInteger(widget.min) &&
    Number.isSafeInteger(widget.max) &&
    Number.isSafeInteger(widget.step) &&
    widget.min <= widget.max &&
    widget.step > 0
  );
}
