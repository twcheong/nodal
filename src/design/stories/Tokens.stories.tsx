// 디자인 토큰 문서 — tokens.ts의 rawValues를 순회해 자동 렌더한다.
// TS 객체에서 직접 렌더하므로 코드와 문서가 어긋날 수 없다.
import type { ReactNode } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { rawValues } from '../tokens'

/** var(--x) 체인을 rawValues에서 재귀 해석해 실제 값(hex 등)을 얻는다 */
function resolve(value: string): string {
  const m = value.match(/^var\((--[a-z0-9-]+)\)$/i)
  if (m && rawValues[m[1]]) return resolve(rawValues[m[1]])
  return value
}

const entries = Object.entries(rawValues)
const colorEntries = entries.filter(([, v]) => /^#|^rgba?\(|^var\(/.test(v))
const primitives = colorEntries.filter(([k]) => !rawValues[k].startsWith('var('))
const semantics = colorEntries.filter(([k]) => rawValues[k].startsWith('var('))
const radii = entries.filter(([k]) => k.startsWith('--radius'))
const spaces = entries.filter(([k]) => k.startsWith('--space'))
const fonts = entries.filter(([k]) => k.startsWith('--font'))

function Swatch({ name, value }: { name: string; value: string }) {
  const actual = resolve(value)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0' }}>
      <div
        style={{
          width: 36,
          height: 24,
          borderRadius: 5,
          background: `var(${name})`,
          border: '1px solid var(--border)',
          flexShrink: 0,
        }}
      />
      <code style={{ fontSize: 12, color: 'var(--text-primary)', minWidth: 170 }}>{name}</code>
      <code style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 140 }}>
        {value.startsWith('var(') ? value : ''}
      </code>
      <code style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{actual}</code>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ marginBottom: 28 }}>
      <h2
        style={{
          fontSize: 13,
          fontWeight: 700,
          color: 'var(--text-primary)',
          borderBottom: '1px solid var(--border-subtle)',
          paddingBottom: 6,
          marginBottom: 10,
        }}
      >
        {title}
      </h2>
      {children}
    </section>
  )
}

function TokensPage() {
  return (
    <div style={{ fontFamily: 'var(--font-sans)', color: 'var(--text-primary)', maxWidth: 720 }}>
      <h1 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Design Tokens</h1>
      <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 24 }}>
        2단계 구조 — 리브랜딩 시 <b>primitives 값만</b> 교체하면 semantic 층이 전부 따라온다.
        컴포넌트 코드는 semantic 토큰만 참조한다. (소스: src/design/tokens.css · tokens.ts)
      </p>

      <Section title="Semantic colors — 컴포넌트가 쓰는 이름">
        {semantics.map(([k, v]) => (
          <Swatch key={k} name={k} value={v} />
        ))}
      </Section>

      <Section title="Primitives — 리브랜딩 시 교체 대상">
        {primitives.map(([k, v]) => (
          <Swatch key={k} name={k} value={v} />
        ))}
      </Section>

      <Section title="Radius">
        <div style={{ display: 'flex', gap: 20 }}>
          {radii.map(([k, v]) => (
            <div key={k} style={{ textAlign: 'center' }}>
              <div
                style={{
                  width: 72,
                  height: 48,
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border)',
                  borderRadius: `var(${k})`,
                  marginBottom: 6,
                }}
              />
              <code style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                {k} · {v}
              </code>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Spacing">
        {spaces.map(([k, v]) => (
          <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '3px 0' }}>
            <code style={{ fontSize: 11, color: 'var(--text-secondary)', minWidth: 110 }}>
              {k} · {v}
            </code>
            <div style={{ width: `var(${k})`, height: 12, background: 'var(--accent)' }} />
          </div>
        ))}
      </Section>

      <Section title="Typography">
        {fonts.map(([k, v]) => (
          <div key={k} style={{ padding: '6px 0' }}>
            <code style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{k}</code>
            <div style={{ fontFamily: `var(${k})`, fontSize: 14, marginTop: 2 }}>
              The quick brown fox jumps over the lazy dog 0123456789
            </div>
            <code style={{ fontSize: 10, color: 'var(--text-muted)' }}>{v}</code>
          </div>
        ))}
      </Section>
    </div>
  )
}

const meta: Meta<typeof TokensPage> = {
  title: 'Foundation/Tokens',
  component: TokensPage,
}
export default meta

export const All: StoryObj<typeof TokensPage> = {}
