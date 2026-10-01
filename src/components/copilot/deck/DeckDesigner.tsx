// Content 모드의 좌측 패널 — 덱 디자인 조작반.
//
// 여기 있던 진단(구조 리포트·경고·스펙 JSON)은 전부 걷어냈다. 그건 모델에게
// 주는 정보지 사람에게 주는 정보가 아니고(같은 목록이 시각 QA 라운드로 이미
// 모델에게 간다), 사람이 그 자리에서 실제로 하고 싶은 건 "다르게 보이게" 다.
//
// 이 패널의 조작은 **전부 로컬 재계산**이다 — 모델 왕복도, 파일 쓰기도 없다.
// buildDeck 이 순수 함수라 스펙 한 필드만 바꿔 다시 그리면 끝이고, 그래서
// 타일마다 "그 옵션으로 실제로 그린 이 슬라이드"를 보여줄 수 있다. 색 이름이
// 아니라 결과를 고르는 화면.
//
// 비용: 타일 하나당 buildDeck 1회 × 슬라이드 1장. payload/선택이 그대로면
// useMemo 가 통째로 재사용한다.

import { useMemo } from 'react'
import { buildDeck } from '../../../../shared/deck/layout'
import { deckSeed, rotateVariants } from '../../../../shared/deck/layout/variety'
import { PPTX_STYLES, PPTX_THEMES } from '../../../../shared/deck/theme'
import { FIELD_SIGS, type SlideSpec } from '../../../../shared/deck/spec'
import type { SlideDisplay } from '../../../../shared/deck/el'
import { SlidePreview } from './SlidePreview'
import { useImageAspects } from './useSlideImages'

/**
 * 슬라이드가 가진 "얼굴" 필드들. FIELD_SIGS 의 시그니처 패턴으로 자동
 * 추출하지 않는 이유: `section.number` 의 시그니처가 `'number|string'` 인데
 * 이건 열거형이 아니라 **타입 합집합**이다. 표는 둘을 구분하지 못하므로
 * 여기서 이름으로 고른다.
 */
const OPTION_FIELDS = ['variant', 'chartType'] as const

/** 브랜드 틴트 프리셋 — 색상환을 고르게 훑는 8개. 커스텀은 옆 피커로. */
const BRAND_SWATCHES = ['C0392B', 'E67E22', 'D4AF37', '2E7D32', '0F9B8E', '1F6FEB', '5B4BD6', 'B5347A']

type Props = {
  payload: TwixyWritePptxPayload | null
  /** 우측 프리뷰에서 보고 있는 슬라이드 — 타일이 이 장을 그린다 (WYSIWYG). */
  selected: number
  /** 패널 폭(px) — 타일 2열이 이 폭을 따라간다. */
  width: number
  onChange: (next: TwixyWritePptxPayload) => void
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div style={{ borderBottom: '1px solid var(--border-subtle)', flexShrink: 0 }}>
      <div style={{
        padding: '8px 12px 6px', display: 'flex', alignItems: 'baseline', gap: 6,
        fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)',
        textTransform: 'uppercase', letterSpacing: 0.4,
      }}>
        <span>{title}</span>
        {note && <span style={{ textTransform: 'none', letterSpacing: 0, opacity: .8 }}>{note}</span>}
      </div>
      <div style={{ padding: '0 12px 10px' }}>{children}</div>
    </div>
  )
}

function Tile({ slide, label, sub, active, w, onClick }: {
  slide: SlideDisplay | null
  label: string
  sub?: string
  active: boolean
  w: number
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={sub ? `${label} · ${sub}` : label}
      style={{
        display: 'block', padding: 0, border: 'none', background: 'transparent',
        cursor: 'pointer', textAlign: 'left', width: w,
      }}
    >
      {slide
        ? <SlidePreview slide={slide} width={w} selected={active} />
        : <div style={{ width: w, height: (w * 7.5) / 13.333, borderRadius: 6, border: '1px dashed var(--border-subtle)' }} />}
      <div style={{
        marginTop: 3, fontSize: 10, lineHeight: 1.35,
        color: active ? 'var(--accent, #7C6AFF)' : 'var(--text-muted)',
        fontWeight: active ? 600 : 400,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {label}{sub && <span style={{ fontWeight: 400, opacity: .7 }}> · {sub}</span>}
      </div>
    </button>
  )
}

export function DeckDesigner({ payload, selected, width, onChange }: Props) {
  const slides = payload?.slides ?? []

  // 렌더된 얼굴 = 스펙의 variant 가 비어 있으면 시드로 굴린 결과. 타일이
  // 보여줄 것도, 아래에서 얼려 넣을 것도 이 해석본이다.
  const resolved = useMemo(
    () => (payload ? rotateVariants(payload.slides, deckSeed(payload)) : []),
    [payload],
  )
  const idx = Math.min(Math.max(selected, 0), Math.max(resolved.length - 1, 0))
  const spec = resolved[idx] as SlideSpec | undefined

  const tileW = Math.max(104, Math.floor((width - 24 - 8) / 2))
  // 타일도 본 화면과 같은 기하로 — 사진 모양을 알아야 액자가 같게 나온다.
  const imageAspects = useImageAspects(payload)

  // 타일 한 장 = 그 옵션으로 실제로 그린 이 슬라이드. 스펙이 깨져 있으면
  // (모델이 방금 이상한 걸 보냈다면) 타일만 비고 패널은 살아 있는다.
  const mini = useMemo(() => {
    return (over: Partial<TwixyWritePptxPayload>, s: SlideSpec | undefined): SlideDisplay | null => {
      if (!payload || !s) return null
      try { return buildDeck({ ...payload, ...over, slides: [s] }, { imageAspects }).slides[0] ?? null }
      catch { return null }
    }
  }, [payload, imageAspects])

  const themeTiles = useMemo(
    () => Object.keys(PPTX_THEMES).map((name) => ({ name, slide: mini({ theme: name }, spec) })),
    [mini, spec],
  )
  const styleTiles = useMemo(
    () => Object.entries(PPTX_STYLES).map(([name, recipe]) => ({ name, badge: recipe.badge, slide: mini({ style: name }, spec) })),
    [mini, spec],
  )
  // 선택된 장이 가진 얼굴 축들(variant, chart 면 chartType). 축마다 후보를
  // 그려서 "이 페이지를 다르게 보여주는 방법"을 눈으로 고르게 한다.
  const faceRows = useMemo(() => {
    if (!spec) return []
    const sigs = (FIELD_SIGS as Record<string, Record<string, string>>)[spec.kind] ?? {}
    const rows: { field: string; current: string | undefined; options: { value: string; slide: SlideDisplay | null }[] }[] = []
    for (const field of OPTION_FIELDS) {
      const sig = sigs[field]
      if (!sig || !sig.includes('|')) continue
      const values = sig.split('|').map(v => v.trim()).filter(Boolean)
      rows.push({
        field,
        current: (spec as unknown as Record<string, string | undefined>)[field],
        options: values.map(value => ({ value, slide: mini({}, { ...spec, [field]: value } as SlideSpec) })),
      })
    }
    return rows
  }, [mini, spec])

  if (!payload) {
    return (
      <div style={{ padding: 14, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.7 }}>
        Palette, shape and per-slide layout options appear here once a deck is built.
        Every option here redraws locally — no regeneration, no waiting.
      </div>
    )
  }

  const curTheme = (payload.theme ?? 'twixy').toLowerCase()
  const curStyle = (payload.style ?? PPTX_THEMES[curTheme as keyof typeof PPTX_THEMES]?.styleDefault ?? '').toLowerCase()

  // 테마를 바꾸면 시드(제목+테마)가 바뀌어 **variant 가 비어 있는 모든 장의
  // 얼굴이 같이 굴러간다** — 색만 바꿨는데 레이아웃이 통째로 흔들린다.
  // 그래서 지금 화면에 보이는 얼굴을 스펙에 얼려 넣고 테마만 바꾼다.
  const pickTheme = (name: string) => {
    if (name === curTheme) return
    onChange({ ...payload, theme: name, slides: resolved })
  }
  const setField = (field: string, value: string) => {
    const next = slides.map((s, i) => (i === idx ? { ...(resolved[i] as object), [field]: value } as SlideSpec : s))
    onChange({ ...payload, slides: next })
  }

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
      <Section title="Palette" note={`${slides.length} slides`}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {themeTiles.map(({ name, slide }) => (
            <Tile key={name} slide={slide} label={name} active={name === curTheme} w={tileW}
              onClick={() => pickTheme(name)} />
          ))}
        </div>
      </Section>

      <Section title="Shape" note="corners · margins · page number">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {styleTiles.map(({ name, badge, slide }) => (
            <Tile key={name} slide={slide} label={name} sub={badge} active={name === curStyle} w={tileW}
              onClick={() => { if (name !== curStyle) onChange({ ...payload, style: name }) }} />
          ))}
        </div>
      </Section>

      <Section title="Brand tint" note="re-skins any palette">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          {BRAND_SWATCHES.map((hex) => {
            const active = (payload.brand ?? '').replace(/^#/, '').toUpperCase() === hex
            return (
              <button key={hex} type="button" title={`#${hex}`}
                onClick={() => onChange({ ...payload, brand: hex })}
                style={{
                  width: 22, height: 22, borderRadius: '50%', cursor: 'pointer', background: `#${hex}`,
                  border: active ? '2px solid var(--accent, #7C6AFF)' : '1px solid rgba(0,0,0,.18)',
                  boxShadow: active ? '0 0 0 2px rgba(124,106,255,.18)' : 'none', padding: 0,
                }} />
            )
          })}
          {/* 비제어(defaultValue + key): 제어 입력으로 두면 피커를 끄는 동안
              onChange 가 매 프레임 덱을 다시 그린다. 커밋은 blur 한 번. */}
          <input
            type="color"
            key={payload.brand ?? 'none'}
            defaultValue={`#${(payload.brand ?? '888888').replace(/^#/, '')}`}
            onBlur={(e) => onChange({ ...payload, brand: e.target.value.replace(/^#/, '').toUpperCase() })}
            title="Custom brand colour"
            style={{ width: 24, height: 24, padding: 0, border: '1px solid var(--border-subtle)', borderRadius: 5, background: 'transparent', cursor: 'pointer' }}
          />
          {payload.brand && (
            <button type="button" onClick={() => { const { brand: _drop, ...rest } = payload; onChange(rest) }}
              style={{ fontSize: 10, padding: '3px 7px', borderRadius: 5, cursor: 'pointer', border: '1px solid var(--border-subtle)', background: 'transparent', color: 'var(--text-muted)' }}>
              Clear
            </button>
          )}
        </div>
      </Section>

      {spec && (
        <Section title={`Slide ${idx + 1}`} note={spec.kind}>
          {faceRows.length === 0 ? (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
              This kind has one face. Pick another slide, or ask the chat to change its kind.
            </div>
          ) : faceRows.map((row) => (
            <div key={row.field} style={{ marginBottom: 8 }}>
              {faceRows.length > 1 && (
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>{row.field}</div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {row.options.map(({ value, slide }) => (
                  <Tile key={value} slide={slide} label={value} active={value === row.current} w={tileW}
                    onClick={() => setField(row.field, value)} />
                ))}
              </div>
            </div>
          ))}
        </Section>
      )}
    </div>
  )
}
