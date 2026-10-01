import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { useState } from 'react'
import { lazyPanel } from './LazyPanel'

function Counter({ label }: { label: string }) {
  const [n, setN] = useState(0)
  return <button onClick={() => setN(n + 1)}>{label} {n}</button>
}

describe('lazyPanel', () => {
  it('does not load until rendered, then shows the panel with its props', async () => {
    const load = vi.fn(async () => Counter)
    const Panel = lazyPanel(load)
    expect(load).not.toHaveBeenCalled() // 정의만으로는 import() 가 시작되면 안 된다

    render(<Panel label="hits" />)
    expect(screen.getByRole('status')).toBeInTheDocument() // Suspense fallback = Spinner
    expect(await screen.findByText('hits 0')).toBeInTheDocument()
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('offers Retry when the chunk fails, and retry loads again without remounting siblings', async () => {
    // React 가 boundary 로 잡은 에러를 console.error 로도 찍는다 — 테스트 출력만 조용히.
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    const load = vi.fn<() => Promise<typeof Counter>>()
      .mockRejectedValueOnce(new Error('Failed to fetch dynamically imported module'))
      .mockResolvedValue(Counter)
    const Flaky = lazyPanel(load)
    const Stable = lazyPanel(async () => Counter)

    render(<><Stable label="kept" /><Flaky label="flaky" /></>)
    fireEvent.click(await screen.findByText('kept 0')) // 이미 마운트된 다른 패널에 상태를 만든다
    expect(await screen.findByText('Could not load this panel')).toBeInTheDocument()
    expect(screen.getByText('Failed to fetch dynamically imported module')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('flaky 0')).toBeInTheDocument()
    expect(load).toHaveBeenCalledTimes(2)
    expect(screen.getByText('kept 1')).toBeInTheDocument() // 재시도가 다른 패널 상태를 날리지 않는다
    quiet.mockRestore()
  })
})
