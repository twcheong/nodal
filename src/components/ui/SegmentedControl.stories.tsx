import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { SegmentedControl } from './SegmentedControl'

const meta: Meta<typeof SegmentedControl> = {
  title: 'Molecules/SegmentedControl',
  component: SegmentedControl,
  parameters: {
    docs: {
      description: {
        component:
          '탭형 토글 — DataPanel의 Preview/Edit/Table/Raw 같은 뷰 전환 흡수용 (Inventory 클러스터 8 대체).',
      },
    },
  },
}
export default meta
type Story = StoryObj<typeof SegmentedControl>

export const Default: Story = {
  render: function Render() {
    const [view, setView] = useState('preview')
    return (
      <SegmentedControl
        value={view}
        onChange={setView}
        options={[
          { value: 'preview', label: 'Preview' },
          { value: 'edit', label: 'Edit' },
          { value: 'table', label: 'Table' },
          { value: 'raw', label: 'Raw' },
        ]}
      />
    )
  },
}
