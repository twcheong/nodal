// Which of a slide spec's strings actually end up as TEXT on the rendered
// slide. Two consumers, one definition:
//   · scripts/deck/roundtrip.ts — the importer's regression test
//   · electron/tools/files/pptxVerify.ts — the post-export self-check every
//     write runs (our validate.py equivalent, but against the real file)
//
// Deliberately kind-aware, because two classes of string are legitimately
// absent from slide XML and counting them would make every check noisy:
//   · collections the renderer clamps (stats > 4, timeline > 6, …)
//   · chart categories/series names — pptxgenjs puts them in an embedded
//     workbook part, not on the slide
// `layout` geometry does not round-trip and is not expected to.
//
// See shared/deck/page.ts for the purity rules that apply to this whole folder.

import { CAPS, tocEntry, type SlideSpec } from './spec'

export function visibleTexts(spec: SlideSpec): string[] {
  const out: string[] = []
  const add = (...v: (string | number | null | undefined)[]) => {
    for (const x of v) if (x !== null && x !== undefined && String(x).trim()) out.push(String(x).trim())
  }
  add(spec.notes)

  switch (spec.kind) {
    case 'cover': add(spec.title, spec.subtitle, spec.badge, spec.date, spec.kicker?.toUpperCase(), ...(spec.chips ?? [])); break
    case 'title': add(spec.title, spec.subtitle); break
    case 'toc':
      add(spec.title)
      for (const sec of spec.variant === 'cards' ? spec.sections.slice(0, CAPS.tocCards) : spec.sections) {
        const it = tocEntry(sec)
        add(it.label, it.desc)
      }
      break
    case 'section': add(spec.title, spec.intro); break
    case 'stats':
      add(spec.title)
      for (const it of spec.items.slice(0, CAPS.statsItems)) add(it.value, it.label, it.sublabel)
      break
    case 'compare':
      add(spec.title, spec.left.title, spec.right.title, ...spec.left.bullets, ...spec.right.bullets)
      break
    case 'quote': add(spec.text, spec.attribution); break
    case 'timeline':
      add(spec.title)
      for (const st of spec.steps.slice(0, CAPS.timelineSteps)) add(st.label, st.desc)
      break
    case 'chart':
      add(spec.title, spec.takeaway, spec.source && `Source: ${spec.source}`)
      break
    case 'summary':
      add(spec.title, spec.closing, spec.contact)
      add(...spec.takeaways.slice(0, spec.variant === 'thanks' ? undefined : CAPS.summaryTakeaways))
      add(...(spec.nextSteps ?? []).slice(0, CAPS.summaryNextSteps))
      break
    case 'bullets': add(spec.title, ...spec.bullets); break
    case 'text': add(spec.title, spec.body); break
    case 'image': add(spec.title, spec.caption); break
    case 'table':
      // The kv variant draws bare key/value columns with no header row — the
      // two header strings are column METADATA there, absent by design (same
      // class as chart categories living in the workbook part).
      if (spec.variant !== 'kv') add(...spec.headers)
      add(spec.title)
      for (const row of spec.rows.slice(0, CAPS.tableRows)) add(...row)
      break
    case 'layout':
      add(spec.title)
      for (const b of spec.blocks) {
        const body = b.body
        switch (body.type) {
          case 'heading': case 'paragraph': add(body.text); break
          case 'bullets': add(...body.items); break
          case 'stat': add(body.value, body.label, body.sublabel); break
          case 'quote': add(body.attribution); break   // quoted text is wrapped in “ ”
          case 'image': add(body.caption); break
          case 'kv': for (const r of body.rows) add(r.k, r.v); break
          case 'icon': add(body.label, body.sublabel); break
          case 'step': add(body.title, body.desc); break
          case 'chips': add(...body.items); break
          case 'funnel': for (const st of body.stages) add(st.label, st.desc); break
          case 'chart': case 'spacer': break
        }
      }
      break
  }
  return out
}
