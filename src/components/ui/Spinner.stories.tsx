import type { Meta, StoryObj } from '@storybook/react-vite'
import { Spinner } from './Spinner'

const meta: Meta<typeof Spinner> = {
  title: 'Atoms/Spinner',
  component: Spinner,
  parameters: {
    docs: {
      description: { component: '로딩 스피너. size = 지름(px).' },
    },
  },
}
export default meta
type Story = StoryObj<typeof Spinner>

export const Sizes: Story = {
  render: () => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
      <Spinner size={12} />
      <Spinner size={16} />
      <Spinner size={24} />
    </div>
  ),
}
