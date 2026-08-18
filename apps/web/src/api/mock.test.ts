import { describe, expect, it } from "vitest";

import { MOCK_IMAGE_HASH, MockGraphApiClient } from "./mock";

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

describe("목 PNG 워크플로 복원", () => {
  it("PNG를 이미지 출력 노드가 있는 그래프로 복원한다", async () => {
    const client = new MockGraphApiClient();
    const response = await client.graphFromPng(
      new File([PNG_SIGNATURE], "workflow.png", { type: "image/png" }),
    );

    expect(Object.values(response.graph.nodes ?? {})[0]?.type).toBe("image.MockPreview");
    expect(
      client.assetUrl({
        hash: MOCK_IMAGE_HASH,
        media_type: "image/svg+xml",
        size_bytes: 1,
      }),
    ).toMatch(/^data:image\/svg\+xml/);
  });

  it("손상된 PNG와 워크플로 없는 PNG를 구분한다", async () => {
    const client = new MockGraphApiClient();
    await expect(
      client.graphFromPng(new File(["broken"], "broken.png", { type: "image/png" })),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      client.graphFromPng(new File([PNG_SIGNATURE], "no-workflow.png", { type: "image/png" })),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("M4 목 카탈로그", () => {
  it("공급자 콤보에 옵션을 함께 실어 보낸다", async () => {
    // 모델 목록은 `/api/nodes` 의 `widget.options` 로만 온다. 목이 `provider`
    // 만 주고 `options` 를 빼면 실서버와 다른 모양이 되어, 목에서 본 UI 가
    // 실제와 다르다.
    const client = new MockGraphApiClient();
    const nodes = await client.listNodes();
    const checkpoint = nodes.nodes.find((node) => node.id === "diffusion.LoadCheckpoint");
    const ckpt = checkpoint?.inputs?.[0];
    expect(ckpt?.widget?.provider).toBe("checkpoints");
    expect(ckpt?.widget?.options).toEqual(["sdxl-demo.safetensors", "tiny-sd-pipe"]);
  });
});
