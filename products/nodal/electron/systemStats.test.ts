// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { parseNvidiaSmi } from './systemStats'

describe('parseNvidiaSmi', () => {
  it('reads the first GPU line', () => {
    expect(parseNvidiaSmi('NVIDIA GeForce RTX 5080, 99, 14846, 16303, 71\n')).toEqual({
      name: 'NVIDIA GeForce RTX 5080', utilizationPct: 99, memoryUsedMB: 14846, memoryTotalMB: 16303, temperatureC: 71,
    })
  })

  it('tolerates a missing temperature and rejects garbage', () => {
    expect(parseNvidiaSmi('GPU, 5, 100, 8000, [N/A]')?.temperatureC).toBeNull()
    expect(parseNvidiaSmi('')).toBeNull()
    expect(parseNvidiaSmi('NVIDIA-SMI has failed')).toBeNull()
  })
})
