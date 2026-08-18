import { describe, expect, it } from "vitest";

import type { NodeSchema } from "../api/types";
import type { GraphDocument } from "../graph/types";
import type { SeedWidget } from "../graph/widgets";
import {
  advanceGraphSeeds,
  nextSeedValue,
  readSeedControl,
  submittedSeedValues,
  withSeedControl,
} from "./seed";

const widget: SeedWidget = { seed: true, control: "fixed", min: 0, max: 9, step: 1 };
const schema: NodeSchema = {
  id: "diffusion.KSampler",
  title: "KSampler",
  category: "diffusion/sampling",
  aliases: [],
  version: "1",
  cacheable: true,
  output_node: false,
  doc: "",
  inputs: [
    {
      name: "seed",
      type: "INT",
      default: 0,
      required: false,
      lazy: false,
      doc: "",
      widget,
    },
  ],
  outputs: [],
};

function graph(seed = 4): GraphDocument {
  return {
    nodal_version: "1",
    nodes: { sampler: { type: schema.id, inputs: { seed } } },
    ui: { sampler: { pos: [20, 30] } },
  };
}

describe("시드 실행 후 전환", () => {
  it("고정은 유지하고 증가는 최대값 다음에 최소값으로 순환한다", () => {
    expect(nextSeedValue(4, "fixed", widget, 0.7)).toBe(4);
    expect(nextSeedValue(4, "increment", widget, 0.7)).toBe(5);
    expect(nextSeedValue(9, "increment", widget, 0.7)).toBe(0);
  });

  it("랜덤은 위젯 범위와 step을 따른다", () => {
    const stepped = { ...widget, min: 10, max: 18, step: 2 };
    expect(nextSeedValue(10, "randomize", stepped, 0)).toBe(10);
    expect(nextSeedValue(10, "randomize", stepped, 0.999)).toBe(18);
  });

  it("모드는 ui에 보존하고 노드 위치를 잃지 않는다", () => {
    const changed = withSeedControl(graph(), "sampler", "seed", "increment");
    expect(readSeedControl(changed, "sampler", "seed", "fixed")).toBe("increment");
    expect(changed.ui?.sampler).toMatchObject({ pos: [20, 30] });
  });

  it("실행에 제출한 값과 성공 뒤 준비할 값을 분리한다", () => {
    const before = withSeedControl(graph(7), "sampler", "seed", "increment");
    expect(submittedSeedValues(before, [schema])).toEqual({ sampler: { seed: 7 } });
    expect(advanceGraphSeeds(before, [schema]).nodes?.sampler?.inputs?.seed).toBe(8);
  });

  it("randomize는 주입한 난수로 테스트할 수 있다", () => {
    const before = withSeedControl(graph(2), "sampler", "seed", "randomize");
    expect(advanceGraphSeeds(before, [schema], () => 0.5).nodes?.sampler?.inputs?.seed).toBe(5);
  });
});
