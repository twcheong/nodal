// Deck purposes — what a deck must MAKE HAPPEN, as type-checked data.
//
// varietyReport used to hardcode ONE skeleton (cover→toc→section→…→summary)
// for every deck. A budget request and a workshop are not the same shape, and
// a check that says otherwise trains the model to pad. Each purpose owns a
// page table: an ordered list of semantic slots, each naming the kinds that
// can satisfy it — several kinds per slot is where deck-to-deck variety comes
// from within one purpose.
//
// Same contract-as-data spirit as SLIDE_FIELDS in spec.ts: the mapped type
// forces all six purposes to exist, `SlideKind[]` rejects a kind that does
// not, and the id must match its key.
//
// INVARIANT: nothing in layout/ may branch on purpose. Purpose is a REPORTING
// layer (structureReport) — that is what keeps the three axes (purpose /
// variant / theme) orthogonal and the snapshot oracle purpose-blind.
//
// See shared/deck/page.ts for the purity rules that apply to this whole folder.

import { PURPOSE_IDS, isPurposeId, type PurposeId, type SlideKind, type WritePptxPayload } from './spec'

export type PurposeSlot = {
  /** stable semantic id — appears verbatim in structure notes and prompts */
  role: string
  /** kinds that satisfy this slot, most preferred FIRST */
  kinds: SlideKind[]
  /** [min, max] slides. min 0 = optional; max caps greedy matching. */
  repeat: [number, number]
  /** one line the model reads: what this page must accomplish */
  guide: string
}

export type DeckPurpose<P extends PurposeId = PurposeId> = {
  id: P
  /** the objective, in the author's voice */
  objective: string
  audience: string
  /** what "it worked" looks like */
  success: string
  /**
   * Soft slide budget for this purpose. The old prompt capped EVERY deck at
   * 10 slides, which is why a 20-slide narrative arc never happened — an
   * align/teach deck legitimately runs long, a decide deck must not.
   */
  slideBudget: number
  /** ordered page table */
  slots: PurposeSlot[]
}

export const DECK_PURPOSES: { [P in PurposeId]: DeckPurpose<P> } = {
  pitch: {
    id: 'pitch',
    slideBudget: 10,
    objective: 'make them choose us',
    audience: 'external prospect',
    success: 'a next meeting or a signed contract',
    slots: [
      { role: 'open',      kinds: ['cover'],                                    repeat: [1, 1], guide: 'the promise: who we are and what changes for them' },
      { role: 'stakes',    kinds: ['stats', 'chart', 'quote', 'text'],          repeat: [1, 1], guide: 'their problem in THEIR numbers — before any word about us' },
      { role: 'agenda',    kinds: ['toc'],                                      repeat: [0, 1], guide: 'the route, only if the deck runs past 8 pages' },
      { role: 'diagnosis', kinds: ['bullets', 'table', 'chart', 'layout'],      repeat: [1, 2], guide: 'what is actually broken today, named specifically' },
      { role: 'approach',  kinds: ['timeline', 'layout', 'bullets', 'compare'], repeat: [1, 2], guide: 'what we would do, in the order we would do it' },
      { role: 'proof',     kinds: ['stats', 'compare', 'image', 'quote', 'table'], repeat: [1, 2], guide: 'evidence we have done this — a result, not an adjective' },
      { role: 'offer',     kinds: ['table', 'layout', 'compare'],               repeat: [0, 1], guide: 'scope, timeline, price — concrete enough to say yes to' },
      { role: 'ask',       kinds: ['summary'],                                  repeat: [1, 1], guide: 'the single next step, with a date — variant split + nextSteps' },
    ],
  },

  report: {
    id: 'report',
    slideBudget: 12,
    objective: 'tell them accurately what happened',
    audience: 'client or manager',
    success: 'trust, and one shared picture of status',
    slots: [
      { role: 'open',     kinds: ['cover'],                              repeat: [1, 1], guide: 'period and scope in the title — no suspense' },
      { role: 'agenda',   kinds: ['toc'],                                repeat: [0, 1], guide: 'the parts, matching the page titles they introduce word for word' },
      { role: 'headline', kinds: ['stats'],                              repeat: [1, 1], guide: 'the 2-4 numbers that ARE the period' },
      { role: 'result',   kinds: ['chart', 'table', 'layout', 'stats'],  repeat: [2, 5], guide: 'one page per area, each with its own takeaway line' },
      { role: 'driver',   kinds: ['compare', 'text', 'quote', 'chart'],  repeat: [1, 2], guide: 'WHY it moved — a report without causes is a dashboard' },
      { role: 'risk',     kinds: ['bullets', 'table', 'compare'],        repeat: [0, 1], guide: 'what is off track, said plainly and early' },
      { role: 'ahead',    kinds: ['timeline', 'bullets', 'layout'],      repeat: [0, 1], guide: 'next period, so the reader knows what changes' },
      { role: 'close',    kinds: ['summary'],                            repeat: [1, 1], guide: 'the same numbers as headline, now as conclusions' },
    ],
  },

  decide: {
    id: 'decide',
    slideBudget: 8,
    objective: 'extract one decision',
    audience: 'the decision maker',
    success: 'an approval, or a named chosen option',
    slots: [
      { role: 'open',      kinds: ['cover'],                           repeat: [1, 1], guide: 'put the DECISION in the title, not the topic' },
      { role: 'question',  kinds: ['text', 'layout', 'bullets'],       repeat: [1, 1], guide: 'the question, the deadline, and who decides — one page' },
      { role: 'context',   kinds: ['stats', 'chart', 'timeline'],      repeat: [0, 1], guide: 'what changed that makes this a choice now' },
      { role: 'options',   kinds: ['compare', 'table', 'layout'],      repeat: [1, 2], guide: 'A next to B on ONE page — never A then B on two' },
      { role: 'criteria',  kinds: ['table', 'layout', 'bullets'],      repeat: [0, 1], guide: 'how we will judge, agreed before the answer' },
      { role: 'impact',    kinds: ['chart', 'table', 'stats'],         repeat: [1, 1], guide: 'the numbers per option — cost, risk, upside' },
      { role: 'recommend', kinds: ['text', 'quote', 'layout', 'stats'], repeat: [1, 1], guide: 'our pick and the one reason — earned AFTER the comparison' },
      { role: 'ask',       kinds: ['summary'],                         repeat: [1, 1], guide: 'exactly what you want approved, and by when' },
    ],
  },

  align: {
    id: 'align',
    slideBudget: 16,
    objective: 'everyone holds the same picture',
    audience: 'internal team or a new client',
    success: 'each person can say what their part is',
    slots: [
      { role: 'open',    kinds: ['cover'],                                 repeat: [1, 1], guide: 'the thing we are all now inside of' },
      { role: 'why',     kinds: ['text', 'quote', 'stats'],                repeat: [1, 1], guide: 'the goal in one line everyone can repeat' },
      { role: 'map',     kinds: ['toc'],                                   repeat: [0, 1], guide: 'the parts, so nobody wonders what is coming' },
      { role: 'picture', kinds: ['layout', 'timeline', 'chart', 'image'],  repeat: [1, 1], guide: 'the WHOLE thing on one page — the page people photograph' },
      { role: 'detail',  kinds: ['bullets', 'layout', 'table', 'chart'],   repeat: [0, 4], guide: 'what each part contains' },
      { role: 'roles',   kinds: ['table', 'compare', 'layout'],            repeat: [1, 1], guide: 'who owns what, by name — the page this deck exists for' },
      { role: 'when',    kinds: ['timeline'],                              repeat: [1, 1], guide: 'dates and milestones, six steps max' },
      { role: 'rules',   kinds: ['bullets', 'layout', 'table'],            repeat: [0, 1], guide: 'how we work: cadence, channels, escalation' },
      { role: 'close',   kinds: ['summary'],                               repeat: [1, 1], guide: 'first actions with owners — variant split + nextSteps' },
    ],
  },

  analyze: {
    id: 'analyze',
    slideBudget: 12,
    objective: 'draw conclusions from data',
    audience: 'a strategist',
    success: 'one implication that sticks',
    slots: [
      { role: 'open',        kinds: ['cover'],                                repeat: [1, 1], guide: 'the question as the title, not the dataset name' },
      { role: 'question',    kinds: ['text', 'quote', 'stats'],               repeat: [1, 1], guide: 'what we set out to learn, and why it matters' },
      { role: 'method',      kinds: ['bullets', 'table', 'layout'],           repeat: [0, 1], guide: 'sources, period, caveats — credibility is cheap here' },
      { role: 'finding',     kinds: ['chart', 'table', 'stats', 'layout'],    repeat: [2, 5], guide: 'ONE finding per page, each with a takeaway sentence' },
      { role: 'pattern',     kinds: ['compare', 'layout', 'text', 'timeline'], repeat: [1, 1], guide: 'what the findings say TOGETHER — the synthesis page' },
      { role: 'implication', kinds: ['quote', 'stats', 'text', 'layout'],     repeat: [1, 1], guide: 'so what, for us, starting when' },
      { role: 'close',       kinds: ['summary'],                              repeat: [1, 1], guide: 'the conclusions, ranked by confidence' },
    ],
  },

  teach: {
    id: 'teach',
    slideBudget: 16,
    objective: 'make it reproducible',
    audience: 'a learner',
    success: 'they can do it themselves afterwards',
    slots: [
      { role: 'open',        kinds: ['cover'],                                repeat: [1, 1], guide: 'the skill, phrased as something they will be able to do' },
      { role: 'outcome',     kinds: ['bullets', 'stats', 'text'],             repeat: [1, 1], guide: '"after this you can…" — 3 concrete abilities' },
      { role: 'map',         kinds: ['toc'],                                  repeat: [0, 1], guide: 'the route through the material' },
      { role: 'concept',     kinds: ['layout', 'text', 'image', 'compare'],   repeat: [1, 1], guide: 'the mental model, before any button-pressing' },
      { role: 'steps',       kinds: ['timeline', 'layout'],                   repeat: [1, 1], guide: 'the procedure as numbered steps, six max' },
      { role: 'walkthrough', kinds: ['image', 'table', 'layout', 'chart'],    repeat: [1, 3], guide: 'do it once on a real artefact, with the real screen' },
      { role: 'pitfalls',    kinds: ['compare', 'bullets', 'table'],          repeat: [0, 1], guide: 'what goes wrong, and the tell for each' },
      { role: 'practice',    kinds: ['bullets', 'layout', 'table'],           repeat: [1, 1], guide: 'their turn — a checklist they can run unaided' },
      { role: 'close',       kinds: ['summary'],                              repeat: [1, 1], guide: 'recap plus where to get the material — variant thanks' },
    ],
  },
}

/** Absent = null; unknown = hard error — the resolveTheme discipline. */
export function resolvePurpose(payload: WritePptxPayload): DeckPurpose | null {
  const p = payload.purpose
  if (p === undefined) return null
  if (!isPurposeId(p)) {
    throw new Error(`Unknown purpose '${String(p)}'. Valid purposes: ${PURPOSE_IDS.join(' | ')}.`)
  }
  return DECK_PURPOSES[p]
}

export type SlotFill = { slot: PurposeSlot; count: number; at: number[] }

/**
 * LAZY matching of slides to slots.
 *
 * Each slide goes to the first slot (in table order) that accepts its kind and
 * is still under its MINIMUM; only when no slot is hungry does it top up the
 * first non-full acceptor. Greedy matching would let 'finding' eat every chart
 * in an analyze deck and then report 'implication' missing — a note that is
 * true of the matcher, not the deck.
 *
 * Deliberately NOT position-constrained: dividers legitimately interleave with
 * the pages they introduce (part/result). Order problems are detected AFTER
 * matching, from first-occurrence inversions (see structureReport).
 */
export function fitPurpose(p: DeckPurpose, kinds: SlideKind[]): SlotFill[] {
  const fills: SlotFill[] = p.slots.map((slot) => ({ slot, count: 0, at: [] }))

  kinds.forEach((kind, slideIdx) => {
    const acceptors = fills.filter((f) => f.count < f.slot.repeat[1] && f.slot.kinds.includes(kind))
    if (acceptors.length === 0) return   // serves no slot — unmatched, not an error
    const target = acceptors.find((f) => f.count < f.slot.repeat[0]) ?? acceptors[0]
    target.count++
    target.at.push(slideIdx)
  })

  return fills
}
