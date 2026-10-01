/**
 * Twixy Design Tokens — tokens.css의 타입드 미러. (Paper/Petrol 테마)
 *
 * 인라인 스타일에서 자동완성/타입 안전하게 토큰을 쓰기 위한 레이어:
 *   style={{ background: t.bg.surface, borderRadius: t.radius.md }}
 *
 * tokens.css와의 동기화는 scripts/check-tokens.mjs가 검사한다 (npm run check:tokens).
 * legacy alias(--text, --radius, --bg, --green, --red, --yellow)는
 * 신규 코드 사용 금지이므로 여기에 미러링하지 않는다.
 */

export const t = {
  bg: {
    base: 'var(--bg-base)',
    surface: 'var(--bg-surface)',
    elevated: 'var(--bg-elevated)',
    hover: 'var(--bg-hover)',
    active: 'var(--bg-active)',
    input: 'var(--bg-input)',
  },
  border: {
    default: 'var(--border)',
    subtle: 'var(--border-subtle)',
  },
  text: {
    primary: 'var(--text-primary)',
    secondary: 'var(--text-secondary)',
    muted: 'var(--text-muted)',
    inverse: 'var(--text-inverse)',
  },
  accent: {
    default: 'var(--accent)',
    deep: 'var(--accent-deep)',
    dim: 'var(--accent-dim)',
    glow: 'var(--accent-glow)',
  },
  status: {
    success: 'var(--success)',
    successStrong: 'var(--success-strong)',
    danger: 'var(--danger)',
    dangerStrong: 'var(--danger-strong)',
    warning: 'var(--warning)',
    warningStrong: 'var(--warning-strong)',
    info: 'var(--info)',
    infoStrong: 'var(--info-strong)',
  },
  radius: {
    sm: 'var(--radius-sm)',
    md: 'var(--radius-md)',
    lg: 'var(--radius-lg)',
  },
  space: {
    1: 'var(--space-1)',
    2: 'var(--space-2)',
    3: 'var(--space-3)',
    4: 'var(--space-4)',
    6: 'var(--space-6)',
  },
  font: {
    sans: 'var(--font-sans)',
    serif: 'var(--font-serif)',
    mono: 'var(--font-mono)',
  },
} as const

/**
 * 토큰별 실제 값 (Storybook 토큰 문서 페이지의 스와치/스펙 렌더용).
 * primitives는 리브랜딩 시 tokens.css와 함께 갱신한다.
 */
export const rawValues: Record<string, string> = {
  // Tier 1: primitives
  '--paper': '#fafaf6',
  '--card-white': '#ffffff',
  '--place': '#eff4f1',
  '--mint': '#e4f0e9',
  '--hairline': '#d9e1da',
  '--soft-hairline': '#cfdbd3',
  '--ink-900': '#14201b',
  '--ink-600': '#4a594f',
  '--ink-400': '#8a968d',
  '--white': '#ffffff',
  '--petrol-500': '#0d5c50',
  '--petrol-700': '#093f37',
  '--clay-500': '#b5482f',
  '--clay-700': '#93391f',
  '--ochre-500': '#b07d18',
  '--ochre-700': '#8f6513',
  // Tier 2: semantic
  '--bg-base': 'var(--paper)',
  '--bg-surface': 'var(--card-white)',
  '--bg-elevated': 'var(--card-white)',
  '--bg-hover': 'var(--place)',
  '--bg-active': 'var(--mint)',
  '--bg-input': 'var(--place)',
  '--border': 'var(--hairline)',
  '--border-subtle': 'var(--hairline)',
  '--text-primary': 'var(--ink-900)',
  '--text-secondary': 'var(--ink-600)',
  '--text-muted': 'var(--ink-400)',
  '--text-inverse': 'var(--white)',
  '--accent': 'var(--petrol-500)',
  '--accent-deep': 'var(--petrol-700)',
  '--accent-dim': 'var(--mint)',
  '--accent-glow': 'rgba(13, 92, 80, 0.10)',
  '--success': 'var(--petrol-500)',
  '--success-strong': 'var(--petrol-700)',
  '--danger': 'var(--clay-500)',
  '--danger-strong': 'var(--clay-700)',
  '--warning': 'var(--ochre-500)',
  '--warning-strong': 'var(--ochre-700)',
  '--info': 'var(--petrol-500)',
  '--info-strong': 'var(--petrol-700)',
  '--radius-sm': '8px',
  '--radius-md': '12px',
  '--radius-lg': '16px',
  '--space-1': '4px',
  '--space-2': '8px',
  '--space-3': '12px',
  '--space-4': '16px',
  '--space-6': '24px',
  '--font-sans': "'Pretendard Variable', 'Pretendard', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  '--font-serif': "'Source Serif 4 Variable', 'Source Serif 4', 'Noto Serif KR', Cambria, Georgia, serif",
  '--font-mono': "'IBM Plex Mono', 'SF Mono', ui-monospace, 'Fira Code', monospace",
  '--track-eyebrow': '0.1em',
}
