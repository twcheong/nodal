import { describe, expect, it } from "vitest";

import { formatDuration, summarizeRunProgress, withNodeProgress } from "./progress";

describe("실행 진행률", () => {
  it("스텝 속도로 노드 남은 시간을 계산하고 완만하게 갱신한다", () => {
    const first = withNodeProgress({ status: "running", startedAtMs: 1_000 }, 2, 10, 3_000);
    expect(first.progress?.etaMs).toBe(8_000);
    const second = withNodeProgress(first, 4, 10, 4_000);
    expect(second.msPerStep).toBe(850);
    expect(second.progress?.etaMs).toBe(5_100);
  });

  it("완료 노드와 실행 중 스텝을 전체 진행률에 합친다", () => {
    const summary = summarizeRunProgress(
      {
        done: { status: "succeeded" },
        running: { status: "running", progress: { step: 5, total: 10, etaMs: 2_000 } },
        queued: { status: "queued" },
      },
      4,
      0,
      3_000,
    );
    expect(summary?.completed).toBe(1);
    expect(summary?.fraction).toBe(0.375);
    expect(summary?.activeStep).toEqual({ step: 5, total: 10, etaMs: 2_000 });
    expect(summary?.etaMs).toBe(5_000);
  });

  it("사람이 읽는 짧은 시간으로 표시한다", () => {
    expect(formatDuration(null)).toBe("계산 중");
    expect(formatDuration(8_400)).toBe("8초");
    expect(formatDuration(125_000)).toBe("2분 5초");
  });
});
