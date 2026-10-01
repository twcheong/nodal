import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Toggle } from './Toggle'
import { Checkbox } from './Checkbox'

const meta: Meta = {
  title: 'Atoms/Toggle & Checkbox',
  parameters: {
    docs: {
      description: {
        component:
          'Toggle은 role="switch" 버튼(controlled: checked + onChange). Checkbox는 라벨 내장 네이티브 체크박스.',
      },
    },
  },
}
export default meta

export const Toggle_: StoryObj = {
  name: 'Toggle',
  render: function Render() {
    const [on, setOn] = useState(true)
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <Toggle checked={on} onChange={setOn} aria-label="Notifications" />
        <Toggle checked={false} onChange={() => {}} disabled aria-label="Disabled" />
      </div>
    )
  },
}

export const Checkbox_: StoryObj = {
  name: 'Checkbox',
  render: function Render() {
    const [checked, setChecked] = useState(true)
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Checkbox label="I agree" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
        <Checkbox label="Disabled item" disabled />
      </div>
    )
  },
}
