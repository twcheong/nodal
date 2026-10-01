import type { Meta, StoryObj } from '@storybook/react-vite'
import { MessageSquare, Pencil, Trash2 } from 'lucide-react'
import { MenuItem } from './MenuItem'

const meta: Meta<typeof MenuItem> = {
  title: 'Molecules/MenuItem',
  component: MenuItem,
  parameters: {
    docs: {
      description: {
        component:
          '컨텍스트 메뉴/드롭다운의 행 버튼 — DataPanel 우클릭 메뉴 등 흡수용 (Inventory 클러스터 11 대체).',
      },
    },
  },
}
export default meta
type Story = StoryObj<typeof MenuItem>

export const Menu: Story = {
  render: () => (
    <div
      style={{
        width: 200,
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        padding: 4,
      }}
    >
      <MenuItem icon={<MessageSquare size={14} />}>Ask about this</MenuItem>
      <MenuItem icon={<Pencil size={14} />}>Rename</MenuItem>
      <MenuItem icon={<Trash2 size={14} />} danger>
        Delete file
      </MenuItem>
    </div>
  ),
}
