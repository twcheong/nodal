import type {
  AssetRef,
  CreateRunResponse,
  ErrorResponse,
  GraphFromPngResponse,
  NodesResponse,
  ExtensionsResponse,
  ValidateResponse,
  WsEvent,
} from "./types";
import { API_PATHS, assetSrc } from "./types";
import type { GraphDocument } from "../graph/types";

export type EventListener = (event: WsEvent) => void;

export interface GraphApiClient {
  readonly mode: "mock" | "live";
  assetUrl(asset: AssetRef): string;
  listNodes(): Promise<NodesResponse>;
  listExtensions(): Promise<ExtensionsResponse>;
  validateGraph(graph: GraphDocument): Promise<ValidateResponse>;
  createRun(graph: GraphDocument, useCache: boolean): Promise<CreateRunResponse>;
  graphFromPng(file: File): Promise<GraphFromPngResponse>;
  subscribe(listener: EventListener): () => void;
  dispose(): void;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly response?: ErrorResponse,
  ) {
    super(message);
  }
}

export class HttpGraphApiClient implements GraphApiClient {
  readonly mode = "live" as const;
  readonly #listeners = new Set<EventListener>();
  readonly #baseUrl: string;
  #socket: WebSocket | null = null;

  constructor(baseUrl = "") {
    this.#baseUrl = baseUrl.replace(/\/$/, "");
  }

  assetUrl(asset: AssetRef): string {
    return `${this.#baseUrl}${assetSrc(asset)}`;
  }

  listNodes(): Promise<NodesResponse> {
    return this.#request<NodesResponse>(API_PATHS.nodes);
  }

  listExtensions(): Promise<ExtensionsResponse> {
    return this.#request<ExtensionsResponse>(API_PATHS.extensions);
  }

  validateGraph(graph: GraphDocument): Promise<ValidateResponse> {
    return this.#request<ValidateResponse>(API_PATHS.validate, {
      method: "POST",
      body: JSON.stringify({ graph }),
    });
  }

  createRun(graph: GraphDocument, useCache: boolean): Promise<CreateRunResponse> {
    return this.#request<CreateRunResponse>(API_PATHS.runs, {
      method: "POST",
      body: JSON.stringify({ graph, use_cache: useCache }),
    });
  }

  graphFromPng(file: File): Promise<GraphFromPngResponse> {
    const body = new FormData();
    body.append("file", file);
    return this.#request<GraphFromPngResponse>(API_PATHS.graphFromPng, {
      method: "POST",
      body,
    });
  }

  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener);
    this.#ensureSocket();
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    this.#socket?.close();
    this.#socket = null;
    this.#listeners.clear();
  }

  async #request<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers);
    if (init?.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const response = await fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers,
    });
    if (!response.ok) {
      const error = (await response.json().catch(() => undefined)) as ErrorResponse | undefined;
      throw new ApiError(error?.error.message ?? response.statusText, response.status, error);
    }
    return (await response.json()) as T;
  }

  #ensureSocket(): void {
    if (this.#socket || typeof window === "undefined") return;
    const base = this.#baseUrl || window.location.origin;
    const url = new URL(API_PATHS.ws, base);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    this.#socket = new WebSocket(url);
    this.#socket.addEventListener("message", (message) => {
      const event = JSON.parse(String(message.data)) as WsEvent;
      this.#listeners.forEach((listener) => listener(event));
    });
    this.#socket.addEventListener("close", () => {
      this.#socket = null;
    });
  }
}
