// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { formatStats } from './SystemStatsBar'

describe('formatStats', () => {
  const base = { ramUsedMB: 40 * 1024, ramTotalMB: 64 * 1024, at: 0 }
  it('shows GPU, VRAM, temperature and RAM on one line', () => {
    const { text, vramFull } = formatStats({ ...base, gpu: { name: 'x', utilizationPct: 42, memoryUsedMB: 8192, memoryTotalMB: 16384, temperatureC: 60 } })
    expect(text).toBe('GPU 42% · VRAM 8.0/16.0 GB · 60°C · RAM 40.0/64.0 GB')
    expect(vramFull).toBe(false)
  })

  it('flags VRAM that is nearly full (it spills to system memory and slows down)', () => {
    expect(formatStats({ ...base, gpu: { name: 'x', utilizationPct: 99, memoryUsedMB: 15600, memoryTotalMB: 16303, temperatureC: null } }).vramFull).toBe(true)
  })

  it('works without an NVIDIA GPU', () => {
    expect(formatStats({ ...base, gpu: null }).text).toBe('GPU 정보 없음 · RAM 40.0/64.0 GB')
  })
})
