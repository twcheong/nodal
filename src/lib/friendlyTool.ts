// friendlyTool — ChatPanel.tsx 에 있던 것을 그대로 옮겼다. SidetabOverlay 가 이 함수 하나 때문에
// './ChatPanel' 을 import 해서 sidetab 창이 ChatPanel + dompurify 청크(82 KB)를 통째로 받고 있었다.
// 순수 함수라 컴포넌트 밖에 둔다. ChatPanel 은 기존 import 경로 호환용으로 재-export 한다.

// 툴 이름을 사용자 친화적 레이블로 변환. 원본 RPC ID(browser/web_fetch 등)를 그대로 노출하지 않음.
// 서브에이전트 호출이면 "Sub-agent:" 프리픽스 추가로 위임 여부를 시각적으로 구분.
export function friendlyTool(name: string, isSubagent: boolean): string {
  if (name === 'web_search' || name === 'tavily_search') return 'Searching the web'
  if (name === 'web_fetch'  || name === 'tavily_extract') return 'Reading page'
  if (name.startsWith('browser')) return isSubagent ? 'Sub-agent: controlling browser' : 'Controlling browser'
  if (name === 'exec' || name === 'bash') return isSubagent ? 'Sub-agent: running command' : 'Running command'
  if (name === 'apply_patch' || name === 'apply-patch') return isSubagent ? 'Sub-agent: editing files' : 'Editing files'
  if (name.startsWith('read'))  return isSubagent ? 'Sub-agent: reading file' : 'Reading file'
  if (name.startsWith('write')) return isSubagent ? 'Sub-agent: writing file' : 'Writing file'
  if (name.startsWith('search') || name.startsWith('grep')) return isSubagent ? 'Sub-agent: searching' : 'Searching'
  if (name.startsWith('canvas')) return isSubagent ? 'Sub-agent: building widget' : 'Building widget'
  if (name.startsWith('sessions') || name.startsWith('subagent')) return 'Delegating to sub-agent'
  return isSubagent ? `Sub-agent: ${name}` : name
}
