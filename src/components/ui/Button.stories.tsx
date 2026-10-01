import type { Meta, StoryObj } from '@storybook/react-vite'
import { Button } from './Button'

const meta: Meta<typeof Button> = {
  title: 'Atoms/Button',
  component: Button,
  parameters: {
    docs: {
      description: {
        component:
          '기본 버튼. variant 7종(primary/secondary/ghost/danger/success/outline/dashed) × size 2종(sm/md). loading이면 스피너 표시 + 비활성화. 네이티브 button props 전부 패스스루.',
      },
    },
  },
  args: { children: 'Button', variant: 'secondary', size: 'md' },
}
export default meta
type Story = StoryObj<typeof Button>

export const Default: Story = {}

export const Matrix: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {(['primary', 'secondary', 'ghost', 'danger', 'success', 'outline', 'dashed'] as const).map((variant) => (
        <div key={variant} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <code style={{ width: 90, fontSize: 11, color: 'var(--text-muted)' }}>{variant}</code>
          <Button variant={variant} size="md">
            Save
          </Button>
          <Button variant={variant} size="sm">
            Save
          </Button>
          <Button variant={variant} size="md" loading>
            Saving
          </Button>
          <Button variant={variant} size="md" disabled>
            Disabled
          </Button>
        </div>
      ))}
    </div>
  ),
}
