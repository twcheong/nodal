import { afterEach, describe, expect, it, vi } from "vitest";

import { HttpGraphApiClient } from "./client";

describe("PNG 워크플로 복원 요청", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("파일을 multipart로 보내고 Content-Type 경계는 브라우저에 맡긴다", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Promise.resolve(
        new Response(JSON.stringify({ graph: { nodal_version: "1" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpGraphApiClient("https://nodal.test");
    const file = new File([new Uint8Array([137, 80, 78, 71])], "workflow.png", {
      type: "image/png",
    });

    await client.graphFromPng(file);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://nodal.test/api/graph/from-png");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeInstanceOf(FormData);
    expect(new Headers(init?.headers).has("Content-Type")).toBe(false);
    expect((init?.body as FormData).get("file")).toBe(file);
    expect(client.assetUrl({ hash: "abc", media_type: "image/png", size_bytes: 1 })).toBe(
      "https://nodal.test/api/assets/abc",
    );
  });
});

describe("확장 카탈로그 요청", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("생성 계약의 GET /api/extensions 응답을 그대로 읽는다", async () => {
    const body = { loaded: [], failed: [] };
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await new HttpGraphApiClient("https://nodal.test").listExtensions();

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://nodal.test/api/extensions");
    expect(response).toEqual(body);
  });
});
