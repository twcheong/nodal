import { useCallback, useEffect, useMemo, useRef } from "react";
import { ReactFlowProvider } from "@xyflow/react";

import { createGraphApiClient } from "./api";
import { AssetUrlContext } from "./api/context";
import { GraphCanvas, type CanvasHandle } from "./components/GraphCanvas";
import { Inspector } from "./components/Inspector";
import { NodePalette } from "./components/NodePalette";
import { Toolbar } from "./components/Toolbar";
import { isPngFile } from "./editor/pngDrop";
import { validateGraphDocument } from "./graph/schema";
import { useEditorStore } from "./state/editorStore";

export function App(): React.JSX.Element {
  const api = useMemo(() => createGraphApiClient(), []);
  const fileInput = useRef<HTMLInputElement>(null);
  const canvas = useRef<CanvasHandle>(null);
  const graph = useEditorStore((state) => state.graph);
  const runStatus = useEditorStore((state) => state.runStatus);
  const runSubmissionPending = useEditorStore((state) => state.runSubmissionPending);
  const message = useEditorStore((state) => state.message);
  const fps = useEditorStore((state) => state.benchmarkFps);
  const setSchemas = useEditorStore((state) => state.setSchemas);
  const setCatalogError = useEditorStore((state) => state.setCatalogError);
  const loadGraph = useEditorStore((state) => state.loadGraph);
  const setIssues = useEditorStore((state) => state.setIssues);
  const beginRunSubmission = useEditorStore((state) => state.beginRunSubmission);
  const finishRunSubmission = useEditorStore((state) => state.finishRunSubmission);
  const startRun = useEditorStore((state) => state.startRun);
  const handleEvent = useEditorStore((state) => state.handleEvent);
  const setMessage = useEditorStore((state) => state.setMessage);

  useEffect(() => {
    let active = true;
    api
      .listNodes()
      .then((response) => {
        if (active) setSchemas(response.nodes ?? []);
      })
      .catch((error: unknown) => {
        if (active) setCatalogError(readError(error));
      });
    const unsubscribe = api.subscribe(handleEvent);
    return () => {
      active = false;
      unsubscribe();
      api.dispose();
    };
  }, [api, handleEvent, setCatalogError, setSchemas]);

  useEffect(() => {
    const timer = globalThis.setTimeout(() => {
      localStorage.setItem("nodal.lastGraph", JSON.stringify(graph));
    }, 300);
    return () => globalThis.clearTimeout(timer);
  }, [graph]);

  const save = () => {
    const blob = new Blob([JSON.stringify(graph, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `nodal-${graph.id ?? "graph"}.nodal.json`;
    link.click();
    URL.revokeObjectURL(url);
    setMessage("캐논 그래프를 저장했습니다");
  };

  const openGraph = async (file: File) => {
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const result = validateGraphDocument(parsed);
      if (!result.valid) {
        setMessage(`불러오기 실패: ${result.issues[0]?.location} ${result.issues[0]?.message}`);
        return;
      }
      const semantic = await api.validateGraph(result.document);
      if (!semantic.valid) {
        setIssues(semantic.issues ?? []);
        setMessage("연결 또는 소켓 문제를 먼저 고쳐주세요");
        return;
      }
      loadGraph(result.document);
    } catch (error) {
      setMessage(`불러오기 실패: ${readError(error)}`);
    }
  };

  const restoreGraphFromPng = useCallback(
    async (file: File) => {
      const response = await api.graphFromPng(file);
      const result = validateGraphDocument(response.graph);
      if (!result.valid) {
        const issue = result.issues[0];
        throw new Error(
          issue ? `${issue.location}: ${issue.message}` : "PNG의 워크플로 형식이 올바르지 않습니다",
        );
      }
      loadGraph(result.document);
    },
    [api, loadGraph],
  );
  const assetUrl = useCallback(
    (asset: Parameters<typeof api.assetUrl>[0]) => api.assetUrl(asset),
    [api],
  );

  const run = useCallback(
    async (useCache: boolean) => {
      if (!beginRunSubmission()) return;
      try {
        const validation = await api.validateGraph(graph);
        setIssues(validation.issues ?? []);
        if (!validation.valid) {
          setMessage("실행 전 검증에서 문제가 발견됐습니다");
          return;
        }
        const response = await api.createRun(graph, useCache);
        startRun(response.run_id);
      } catch (error) {
        setMessage(`실행 요청 실패: ${readError(error)}`);
      } finally {
        finishRunSubmission();
      }
    },
    [api, beginRunSubmission, finishRunSubmission, graph, setIssues, setMessage, startRun],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key !== "Enter") return;
      event.preventDefault();
      void run(!event.shiftKey);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [run]);

  return (
    <AssetUrlContext.Provider value={assetUrl}>
      <ReactFlowProvider>
        <main className="app-shell">
          <Toolbar
            mode={api.mode}
            runStatus={runStatus}
            submissionPending={runSubmissionPending}
            fps={fps}
            onRun={(useCache) => void run(useCache)}
            onSave={save}
            onLoad={() => fileInput.current?.click()}
            onBenchmark={() => void canvas.current?.benchmark()}
          />
          <div className="workspace">
            <NodePalette />
            <GraphCanvas ref={canvas} onPngDrop={restoreGraphFromPng} />
            <Inspector />
          </div>
          {message ? (
            <button className="toast" type="button" onClick={() => setMessage(null)}>
              {message}
              <span>×</span>
            </button>
          ) : null}
          <input
            ref={fileInput}
            hidden
            type="file"
            accept=".json,.nodal.json,.png,application/json,image/png"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                if (isPngFile(file)) void canvas.current?.restorePng(file);
                else void openGraph(file);
              }
              event.target.value = "";
            }}
          />
        </main>
      </ReactFlowProvider>
    </AssetUrlContext.Provider>
  );
}

function readError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
