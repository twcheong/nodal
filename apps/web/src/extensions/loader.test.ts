import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExtensionsResponse } from "../api/types";
import { ExtensionBanner } from "../components/ExtensionBanner";
import { importExtensionModule, loadFrontendExtensions } from "./loader";

const GOOD_EXTENSION = {
  id: "com.example.good",
  name: "Good Pack",
  version: "0.1.0",
  nodal_api: "^0.1",
  loaded: true,
  node_count: 1,
  error: null,
  web_entry_url: "/server-supplied/good/index.js",
} as const;

const BROKEN_EXTENSION = {
  id: "com.example.broken",
  name: "Broken Pack",
  version: "0.1.0",
  nodal_api: "^1.0",
  loaded: false,
  node_count: 0,
  error: "nodal_api 범위 불일치: ^1.0",
  web_entry_url: null,
} as const;

describe("M7.3 프론트 확장 ESM", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__nodalM73Widget;
  });

  it("실제 ESM을 동적으로 평가해 정상 확장의 위젯 등록 부수효과를 실행한다", async () => {
    const source = "globalThis.__nodalM73Widget = 'Good Pack widget'; export {};";
    const url = `data:text/javascript,${encodeURIComponent(source)}`;

    await importExtensionModule(url);

    expect((globalThis as Record<string, unknown>).__nodalM73Widget).toBe("Good Pack widget");
  });

  it("M7.2 정상·깨진 확장을 함께 처리하고 깨진 사유를 같은 배너에 보인다", async () => {
    const response: ExtensionsResponse = {
      loaded: [
        GOOD_EXTENSION,
        {
          ...GOOD_EXTENSION,
          id: "com.example.backend-only",
          name: "Backend Only",
          web_entry_url: null,
        },
      ],
      failed: [BROKEN_EXTENSION],
    };
    const importer = vi.fn((url: string) => {
      expect(url).toBe(GOOD_EXTENSION.web_entry_url);
      (globalThis as Record<string, unknown>).__nodalM73Widget = "Good Pack widget";
      return Promise.resolve();
    });

    const failures = await loadFrontendExtensions(response, importer);
    const banner = renderToStaticMarkup(createElement(ExtensionBanner, { failures }));

    expect(importer).toHaveBeenCalledTimes(1);
    expect((globalThis as Record<string, unknown>).__nodalM73Widget).toBe("Good Pack widget");
    expect(banner).toContain("Broken Pack");
    expect(banner).toContain("com.example.broken");
    expect(banner).toContain("nodal_api 범위 불일치: ^1.0");
    expect(banner).not.toContain("Backend Only");
  });

  it("프론트 모듈 하나가 실패해도 다른 모듈을 로드하고 같은 배너에 합친다", async () => {
    const frontendBroken = {
      ...GOOD_EXTENSION,
      id: "com.example.frontend-broken",
      name: "Frontend Broken",
      web_entry_url: "/server-supplied/broken/index.js",
    };
    const importer = vi.fn((url: string) => {
      if (url === frontendBroken.web_entry_url)
        return Promise.reject(new Error("Unexpected token"));
      (globalThis as Record<string, unknown>).__nodalM73Widget = "Good Pack widget";
      return Promise.resolve();
    });

    const failures = await loadFrontendExtensions(
      { loaded: [GOOD_EXTENSION, frontendBroken], failed: [BROKEN_EXTENSION] },
      importer,
    );
    const banner = renderToStaticMarkup(createElement(ExtensionBanner, { failures }));

    expect(importer).toHaveBeenCalledTimes(2);
    expect((globalThis as Record<string, unknown>).__nodalM73Widget).toBe("Good Pack widget");
    expect(banner).toContain("nodal_api 범위 불일치: ^1.0");
    expect(banner).toContain("Unexpected token");
  });
});
