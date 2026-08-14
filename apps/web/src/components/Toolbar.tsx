import type { RunStatus } from "../api/types";

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
        <button type="button" onClick={onBenchmark}>
          200 노드 측정
        </button>
        {fps !== null ? (
          <output className={fps >= 55 ? "fps good" : "fps warn"}>{fps} fps</output>
        ) : null}
      </nav>
      <div className="run-controls">
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
