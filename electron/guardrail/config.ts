import fs from 'fs'
import path from 'path'
import os from 'os'
import { PRODUCT } from '../../shared/product/current.generated'

export type GuardrailMode = 'bypass' | 'standard' | 'strict'

export interface GuardrailAllowlist {
  write: string[]
  edit:  string[]
  bash:  string[]
}

export interface GuardrailConfig {
  mode:      GuardrailMode
  allowlist: GuardrailAllowlist
}

// Twixy-specific config lives in its own file so it doesn't trip
// OpenClaw's strict root-key validator (it rejects unknown top-level
// keys in openclaw.json).
const CONFIG_PATH = path.join(os.homedir(), PRODUCT.stateDirName, `${PRODUCT.stateFilePrefix}-guardrail.json`)

// String-aware comment / trailing-comma stripper. The previous naïve
// regex ate `//` inside string values (e.g. the `https://` in URLs),
// breaking JSON.parse. Walk the text char-by-char, only stripping
// comments when we're outside a string literal.
function stripCommentsAndTrailingCommas(raw: string): string {
  let out = ''
  let i = 0
  let inString = false
  let stringChar = ''
  while (i < raw.length) {
    const c = raw[i]
    const next = raw[i + 1]
    if (inString) {
      out += c
      if (c === '\\' && next !== undefined) { out += next; i += 2; continue }
      if (c === stringChar) inString = false
      i += 1
      continue
    }
    if (c === '"' || c === "'") { inString = true; stringChar = c; out += c; i += 1; continue }
    if (c === '/' && next === '/') {
      while (i < raw.length && raw[i] !== '\n') i += 1
      continue
    }
    if (c === '/' && next === '*') {
      i += 2
      while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    out += c
    i += 1
  }
  return out.replace(/,(\s*[}\]])/g, '$1')
}

const DEFAULT_CONFIG: GuardrailConfig = {
  mode: 'bypass',
  allowlist: { write: [], edit: [], bash: [] },
}

function normalizeMode(raw: unknown): GuardrailMode {
  return raw === 'standard' || raw === 'strict' ? raw : 'bypass'
}

function normalizeStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
}

export function loadGuardrailConfig(): GuardrailConfig {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8')
    const parsed = JSON.parse(stripCommentsAndTrailingCommas(raw))
    return {
      mode: normalizeMode(parsed?.mode),
      allowlist: {
        write: normalizeStringArray(parsed?.allowlist?.write),
        edit:  normalizeStringArray(parsed?.allowlist?.edit),
        bash:  normalizeStringArray(parsed?.allowlist?.bash),
      },
    }
  } catch {
    return { ...DEFAULT_CONFIG, allowlist: { write: [], edit: [], bash: [] } }
  }
}

export function saveGuardrailConfig(cfg: GuardrailConfig): { ok: boolean; error?: string } {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
    const next: GuardrailConfig = {
      mode: normalizeMode(cfg.mode),
      allowlist: {
        write: normalizeStringArray(cfg.allowlist?.write),
        edit:  normalizeStringArray(cfg.allowlist?.edit),
        bash:  normalizeStringArray(cfg.allowlist?.bash),
      },
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2))
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

export function serializeForEnv(cfg: GuardrailConfig): Record<string, string> {
  return {
    TWIXY_GUARDRAIL_MODE: cfg.mode,
    TWIXY_GUARDRAIL_ALLOWLIST: JSON.stringify(cfg.allowlist),
  }
}
