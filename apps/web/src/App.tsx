import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";

import { createGraphApiClient } from "./api";
import { AssetUrlContext } from "./api/context";
import { createEventBuffer } from "./api/eventBuffer";
import { GraphCanvas, type CanvasHandle } from "./components/GraphCanvas";
import { ExtensionBanner } from "./components/ExtensionBanner";
import { Inspector } from "./components/Inspector";
import { NodePalette } from "./components/NodePalette";
import { Toolbar } from "./components/Toolbar";
import { isPngFile } from "./editor/pngDrop";
import { validateGraphDocument } from "./graph/schema";
import { loadFrontendExtensions, type ExtensionFailure } from "./extensions/loader";
import { useEditorStore } from "./state/editorStore";
import {
  createBrowserRevisionStore,
  DebouncedRevisionWriter,
  migrateLegacyGraphRevision,
} from "./state/revisionStore";

export function App(): React.JSX.Element {
  const api = useMemo(() => createGraphApiClient(), []);
  const fileInput = useRef<HTMLInputElement>(null);
  const canvas = useRef<CanvasHandle>(null);
  const revisionWriter = useRef<DebouncedRevisionWriter | null>(null);
  const lastScheduledRevision = useRef<string | null>(null);
  const [extensionFailures, setExtensionFailures] = useState<ExtensionFailure[]>([]);
  const [revisionReady, setRevisionReady] = useState(false);
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
  const undo = useEditorStore((state) => state.undo);
  const redo = useEditorStore((state) => state.redo);

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
    api
      .listExtensions()
      .then(loadFrontendExtensions)
      .then((failures) => {
        if (active) setExtensionFailures(failures);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setExtensionFailures([
          {
            extension: {
              id: "nodal.extensions",
              name: "확장 카탈로그",
              version: "",
              nodal_api: "",
              loaded: false,
              node_count: 0,
              error: readError(error),
              web_entry_url: null,
            },
            source: "frontend",
            reason: readError(error),
          },
        ]);
      });
    const eventBuffer = createEventBuffer(handleEvent);
    const unsubscribe = api.subscribe(eventBuffer.push);
    return () => {
      active = false;
      unsubscribe();
      eventBuffer.dispose();
      api.dispose();
    };
  }, [api, handleEvent, setCatalogError, setSchemas]);

  useEffect(() => {
    let active = true;
    const recoveryBaseline = JSON.stringify(useEditorStore.getState().graph);
    void createBrowserRevisionStore()
      .then(async (store) => {
        const migrated = await migrateLegacyGraphRevision(store);
        const recovered = migrated ?? (await store.latest());
        if (!active) return;
        if (recovered && JSON.stringify(useEditorStore.getState().graph) === recoveryBaseline) {
          lastScheduledRevision.current = JSON.stringify(recovered);
          loadGraph(recovered);
          setMessage("마지막으로 완료된 자동 저장 리비전을 복구했습니다");
        }
        revisionWriter.current = new DebouncedRevisionWriter(store, undefined, (error) => {
          if (active) setMessage(`자동 저장 실패: ${readError(error)}`);
        });
        setRevisionReady(true);
      })
      .catch((error: unknown) => {
        if (active) setMessage(`자동 저장을 사용할 수 없습니다: ${readError(error)}`);
      });
    return () => {
      active = false;
      revisionWriter.current?.dispose();
      revisionWriter.current = null;
    };
  }, [loadGraph, setMessage]);

  useEffect(() => {
    if (!revisionReady || !revisionWriter.current) return;
    const serialized = JSON.stringify(graph);
    if (serialized === lastScheduledRevision.current) return;
    lastScheduledRevision.current = serialized;
    revisionWriter.current.schedule(graph);
  }, [graph, revisionReady]);

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
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === "z") {
        if (isEditableTarget(event.target)) return;
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (key === "y" && !event.shiftKey) {
        if (isEditableTarget(event.target)) return;
        event.preventDefault();
        redo();
        return;
      }
      if (event.key !== "Enter") return;
      event.preventDefault();
      void run(!event.shiftKey);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [redo, run, undo]);

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
          <ExtensionBanner
            failures={extensionFailures}
            onDismiss={() => setExtensionFailures([])}
          />
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

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}
