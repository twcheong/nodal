import type { GraphApiClient } from "./client";
import { HttpGraphApiClient } from "./client";
import { MockGraphApiClient } from "./mock";

export function createGraphApiClient(): GraphApiClient {
  return import.meta.env.VITE_NODAL_API_MODE === "live"
    ? new HttpGraphApiClient(readEnv("VITE_NODAL_API_URL"))
    : new MockGraphApiClient();
}

function readEnv(key: string): string {
  const value: unknown = import.meta.env[key];
  return typeof value === "string" ? value : "";
}

export type { GraphApiClient } from "./client";
