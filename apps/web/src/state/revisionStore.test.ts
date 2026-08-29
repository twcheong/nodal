import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { GraphDocument } from "../graph/types";
import {
  DebouncedRevisionWriter,
  GraphRevisionStore,
  LEGACY_GRAPH_STORAGE_KEY,
  migrateLegacyGraphRevision,
  type RevisionDirectory,
} from "./revisionStore";

const createdDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(createdDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("자동 저장 리비전", () => {
  it("디바운스한 캐논 그래프를 실제 .nodal.json 파일로 남기고 복구한다", async () => {
    const directory = await nodeDirectory();
    const store = new GraphRevisionStore(directory, {
      makeName: () => "0000000000001-acceptance.nodal.json",
    });
    const writer = new DebouncedRevisionWriter(store, 60_000);
    const graph = graphWithValue(7);

    writer.schedule(graph);
    const name = await writer.flush();

    expect(name).toBe("0000000000001-acceptance.nodal.json");
    const contents = await directory.read(name!);
    expect(JSON.parse(contents)).toEqual(graph);
    expect(await store.latest()).toEqual(graph);
  });

  it("최신 파일이 손상됐으면 이전 완료 리비전을 복구한다", async () => {
    const directory = await nodeDirectory();
    const names = ["0000000000001-good.nodal.json", "0000000000002-broken.nodal.json"];
    const store = new GraphRevisionStore(directory, { makeName: () => names.shift()! });
    const graph = graphWithValue(3);
    await store.save(graph);
    await directory.write(await store.save(graphWithValue(4)), "{broken");

    expect(await store.latest()).toEqual(graph);
  });

  it("보관 상한을 넘으면 가장 오래된 파일부터 지운다", async () => {
    const directory = await nodeDirectory();
    const names = [1, 2, 3].map((value) => `000000000000${value}-revision.nodal.json`);
    const store = new GraphRevisionStore(directory, {
      retention: 2,
      makeName: () => names.shift()!,
    });
    await store.save(graphWithValue(1));
    await store.save(graphWithValue(2));
    await store.save(graphWithValue(3));

    expect(await directory.list()).toEqual([
      "0000000000002-revision.nodal.json",
      "0000000000003-revision.nodal.json",
    ]);
  });

  it("기존 localStorage 그래프를 OPFS 리비전으로 쓴 뒤에만 키를 지운다", async () => {
    const directory = await nodeDirectory();
    const store = new GraphRevisionStore(directory, {
      makeName: () => "0000000000001-migrated.nodal.json",
    });
    const graph = graphWithValue(9);
    const values = new Map([[LEGACY_GRAPH_STORAGE_KEY, JSON.stringify(graph)]]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
    };

    expect(await migrateLegacyGraphRevision(store, storage)).toEqual(graph);
    expect(values.has(LEGACY_GRAPH_STORAGE_KEY)).toBe(false);
    expect(await store.latest()).toEqual(graph);
  });

  it("기존 값이 깨졌으면 삭제하지 않고 복구 후보에서도 제외한다", async () => {
    const directory = await nodeDirectory();
    const store = new GraphRevisionStore(directory);
    const values = new Map([[LEGACY_GRAPH_STORAGE_KEY, "{broken"]]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
    };

    expect(await migrateLegacyGraphRevision(store, storage)).toBeNull();
    expect(values.get(LEGACY_GRAPH_STORAGE_KEY)).toBe("{broken");
  });
});

async function nodeDirectory(): Promise<RevisionDirectory> {
  const path = await mkdtemp(join(tmpdir(), "nodal-revisions-"));
  createdDirectories.push(path);
  return {
    list: () => readdir(path),
    read: (name) => readFile(join(path, name), "utf8"),
    write: (name, contents) => writeFile(join(path, name), contents, "utf8"),
    remove: (name) => unlink(join(path, name)),
  };
}

function graphWithValue(value: number): GraphDocument {
  return {
    nodal_version: "1",
    id: "00000000-0000-4000-8000-000000000704",
    nodes: {
      "00000000-0000-4000-8000-000000000705": {
        type: "math.Const",
        inputs: { value },
      },
    },
    outputs: [],
    ui: { viewport: { x: 0, y: 0, zoom: 1 } },
  };
}
