// ─────────────────────────────────────────────────────────────────────────────
// useFileDropZone — 파일 드래그앤드랍 오버레이 상태를 한 곳에서 관리.
//
// 왜 훅으로 뺐나: 각 탭이 dragenter/dragleave 카운터를 따로 굴리다가 "드래그가
// 화면을 스쳐 지나가기만 해도 오버레이가 켜지고, 실제로 뭘 드랍할 때까지 안
// 꺼지는" 버그를 똑같이 갖고 있었다. dragleave 는 믿을 게 못 된다 —
//   · 드래그 도중 리렌더로 요소가 갈리면 enter 만 오고 leave 는 안 온다
//   · 창 밖으로 나가거나 다른 앱에 떨어뜨리면 leave/drop 이 아예 안 온다
//   · 우리 요소 밖(다른 패널)에 떨어뜨리면 우리 onDrop 도 안 온다
//   · 크롬은 요소 사이를 옮길 때도 relatedTarget 없이 dragleave 를 쏜다
//     (= "창을 나갔다" 와 구분이 안 된다)
//
// 그래서 판정을 뒤집었다. 오버레이를 살려두는 유일한 근거는 "dragover 가 계속
// 오고 있다" 하나뿐이다:
//   · dragover 를 받으면 켜고 타이머를 IDLE_MS 로 다시 감는다
//   · 모든 종류의 "나간 것 같다" 신호(dragleave / 창 dragleave)는 즉시 끄지
//     않고 타이머를 EXIT_MS 로 당긴다 — 요소 사이를 지나가는 중이면 곧바로
//     dragover 가 와서 취소되므로 깜빡이지 않는다
//   · drop / dragend / 포인터 부활은 확실한 종료라 즉시 끈다 (네이티브 DnD
//     중엔 포인터 이벤트가 안 온다 → 다시 온다 = 드래그는 이미 끝났다)
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react'

/** dragover 가 이만큼 끊기면 드래그가 끝난 걸로 본다 (최후의 안전망). */
const IDLE_MS = 1200
/** "나간 것 같다" 신호를 받은 뒤 이만큼 dragover 가 없으면 끈다. */
const EXIT_MS = 150
/** 이 시간 안에 dragover 를 받았다면 포인터 이벤트는 드래그 종료 신호가 아니다. */
const POINTER_GRACE_MS = 300

export interface FileDropZone {
  /** 오버레이를 띄울지 여부 */
  isDragging: boolean
  /** 드랍 영역 엘리먼트에 스프레드 */
  dropHandlers: {
    onDragEnter: (e: React.DragEvent) => void
    onDragOver:  (e: React.DragEvent) => void
    onDragLeave: (e: React.DragEvent) => void
    onDrop:      (e: React.DragEvent) => void
  }
}

export function useFileDropZone(opts: {
  /** 받아줄 파일 필터. 통과한 파일이 하나도 없으면 onFiles 는 안 불린다. */
  accept: (f: File) => boolean
  onFiles: (files: File[]) => void | Promise<void>
}): FileDropZone {
  const [isDragging, setIsDragging] = useState(false)
  const timerRef = useRef<number | null>(null)
  /** 마지막 dragover 시각 — 포인터 신호가 "진짜 종료"인지 가르는 기준. */
  const lastOverRef = useRef(0)
  // 콜백은 매 렌더 새로 오므로 ref 로 최신값만 들고 간다 (리스너 재등록 방지).
  const acceptRef  = useRef(opts.accept)
  const onFilesRef = useRef(opts.onFiles)
  acceptRef.current  = opts.accept
  onFilesRef.current = opts.onFiles

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) { window.clearTimeout(timerRef.current); timerRef.current = null }
  }, [])

  const end = useCallback(() => {
    clearTimer()
    setIsDragging(false)
  }, [clearTimer])

  /** ms 안에 dragover 가 더 안 오면 끈다. 다음 dragover 가 취소한다. */
  const arm = useCallback((ms: number) => {
    clearTimer()
    timerRef.current = window.setTimeout(() => { timerRef.current = null; setIsDragging(false) }, ms)
  }, [clearTimer])

  const alive = useCallback(() => {
    lastOverRef.current = Date.now()
    arm(IDLE_MS)
    setIsDragging(true)
  }, [arm])

  // 창 단위 신호. dragleave 는 "나간 것 같다"(크롬은 요소 사이 이동에도 쏜다)라
  // 유예를 두고, drop/dragend 는 확실한 종료라 즉시 끈다.
  useEffect(() => {
    const onWindowDragLeave = () => { if (timerRef.current !== null) arm(EXIT_MS) }
    window.addEventListener('dragleave', onWindowDragLeave)
    window.addEventListener('drop', end)
    window.addEventListener('dragend', end)
    return () => {
      window.removeEventListener('dragleave', onWindowDragLeave)
      window.removeEventListener('drop', end)
      window.removeEventListener('dragend', end)
      clearTimer()
    }
  }, [arm, end, clearTimer])

  // 오버레이가 떠 있는 동안만: 포인터/키보드가 다시 살아나면 드래그는 끝난
  // 것이다 — 창 밖에 떨어뜨려 dragleave/drop/dragend 를 하나도 못 받은 경우를
  // 여기서 잡는다. 방금 dragover 를 받았다면 무시한다 (혹시 드래그 중에도
  // 포인터 이벤트가 오는 환경에서 오버레이가 안 뜨는 쪽으로 깨지지 않게).
  useEffect(() => {
    if (!isDragging) return
    const endIfDragIsOver = () => {
      if (Date.now() - lastOverRef.current < POINTER_GRACE_MS) return
      end()
    }
    window.addEventListener('pointermove', endIfDragIsOver)
    window.addEventListener('pointerdown', endIfDragIsOver)
    window.addEventListener('keydown', endIfDragIsOver)
    return () => {
      window.removeEventListener('pointermove', endIfDragIsOver)
      window.removeEventListener('pointerdown', endIfDragIsOver)
      window.removeEventListener('keydown', endIfDragIsOver)
    }
  }, [isDragging, end])

  const hasFiles = (e: React.DragEvent) => Boolean(e.dataTransfer?.types?.includes('Files'))

  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    alive()
  }, [alive])

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    // dragenter 를 놓쳤어도(리렌더로 요소가 갈린 경우) 여기서 복구된다.
    alive()
  }, [alive])

  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (!hasFiles(e)) return
    if (timerRef.current !== null) arm(EXIT_MS)
  }, [arm])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    end()
    const files = Array.from(e.dataTransfer?.files ?? []).filter(f => acceptRef.current(f))
    if (files.length === 0) return
    void onFilesRef.current(files)
  }, [end])

  return { isDragging, dropHandlers: { onDragEnter, onDragOver, onDragLeave, onDrop } }
}
