// GPU·메모리 사용량 — 채팅 패널이 생성 중에 "왜 느린지" 를 보이게 한다 (VRAM 이 꽉 차 시스템
// 메모리로 넘치면 스텝이 수십 배 느려진다). nvidia-smi 는 비동기로 부른다 — 동기로 부르면 부를
// 때마다 메인 프로세스(=창)가 잠깐 멈춘다. 여러 창·패널이 동시에 물어도 한 번만 돌게 잠깐 캐시한다.
import { execFile } from 'node:child_process'
import os from 'node:os'

export interface GpuStats {
  name: string
  utilizationPct: number
  memoryUsedMB: number
  memoryTotalMB: number
  temperatureC: number | null
}

export interface SystemStats {
  /** NVIDIA GPU 가 없거나 nvidia-smi 가 없으면 null. */
  gpu: GpuStats | null
  ramUsedMB: number
  ramTotalMB: number
  at: number
}

/** `nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits` 의 첫 줄. */
export function parseNvidiaSmi(stdout: string): GpuStats | null {
  const line = stdout.trim().split(/\r?\n/)[0]
  if (!line) return null
  const [name, util, used, total, temp] = line.split(',').map((s) => s.trim())
  const num = (v: string | undefined) => (v !== undefined && /^\d+(\.\d+)?$/.test(v) ? Number(v) : null)
  if (!name || num(used) === null || num(total) === null) return null
  return { name, utilizationPct: num(util) ?? 0, memoryUsedMB: num(used)!, memoryTotalMB: num(total)!, temperatureC: num(temp) }
}

function queryGpu(): Promise<GpuStats | null> {
  return new Promise((resolve) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu', '--format=csv,noheader,nounits'],
      { timeout: 4000, windowsHide: true },
      (err, stdout) => resolve(err ? null : parseNvidiaSmi(String(stdout))),
    )
  })
}

const CACHE_MS = 1500
let last: SystemStats | null = null
let inflight: Promise<SystemStats> | null = null
// nvidia-smi 가 없는 PC 에서 매번 프로세스를 띄우지 않는다.
let gpuMissing = false

export function systemStats(): Promise<SystemStats> {
  if (last && Date.now() - last.at < CACHE_MS) return Promise.resolve(last)
  inflight ??= (async () => {
    const gpu = gpuMissing ? null : await queryGpu()
    if (!gpu && !last?.gpu) gpuMissing = true
    const total = os.totalmem(), free = os.freemem()
    last = { gpu, ramUsedMB: Math.round((total - free) / 1_048_576), ramTotalMB: Math.round(total / 1_048_576), at: Date.now() }
    return last
  })().finally(() => { inflight = null })
  return inflight
}
