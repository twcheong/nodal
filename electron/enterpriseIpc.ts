// ── Twixy Enterprise admin IPC (main.ts 에서 이동) ──────────────────────────
//
// Enterprise 배포에서 관리자가 팀 프로젝트 폴더를 열어 실행 기록을 들여다보는 경로와,
// shared/ 를 사용자 폴더로 당겨오는 `pull-shared`.
//
// ── D2 — projectRoot 의 출처를 렌더러에서 떼어 낸다 ─────────────────────────
// `twixy-enterprise-admin-load` 와 `twixy-enterprise-read-run` 은 렌더러가 준
// `projectRoot` 를 그대로 `path.join` 했다. 어드민 대시보드는 고른 폴더를 렌더러
// localStorage 에 쌓아 두고 그 문자열로 다시 부르므로, 경로의 **출처**가 렌더러였다.
// D1(set-project-dir)과 같은 방식으로 고친다: 우리가 띄운 다이얼로그
// (`twixy-enterprise-pick-folder`)가 돌려준 경로만 main 이 기억하고, 그 목록으로
// 되돌아온 것만 받는다. uid·planId 도 렌더러 입력이라 `safeSegment` 로 한 세그먼트로 막는다.
//
// **왜 D1 의 `userPickedProjectDirs`(main.ts)를 그대로 쓰지 않는가 — 수명이 다르다.**
// D1 은 샌드박스 루트(쓰기 경계)를 바꾸는 권한이라 일부러 세션 범위다: 앱을 끄면 잊고,
// 다시 고르게 한다. 여기는 읽기 전용 리포트 경로이고, 대시보드가 프로젝트 목록을 재시작
// 뒤에도 들고 있는 것이 기능 자체다 — 세션 범위로 만들면 저장된 프로젝트가 재시작마다
// 전부 거부된다. 그래서 같은 판정(`isSamePathAsAny`)을 쓰되 목록은 영속으로 따로 둔다.
// 두 목록을 합치려면 D1 의 세션 범위를 깨야 하는데, 그건 더 센 권한 쪽을 느슨하게 만든다.
import { dialog, ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { PRODUCT } from '../shared/product/current.generated'
import { getWorkspace, getSharedDir, stateFile } from './paths'
import { isSamePathAsAny, safeSegment } from './trustBoundary'

export interface EnterpriseIpcDeps {
  getMainWindow: () => BrowserWindow | null
  safeCopyFile: (src: string, dst: string) => { ok: boolean; downgraded: boolean; err?: unknown }
}

/** 다이얼로그가 돌려준 프로젝트 루트 목록. 앱 상태 폴더 소유 — 렌더러는 쓰지 못한다. */
const PICKED_ROOTS_PATH = stateFile('enterprise-roots.json')

function pickedRoots(): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(PICKED_ROOTS_PATH, 'utf8'))
    return Array.isArray(raw?.roots)
      ? (raw.roots as unknown[]).filter((r): r is string => typeof r === 'string' && !!r)
      : []
  } catch { return [] }
}

function rememberPickedRoot(dir: string): void {
  const roots = pickedRoots()
  if (roots.includes(dir)) return
  fs.mkdirSync(path.dirname(PICKED_ROOTS_PATH), { recursive: true })
  fs.writeFileSync(PICKED_ROOTS_PATH, JSON.stringify({ roots: [...roots, dir] }, null, 2), 'utf8')
}

/**
 * 렌더러가 준 projectRoot 를 받아도 되는가. 아니면 **throw** 한다.
 * 조용히 빈 결과를 돌려주면 "폴더에 기록이 없다" 와 구별되지 않는다 — 대시보드는
 * `.catch(e => setError(e.message))` 로 이미 오류를 화면에 띄우므로 그 모양에 맞춘다.
 */
export function requirePickedRoot(projectRoot: unknown, picked: Iterable<string>): string {
  if (typeof projectRoot !== 'string' || !projectRoot || !isSamePathAsAny(projectRoot, picked)) {
    console.warn('[twixy/ipc] enterprise: 다이얼로그로 고르지 않은 projectRoot — 거부')
    throw new Error('not_user_picked: 폴더 선택으로 연 프로젝트만 볼 수 있습니다. 프로젝트를 다시 선택해 주세요.')
  }
  return projectRoot
}

/** `<root>/users/<uid>/plans/<planId>/run.md` — uid·planId 는 한 세그먼트여야 한다. */
export function enterpriseRunPath(
  projectRoot: unknown, uid: unknown, planId: unknown, picked: Iterable<string>,
): string {
  return path.join(
    requirePickedRoot(projectRoot, picked),
    'users', safeSegment(uid), 'plans', safeSegment(planId), 'run.md',
  )
}

/** Enterprise admin IPC 를 등록한다. import 시점 부작용 없음. */
export function registerEnterpriseIpc(deps: EnterpriseIpcDeps): void {
  const { getMainWindow, safeCopyFile } = deps

  ipcMain.handle('pull-shared', (): {
    ok: boolean
    copied: number
    updated: number
    skipped: number
    details: { skill: string; file: string; action: 'copied' | 'updated' | 'skipped' }[]
    error?: string
  } => {
    try {
      let copied = 0
      let updated = 0
      let skipped = 0
      const details: { skill: string; file: string; action: 'copied' | 'updated' | 'skipped' }[] = []
      const sharedSkillsDir = path.join(getSharedDir(), 'skills')
      const userSkillsDir   = path.join(getWorkspace(), 'skills')
      if (fs.existsSync(sharedSkillsDir)) {
        fs.mkdirSync(userSkillsDir, { recursive: true })
        for (const skill of fs.readdirSync(sharedSkillsDir)) {
          const src = path.join(sharedSkillsDir, skill)
          const dst = path.join(userSkillsDir, skill)
          if (!fs.statSync(src).isDirectory()) continue
          fs.mkdirSync(dst, { recursive: true })
          for (const file of fs.readdirSync(src)) {
            const srcFile = path.join(src, file)
            const dstFile = path.join(dst, file)
            const srcStat = fs.statSync(srcFile)
            if (!srcStat.isFile()) continue
            if (!fs.existsSync(dstFile)) {
              safeCopyFile(srcFile, dstFile)
              copied++
              details.push({ skill, file, action: 'copied' })
            } else if (fs.statSync(dstFile).size !== srcStat.size) {
              safeCopyFile(srcFile, dstFile)
              updated++
              details.push({ skill, file, action: 'updated' })
            } else {
              skipped++
              details.push({ skill, file, action: 'skipped' })
            }
          }
        }
      }
      return { ok: true, copied, updated, skipped, details }
    } catch (err) {
      return {
        ok: false,
        copied: 0,
        updated: 0,
        skipped: 0,
        details: [],
        error: err instanceof Error ? err.message : String(err),
      }
    }
  })

  // ── 여기부터는 Enterprise 빌드 전용 ──────────────────────────────
  // `pull-shared` 는 전 제품이 쓰지만(MergeRequestPanel), 아래 3채널은 어드민
  // 대시보드(`features.enterpriseAdmin`)만 부른다. 안 쓰는 제품에서는 아예 열지 않는다.
  if (!PRODUCT.features.enterpriseAdmin) return

  ipcMain.handle('twixy-enterprise-read-run', (_e, payload: { projectRoot: string; uid: string; planId: string }) => {
    const runPath = enterpriseRunPath(payload?.projectRoot, payload?.uid, payload?.planId, pickedRoots())
    if (!fs.existsSync(runPath)) return null
    return fs.readFileSync(runPath, 'utf8')
  })

  ipcMain.handle('twixy-enterprise-pick-folder', async () => {
    const { filePaths, canceled } = await dialog.showOpenDialog(getMainWindow()!, {
      title: 'Twixy Enterprise — 프로젝트 폴더 선택',
      properties: ['openDirectory'],
    })
    if (canceled || !filePaths[0]) return null
    // 다이얼로그가 곧 인가 수단이다 — 고른 순간 기억해 두고, 이후 IPC 는 이 목록만 받는다.
    rememberPickedRoot(filePaths[0])
    return filePaths[0]
  })

  ipcMain.handle('twixy-enterprise-admin-load', (_e, rendererRoot: string) => {
    const projectRoot = requirePickedRoot(rendererRoot, pickedRoots())
    const todayStr = new Date().toISOString().slice(0, 10)
    const monthStr = new Date().toISOString().slice(0, 7)
    const usersDir = path.join(projectRoot, 'users')
    const sharedSkillsDir = path.join(projectRoot, 'shared', 'skills')

    type PlanRow = {
      id: string; uid: string; title: string
      status: string; updatedAt: string; createdAt: string
      skillsReferenced: string[]
    }
    const allPlans: PlanRow[] = []

    if (fs.existsSync(usersDir)) {
      for (const uid of fs.readdirSync(usersDir)) {
        const plansDir = path.join(usersDir, uid, 'plans')
        if (!fs.existsSync(plansDir)) continue
        let entries: string[]
        try { entries = fs.readdirSync(plansDir) } catch { continue }
        for (const planId of entries) {
          const jsonPath = path.join(plansDir, planId, 'plan.json')
          if (!fs.existsSync(jsonPath)) continue
          try {
            const p = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
            allPlans.push({
              id: p.id ?? planId,
              uid,
              title: p.title ?? '',
              status: p.status ?? '',
              updatedAt: p.updatedAt ?? '',
              createdAt: p.createdAt ?? '',
              skillsReferenced: Array.isArray(p.skillsReferenced) ? p.skillsReferenced : [],
            })
          } catch { /* skip corrupt */ }
        }
      }
    }

    const todayPlans = allPlans.filter(
      p => p.updatedAt.startsWith(todayStr) || p.createdAt.startsWith(todayStr)
    )
    const todaySkills = [...new Set(todayPlans.flatMap(p => p.skillsReferenced))]

    const donePlansToday = allPlans
      .filter(p => p.status === 'done' && p.updatedAt.startsWith(todayStr))
      .map(({ id, uid, title, updatedAt, skillsReferenced }) =>
        ({ id, uid, title, updatedAt, skillsReferenced })
      )

    const skillCount: Record<string, number> = {}
    allPlans
      .filter(p => p.updatedAt.startsWith(monthStr) || p.createdAt.startsWith(monthStr))
      .flatMap(p => p.skillsReferenced)
      .forEach(s => { skillCount[s] = (skillCount[s] ?? 0) + 1 })
    const topSkillsThisMonth = Object.entries(skillCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => ({ name, count }))

    const newSkillsThisMonth: { name: string; mtime: string }[] = []
    if (fs.existsSync(sharedSkillsDir)) {
      for (const name of fs.readdirSync(sharedSkillsDir)) {
        try {
          const stat = fs.statSync(path.join(sharedSkillsDir, name))
          if (stat.isDirectory() && stat.mtime.toISOString().startsWith(monthStr)) {
            newSkillsThisMonth.push({ name, mtime: stat.mtime.toISOString() })
          }
        } catch { /* skip */ }
      }
    }

    const allDonePlans = allPlans
      .filter(p => p.status === 'done')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(({ id, uid, title, updatedAt, skillsReferenced }) =>
        ({ id, uid, title, updatedAt, skillsReferenced })
      )

    return {
      projectRoot,
      todaySkills,
      donePlansToday,
      topSkillsThisMonth,
      newSkillsThisMonth,
      allDonePlans,
    }
  })

}
