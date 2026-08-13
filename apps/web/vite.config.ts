import { fileURLToPath, URL } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const schemasDir = fileURLToPath(new URL("../../schemas", import.meta.url));
const typesJson = fileURLToPath(
  new URL("../../packages/core/src/nodal/types.json", import.meta.url),
);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // 캐논 그래프 스키마는 백엔드 pydantic 모델에서 생성된 산출물이다.
      // 프론트는 이것을 읽기만 한다 — 규칙을 두 번 쓰지 않는다.
      "@nodal/schemas": schemasDir,
      // 타입 시스템의 단일 소스. 백엔드(nodal.types)와 같은 파일을 읽는다.
      "@nodal/types": typesJson,
    },
  },
  server: {
    fs: {
      // 스키마가 앱 루트 밖(모노레포 루트/schemas)에 있다.
      allow: [fileURLToPath(new URL("../..", import.meta.url))],
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
