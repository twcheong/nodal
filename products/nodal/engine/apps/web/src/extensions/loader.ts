import type { ExtensionInfo, ExtensionsResponse } from "../api/types";

export interface ExtensionFailure {
  extension: ExtensionInfo;
  source: "backend" | "frontend";
  reason: string;
}

export type ExtensionModuleImporter = (url: string) => Promise<unknown>;

/**
 * 서버가 준 완성 URL을 그대로 ESM으로 평가한다.
 *
 * Vite가 런타임 문자열을 번들 경로로 해석하지 않도록 `vite-ignore`를 붙인다.
 * URL 조립 규칙은 서버 한 곳에만 있고, 이 함수는 받은 문자열을 바꾸지 않는다.
 */
export function importExtensionModule(url: string): Promise<unknown> {
  return import(/* @vite-ignore */ url) as Promise<unknown>;
}

/**
 * 백엔드 로드 실패와 브라우저 ESM 평가 실패를 한 목록으로 모은다.
 *
 * `web_entry_url`이 없는 확장은 백엔드 노드만 가진 정상 확장이다. import를
 * 시도하지 않으며 실패로도 기록하지 않는다. 각 import를 독립적으로 기다리므로
 * 한 모듈이 실패해도 다른 모듈과 캔버스는 계속 동작한다.
 */
export async function loadFrontendExtensions(
  response: ExtensionsResponse,
  importer: ExtensionModuleImporter = importExtensionModule,
): Promise<ExtensionFailure[]> {
  const failures: ExtensionFailure[] = (response.failed ?? []).map((extension) => ({
    extension,
    source: "backend",
    reason: extension.error ?? "백엔드가 확장을 불러오지 못했습니다",
  }));

  const webExtensions = (response.loaded ?? []).filter(
    (extension): extension is ExtensionInfo & { web_entry_url: string } =>
      typeof extension.web_entry_url === "string" && extension.web_entry_url.length > 0,
  );
  const frontendResults = await Promise.all(
    webExtensions.map(async (extension): Promise<ExtensionFailure | null> => {
      try {
        await importer(extension.web_entry_url);
        return null;
      } catch (error) {
        return {
          extension,
          source: "frontend",
          reason: readError(error),
        };
      }
    }),
  );

  return [...failures, ...frontendResults.filter((failure) => failure !== null)];
}

function readError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
