import type { Meta, StoryObj } from '@storybook/react-vite'
import { Badge } from './Badge'

const meta: Meta<typeof Badge> = {
  title: 'Atoms/Badge',
  component: Badge,
  parameters: {
    docs: {
      description: {
        component:
          '상태/카운트 pill 배지. variant 6종 — 기존 코드에 흩어져 있던 상태색 hex들을 semantic 토큰으로 흡수하는 용도.',
      },
    },
  },
}
export default meta
type Story = StoryObj<typeof Badge>

export const All: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <Badge variant="neutral">Pending</Badge>
      <Badge variant="accent">Running</Badge>
      <Badge variant="success">Done</Badge>
      <Badge variant="danger">Failed</Badge>
      <Badge variant="warning">Warning</Badge>
      <Badge variant="info">Info</Badge>
    </div>
  ),
}
