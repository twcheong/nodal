// Nodal 엔진 접속 정보 — 한 곳에서만 정한다.
//
// profile.ts(에이전트의 MCP 주소)와 electron/(엔진 기동·REST 호출)이 둘 다 여기서 읽는다.
// 전에는 MCP 주소는 profile 에 하드코딩, REST 주소는 NODAL_ENGINE_URL env 로 따로 바뀌어
// 둘이 서로 다른 엔진을 가리킬 수 있었다.
//
// 순수 데이터 — profile.ts 가 import 하므로 node/DOM import 금지.

/** 엔진(nodal serve)이 듣는 루프백 포트. 엔진의 기본값과 같다. */
export const ENGINE_PORT = 8188

export const ENGINE_URL = `http://127.0.0.1:${ENGINE_PORT}`

/** 에이전트(openclaw)가 붙는 MCP 엔드포인트 — Streamable HTTP. */
export const ENGINE_MCP_URL = `${ENGINE_URL}/mcp`

/** 사용자 템플릿 폴더에 처음 한 번 심는 번들 템플릿에서 뺄 것 (실험용 — 특정 캐릭터에 맞춘 비교 템플릿). */
export const EXCLUDED_BUNDLED_TEMPLATES = /^h3_compare_/
