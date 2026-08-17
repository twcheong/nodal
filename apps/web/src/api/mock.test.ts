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
  it("provider 이름과 같은 kind의 체크포인트를 제공한다", async () => {
    const client = new MockGraphApiClient();
    const nodes = await client.listNodes();
    const models = await client.listModels();
    const checkpoint = nodes.nodes.find((node) => node.id === "diffusion.LoadCheckpoint");
    expect(checkpoint?.inputs?.[0]?.widget?.provider).toBe("checkpoints");
    expect(models.models?.filter((model) => model.kind === "checkpoints")).toHaveLength(2);
  });
});
