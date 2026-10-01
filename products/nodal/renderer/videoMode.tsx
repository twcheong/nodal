// Nodal 의 채팅 모드 — 코어의 등록 자리(src/lib/copilotModes.ts)에 끼운다.
import { Clapperboard } from 'lucide-react'
import { registerCopilotMode } from '../../../src/lib/copilotModes'
import { VideoPanel } from './VideoPanel'

export function registerVideoMode(): void {
  registerCopilotMode({
    id: 'video',
    label: '만들기',
    icon: <Clapperboard size={11} />,
    title: '이 PC 의 Nodal 엔진으로 이미지와 짧은 영상을 만듭니다',
    hint: '이미지 · 짧은 영상 — 이 PC 에서 생성',
    placeholder: '만들고 싶은 장면을 설명해 주세요…  (이미지를 끌어다 놓거나 @ 로 첨부)',
    // 'main' — 툴을 가진 기본 에이전트. 어떤 툴을 갖는지는 profile.ts 의 features 가
    // 게이트웨이 정책으로 정한다 (nodal__* + 워크스페이스 파일). 시스템 프롬프트는
    // openclaw 가 워크스페이스의 SOUL.md (workspace-seed/) 를 직접 읽으므로 여기서
    // 붙이지 않는다.
    agentId: 'main',
    buildBody: ({ text, first, transcriptSeed, fileAttach }) =>
      `${first ? transcriptSeed : ''}${fileAttach}${text}`,
    SidePanel: VideoPanel,
  })
}
