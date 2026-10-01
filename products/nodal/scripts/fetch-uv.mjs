// uv(파이썬 패키지·런타임 관리자) 실행 파일을 받아 tmp/nodal-uv/ 에 둔다.
//
//   node products/nodal/scripts/fetch-uv.mjs            # 지금 이 PC 용 (dev)
//   node products/nodal/scripts/fetch-uv.mjs win-x64    # Windows 설치 파일용 (dist:nodal:win)
//
// 패키지 앱은 resources/nodal-engine/uv(.exe) 로 싣고(profile.packaging), dev 는 engineManager 가
// PATH 의 uv 가 없으면 tmp/nodal-uv/uv 를 쓴다. 버전을 고정하고 릴리스의 .sha256 으로 검증한다.
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const UV_VERSION = '0.12.18'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const OUT = path.join(ROOT, 'tmp', 'nodal-uv')

const TARGETS = {
  'win-x64':    { asset: 'uv-x86_64-pc-windows-msvc.zip', exe: 'uv.exe' },
  'win-arm64':  { asset: 'uv-aarch64-pc-windows-msvc.zip', exe: 'uv.exe' },
  'mac-arm64':  { asset: 'uv-aarch64-apple-darwin.tar.gz', exe: 'uv' },
  'mac-x64':    { asset: 'uv-x86_64-apple-darwin.tar.gz', exe: 'uv' },
}
const here = `${process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux'}-${os.arch()}`
const key = process.argv[2] ?? here
const target = TARGETS[key]
if (!target) {
  console.error(`[fetch-uv] 모르는 대상 "${key}" — ${Object.keys(TARGETS).join(', ')}`)
  process.exit(1)
}

const stamp = path.join(OUT, '.version')
if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === `${UV_VERSION} ${key}` && fs.existsSync(path.join(OUT, target.exe))) {
  console.log(`[fetch-uv] 이미 있음: uv ${UV_VERSION} (${key})`)
  process.exit(0)
}

const base = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${target.asset}`
const get = async (url) => {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`${url} → ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

const archive = await get(base)
const expected = (await get(`${base}.sha256`)).toString('utf8').trim().split(/\s+/)[0]
const actual = crypto.createHash('sha256').update(archive).digest('hex')
if (actual !== expected) {
  console.error(`[fetch-uv] sha256 불일치 — 받은 파일을 쓰지 않는다 (${actual} ≠ ${expected})`)
  process.exit(1)
}

fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })
const tmpArchive = path.join(OUT, target.asset)
fs.writeFileSync(tmpArchive, archive)
const unpack = path.join(OUT, 'unpack')
fs.mkdirSync(unpack)
// bsdtar 는 zip 도 푼다 (macOS · Windows 10+ 기본 tar).
execFileSync('tar', ['-xf', tmpArchive, '-C', unpack])
const found = (function find(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { const r = find(p); if (r) return r }
    else if (e.name === target.exe) return p
  }
  return null
})(unpack)
if (!found) { console.error('[fetch-uv] 압축 안에 uv 실행 파일이 없다'); process.exit(1) }
fs.copyFileSync(found, path.join(OUT, target.exe))
fs.chmodSync(path.join(OUT, target.exe), 0o755)
fs.rmSync(unpack, { recursive: true, force: true })
fs.rmSync(tmpArchive)
fs.writeFileSync(stamp, `${UV_VERSION} ${key}`)
console.log(`[fetch-uv] uv ${UV_VERSION} (${key}) → ${path.relative(ROOT, path.join(OUT, target.exe))}`)
