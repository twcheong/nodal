import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Zap } from 'lucide-react'
import { Chip } from './Chip'

const meta: Meta<typeof Chip> = {
  title: 'Atoms/Chip',
  component: Chip,
  parameters: {
    docs: {
      description: {
        component:
          '클릭 가능한 pill. 모드 선택(⚡ Simple/◇ Workflow), 태그 필터, 상태 컨트롤(▶ Start/■ Stop) 흡수용 — Inventory 클러스터 7·10(틴트)·16 대체.',
      },
    },
  },
}
export default meta
type Story = StoryObj<typeof Chip>

export const ModeSelect: Story = {
  render: function Render() {
    const [mode, setMode] = useState('simple')
    return (
      <div style={{ display: 'flex', gap: 6 }}>
        <Chip active={mode === 'simple'} onClick={() => setMode('simple')}>
          <Zap size={11} /> Simple
        </Chip>
        <Chip active={mode === 'workflow'} onClick={() => setMode('workflow')}>
          ◇ Workflow
        </Chip>
      </div>
    )
  },
}

export const Tones: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      <Chip tone="neutral" active>neutral</Chip>
      <Chip tone="accent" active>accent</Chip>
      <Chip tone="success" active>▶ Start</Chip>
      <Chip tone="danger" active>■ Stop</Chip>
      <Chip tone="warning" active>⟲ Resume</Chip>
      <Chip tone="info" active>info</Chip>
      <Chip>inactive</Chip>
      <Chip disabled>disabled</Chip>
    </div>
  ),
}
