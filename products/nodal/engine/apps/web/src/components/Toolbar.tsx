import type { RunStatus } from "../api/types";
import { formatDuration, summarizeRunProgress } from "../editor/progress";
import { useEditorStore } from "../state/editorStore";

interface ToolbarProps {
  mode: "mock" | "live";
  runStatus: RunStatus | null;
  submissionPending: boolean;
  fps: number | null;
  onRun: (useCache: boolean) => void;
  onSave: () => void;
  onLoad: () => void;
  onBenchmark: () => void;
}

export function Toolbar({
  mode,
  runStatus,
  submissionPending,
  fps,
  onRun,
  onSave,
  onLoad,
  onBenchmark,
}: ToolbarProps): React.JSX.Element {
  const busy = submissionPending || runStatus === "queued" || runStatus === "running";
  const canUndo = useEditorStore((state) => state.canUndo);
  const canRedo = useEditorStore((state) => state.canRedo);
  const undo = useEditorStore((state) => state.undo);
  const redo = useEditorStore((state) => state.redo);
  return (
    <header className="toolbar">
      <div className="brand">
        <span className="brand-mark">N</span>
        <span>
          <strong>nodal</strong>
          <small>local graph studio</small>
        </span>
      </div>
      <nav>
        <button type="button" onClick={onSave}>
          저장
        </button>
        <button type="button" onClick={onLoad}>
          불러오기
        </button>
        <button type="button" disabled={!canUndo} onClick={undo} title="Ctrl/⌘+Z">
          실행 취소
        </button>
        <button type="button" disabled={!canRedo} onClick={redo} title="Ctrl/⌘+Shift+Z">
          다시 실행
        </button>
        <button type="button" onClick={onBenchmark}>
          200 노드 측정
        </button>
        {fps !== null ? (
          <output className={fps >= 55 ? "fps good" : "fps warn"}>{fps} fps</output>
        ) : null}
      </nav>
      <div className="run-controls">
        <RunProgress runStatus={runStatus} />
        <span className={`api-mode ${mode}`}>{mode === "mock" ? "MOCK DATA" : "LIVE API"}</span>
        <button
          className="run-secondary"
          type="button"
          disabled={busy}
          onClick={() => onRun(false)}
        >
          캐시 없이
        </button>
        <button className="run-primary" type="button" disabled={busy} onClick={() => onRun(true)}>
          {submissionPending ? "요청 중…" : busy ? "실행 중…" : "▶ 실행"}
        </button>
      </div>
    </header>
  );
}

function RunProgress({ runStatus }: { runStatus: RunStatus | null }): React.JSX.Element | null {
  const runtime = useEditorStore((state) => state.runtime);
  const nodeCount = useEditorStore((state) => state.runNodeCount);
  const startedAtMs = useEditorStore((state) => state.runStartedAtMs);
  if (runStatus !== "running") return null;
  const summary = summarizeRunProgress(runtime, nodeCount, startedAtMs, Date.now());
  if (!summary) return <span className="run-progress-summary">실행 준비 중…</span>;
  const percent = Math.round(summary.fraction * 100);
  return (
    <div className="run-progress-summary" aria-label={`전체 진행률 ${percent}%`}>
      <span>
        전체 {summary.completed} / {summary.total} 노드 · {percent}%
      </span>
      {summary.activeStep ? (
        <small>
          스텝 {summary.activeStep.step} / {summary.activeStep.total} · 약{" "}
          {formatDuration(summary.activeStep.etaMs)} 남음
        </small>
      ) : (
        <small>전체 남은 시간 {formatDuration(summary.etaMs)}</small>
      )}
      <i>
        <b style={{ width: `${percent}%` }} />
      </i>
    </div>
  );
}
