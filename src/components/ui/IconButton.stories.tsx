import type { Meta, StoryObj } from '@storybook/react-vite'
import { Settings, X, Copy } from 'lucide-react'
import { IconButton } from './IconButton'

const meta: Meta<typeof IconButton> = {
  title: 'Atoms/IconButton',
  component: IconButton,
  parameters: {
    docs: {
      description: {
        component:
          '정사각 아이콘 버튼 (lucide-react 아이콘을 children으로). 접근성을 위해 aria-label 필수.',
      },
    },
  },
}
export default meta
type Story = StoryObj<typeof IconButton>

export const Default: Story = {
  render: () => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <IconButton aria-label="Settings" size="md">
        <Settings size={16} />
      </IconButton>
      <IconButton aria-label="Copy" size="sm">
        <Copy size={13} />
      </IconButton>
      <IconButton aria-label="Close" size="sm" disabled>
        <X size={13} />
      </IconButton>
    </div>
  ),
}
