import type { NodeRuntimeState } from "./types";

const COMPLETED = new Set(["cached", "succeeded", "error"]);

export interface RunProgressSummary {
  completed: number;
  total: number;
  fraction: number;
  activeStep: { step: number; total: number; etaMs: number | null } | null;
  etaMs: number | null;
}

export function withNodeProgress(
  current: NodeRuntimeState | undefined,
  step: number,
  total: number,
  nowMs: number,
): NodeRuntimeState {
  const startedAtMs = current?.startedAtMs ?? nowMs;
  const previous = current?.progress;
  const previousAt = current?.progressUpdatedAtMs ?? startedAtMs;
  const stepDelta = previous ? step - previous.step : step;
  const elapsed = Math.max(0, nowMs - previousAt);
  const sample = stepDelta > 0 ? elapsed / stepDelta : null;
  const previousRate = current?.msPerStep;
  const msPerStep =
    sample === null
      ? previousRate
      : previousRate === undefined
        ? sample
        : previousRate * 0.7 + sample * 0.3;
  const etaMs = msPerStep === undefined ? null : Math.max(0, total - step) * msPerStep;
  return {
    ...current,
    status: "running",
    startedAtMs,
    progressUpdatedAtMs: nowMs,
    msPerStep,
    progress: { step, total, etaMs },
  };
}

export function summarizeRunProgress(
  runtime: Readonly<Record<string, NodeRuntimeState>>,
  total: number,
  startedAtMs: number | null,
  nowMs: number,
): RunProgressSummary | null {
  if (total <= 0) return null;
  let completed = 0;
  let fractional = 0;
  let activeStep: RunProgressSummary["activeStep"] = null;
  for (const state of Object.values(runtime)) {
    if (COMPLETED.has(state.status)) {
      completed += 1;
      continue;
    }
    if (state.status !== "running" || !state.progress || state.progress.total <= 0) continue;
    const progress = Math.min(1, Math.max(0, state.progress.step / state.progress.total));
    fractional += progress;
    activeStep = state.progress;
  }
  const fraction = Math.min(1, (completed + fractional) / total);
  const elapsed = startedAtMs === null ? 0 : Math.max(0, nowMs - startedAtMs);
  const etaMs = fraction > 0 && fraction < 1 ? (elapsed / fraction) * (1 - fraction) : null;
  return { completed, total, fraction, activeStep, etaMs };
}

export function formatDuration(milliseconds: number | null): string {
  if (milliseconds === null || !Number.isFinite(milliseconds)) return "계산 중";
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}분` : `${minutes}분 ${rest}초`;
}
