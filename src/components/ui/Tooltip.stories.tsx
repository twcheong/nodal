import type { Meta, StoryObj } from '@storybook/react-vite'
import { Tooltip, TipBody } from './Tooltip'
import { Button } from './Button'

const meta: Meta<typeof Tooltip> = {
  title: 'Atoms/Tooltip',
  component: Tooltip,
  parameters: {
    docs: {
      description: {
        component:
          'portal(position:fixed) 툴팁 — 캔버스 줌·overflow의 영향 없이 항상 위에 뜬다. 기존 Tooltip/HoverTip 통합본. content에 문자열 또는 TipBody 같은 노드.',
      },
    },
  },
}
export default meta
type Story = StoryObj<typeof Tooltip>

export const Sides: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 24, padding: 60 }}>
      <Tooltip content="Shown above" side="top">
        <Button>top</Button>
      </Tooltip>
      <Tooltip content="Shown below" side="bottom">
        <Button>bottom</Button>
      </Tooltip>
      <Tooltip content="Shown right" side="right">
        <Button>right</Button>
      </Tooltip>
    </div>
  ),
}

export const WithTipBody: Story = {
  render: () => (
    <div style={{ padding: 60 }}>
      <Tooltip
        side="bottom"
        align="start"
        content={<TipBody heading="Output" lines={['posts: 12 items', 'format: markdown']} accent="var(--success)" />}
      >
        <Button variant="ghost">Node info</Button>
      </Tooltip>
    </div>
  ),
}
