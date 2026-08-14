import type {
  CreateRunResponse,
  ErrorResponse,
  NodesResponse,
  ValidateResponse,
  WsEvent,
} from "./types";
import { API_PATHS } from "./types";
import type { GraphDocument } from "../graph/types";

export type EventListener = (event: WsEvent) => void;

export interface GraphApiClient {
  readonly mode: "mock" | "live";
  listNodes(): Promise<NodesResponse>;
  validateGraph(graph: GraphDocument): Promise<ValidateResponse>;
  createRun(graph: GraphDocument, useCache: boolean): Promise<CreateRunResponse>;
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

  listNodes(): Promise<NodesResponse> {
    return this.#request<NodesResponse>(API_PATHS.nodes);
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
    const response = await fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
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
