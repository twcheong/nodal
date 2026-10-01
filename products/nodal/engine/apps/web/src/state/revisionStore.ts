import type { GraphDocument } from "../graph/types";
import { validateGraphDocument } from "../graph/schema";

export const REVISION_RETENTION = 20;
export const REVISION_DEBOUNCE_MS = 500;
export const LEGACY_GRAPH_STORAGE_KEY = "nodal.lastGraph";

export interface RevisionDirectory {
  list(): Promise<string[]>;
  read(name: string): Promise<string>;
  write(name: string, contents: string): Promise<void>;
  remove(name: string): Promise<void>;
}

export class GraphRevisionStore {
  readonly #directory: RevisionDirectory;
  readonly #retention: number;
  readonly #makeName: () => string;

  constructor(
    directory: RevisionDirectory,
    options: { retention?: number; makeName?: () => string } = {},
  ) {
    this.#directory = directory;
    this.#retention = options.retention ?? REVISION_RETENTION;
    this.#makeName = options.makeName ?? defaultRevisionName;
    if (!Number.isSafeInteger(this.#retention) || this.#retention < 1) {
      throw new Error("자동 저장 리비전 보관 수는 1 이상이어야 한다");
    }
  }

  async save(graph: GraphDocument): Promise<string> {
    const name = this.#makeName();
    if (!name.endsWith(".nodal.json")) throw new Error("리비전 파일은 .nodal.json 이어야 한다");
    await this.#directory.write(name, JSON.stringify(graph, null, 2));
    await this.#prune();
    return name;
  }

  /** 최신 파일이 크래시 중 깨졌다면 그보다 앞선 유효한 캐논 문서로 물러난다. */
  async latest(): Promise<GraphDocument | null> {
    const names = await this.#revisionNames();
    for (const name of names) {
      try {
        const parsed: unknown = JSON.parse(await this.#directory.read(name));
        const result = validateGraphDocument(parsed);
        if (result.valid) return result.document;
      } catch {
        // 손상된 한 파일 때문에 더 오래된 완료 리비전까지 잃지 않는다.
      }
    }
    return null;
  }

  async #prune(): Promise<void> {
    const names = await this.#revisionNames();
    await Promise.all(names.slice(this.#retention).map((name) => this.#directory.remove(name)));
  }

  async #revisionNames(): Promise<string[]> {
    return (await this.#directory.list())
      .filter((name) => name.endsWith(".nodal.json"))
      .sort((left, right) => right.localeCompare(left));
  }
}

export class DebouncedRevisionWriter {
  readonly #store: GraphRevisionStore;
  readonly #delayMs: number;
  readonly #onError: (error: unknown) => void;
  #timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  #pending: GraphDocument | null = null;

  constructor(
    store: GraphRevisionStore,
    delayMs = REVISION_DEBOUNCE_MS,
    onError: (error: unknown) => void = () => undefined,
  ) {
    this.#store = store;
    this.#delayMs = delayMs;
    this.#onError = onError;
  }

  schedule(graph: GraphDocument): void {
    this.#pending = structuredClone(graph);
    if (this.#timer !== null) globalThis.clearTimeout(this.#timer);
    this.#timer = globalThis.setTimeout(() => {
      this.#timer = null;
      void this.flush().catch(this.#onError);
    }, this.#delayMs);
  }

  async flush(): Promise<string | null> {
    if (this.#timer !== null) {
      globalThis.clearTimeout(this.#timer);
      this.#timer = null;
    }
    const graph = this.#pending;
    this.#pending = null;
    return graph ? this.#store.save(graph) : null;
  }

  dispose(): void {
    if (this.#timer !== null) globalThis.clearTimeout(this.#timer);
    this.#timer = null;
    this.#pending = null;
  }
}

interface LifecycleEventTarget {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

interface VisibilityEventTarget extends LifecycleEventTarget {
  readonly visibilityState: DocumentVisibilityState;
}

/**
 * 탭이 백그라운드로 가거나 문서가 내려가기 전에 대기 중인 리비전 쓰기를 시작한다.
 * OPFS 쓰기는 비동기이므로 브라우저/OS의 강제 종료까지 완료를 보장하지는 않는다.
 */
export function installRevisionFlushHandlers(
  writer: Pick<DebouncedRevisionWriter, "flush">,
  targets: { page: LifecycleEventTarget; visibility: VisibilityEventTarget },
  onError: (error: unknown) => void = () => undefined,
): () => void {
  const flush = () => {
    void writer.flush().catch(onError);
  };
  const flushWhenHidden = () => {
    if (targets.visibility.visibilityState === "hidden") flush();
  };

  targets.visibility.addEventListener("visibilitychange", flushWhenHidden);
  targets.page.addEventListener("pagehide", flush);
  return () => {
    targets.visibility.removeEventListener("visibilitychange", flushWhenHidden);
    targets.page.removeEventListener("pagehide", flush);
  };
}

export async function createBrowserRevisionStore(): Promise<GraphRevisionStore> {
  if (typeof navigator === "undefined" || typeof navigator.storage?.getDirectory !== "function") {
    throw new Error("이 브라우저는 OPFS 자동 저장을 지원하지 않습니다");
  }
  // 거부돼도 OPFS는 쓸 수 있다. persist는 브라우저의 자동 정리 가능성을 낮추는 요청이다.
  if (typeof navigator.storage.persist === "function") {
    await navigator.storage.persist().catch(() => false);
  }
  const root = await navigator.storage.getDirectory();
  const nodal = await root.getDirectoryHandle("nodal", { create: true });
  const revisions = await nodal.getDirectoryHandle("revisions", { create: true });
  return new GraphRevisionStore(new OpfsRevisionDirectory(revisions));
}

/**
 * M7.4 이전의 쓰기 전용 localStorage 사본을 OPFS로 한 번 옮긴다.
 *
 * OPFS 쓰기가 완료되기 전에는 키를 지우지 않는다. 깨진 값도 지우지 않아 사용자가
 * 개발자 도구에서 수동 복구할 여지를 남긴다. 반환값은 이번 시작에서 복구할 문서다.
 */
export async function migrateLegacyGraphRevision(
  store: GraphRevisionStore,
  storage: Pick<Storage, "getItem" | "removeItem"> = localStorage,
): Promise<GraphDocument | null> {
  try {
    const raw = storage.getItem(LEGACY_GRAPH_STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    const result = validateGraphDocument(parsed);
    if (!result.valid) return null;
    await store.save(result.document);
    storage.removeItem(LEGACY_GRAPH_STORAGE_KEY);
    return result.document;
  } catch {
    return null;
  }
}

class OpfsRevisionDirectory implements RevisionDirectory {
  readonly #directory: FileSystemDirectoryHandle;

  constructor(directory: FileSystemDirectoryHandle) {
    this.#directory = directory;
  }

  async list(): Promise<string[]> {
    const names: string[] = [];
    for await (const [name, handle] of this.#directory.entries()) {
      if (handle.kind === "file") names.push(name);
    }
    return names;
  }

  async read(name: string): Promise<string> {
    const handle = await this.#directory.getFileHandle(name);
    return (await handle.getFile()).text();
  }

  async write(name: string, contents: string): Promise<void> {
    const handle = await this.#directory.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(contents);
    await writable.close();
  }

  async remove(name: string): Promise<void> {
    await this.#directory.removeEntry(name);
  }
}

function defaultRevisionName(): string {
  return `${String(Date.now()).padStart(13, "0")}-${crypto.randomUUID()}.nodal.json`;
}
