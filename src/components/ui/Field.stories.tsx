// Input / Textarea / Select — tx-field 공통 스타일을 쓰는 폼 atom 3종
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Input } from './Input'
import { Textarea } from './Textarea'
import { Select } from './Select'

const meta: Meta = {
  title: 'Atoms/Field',
  parameters: {
    docs: {
      description: {
        component:
          'Input·Textarea·Select — tx-field 공통 스타일(배경 --bg-input, 포커스 시 --accent 보더). invalid로 에러 상태, size sm/md.',
      },
    },
  },
}
export default meta

export const Input_: StoryObj = {
  name: 'Input',
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: 280 }}>
      <Input placeholder="Default (md)" />
      <Input placeholder="Small (sm)" size="sm" />
      <Input placeholder="Invalid state" invalid />
      <Input placeholder="Disabled" disabled />
    </div>
  ),
}

export const Textarea_: StoryObj = {
  name: 'Textarea',
  render: () => (
    <div style={{ width: 280 }}>
      <Textarea placeholder="Write multiple lines…" rows={3} />
    </div>
  ),
}

export const Select_: StoryObj = {
  name: 'Select',
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: 280 }}>
      <Select defaultValue="b">
        <option value="a">Option A</option>
        <option value="b">Option B</option>
        <option value="c">Option C</option>
      </Select>
      <Select size="sm" disabled>
        <option>Disabled</option>
      </Select>
    </div>
  ),
}
