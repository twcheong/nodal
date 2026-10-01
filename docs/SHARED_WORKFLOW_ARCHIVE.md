# 공유 워크플로 — 팀 관리(archive) + admin 전용 영구 삭제

> **대상:** Twixy 개발팀
> **상태:** 코드 구현 완료 · **DB 마이그레이션 프로덕션 적용 완료** (2026-08-06) · 실계정 E2E 미검증
> **브랜치:** `feature/ui-ux-polish`

---

## 0. TL;DR

| | |
|---|---|
| 무엇이 바뀌나 | 팀 공유 워크플로를 **owner 가 아니어도 정리**할 수 있다 (archive / 복구 / 제목·설명·태그 편집) |
| 되돌릴 수 없는 삭제 | **org admin 만**, 그것도 **이미 archive 된 행만** (2단계) |
| WF 탭 "Unshare" | **"Archive"** 로 교체 — 더 이상 하드 삭제가 아니다. 버전 이력도 보존 |
| DB | `shared_workflows.archived_at / archived_by` + SECURITY DEFINER RPC 3종. `owner delete shared` RLS 정책 **삭제됨** |
| 이미 적용됨 | `supabase db push` 로 프로덕션(`mooltalmugrwzkvvawip`)에 적용 완료 — **구버전 빌드에 영향 있음(§6)** |
| 남은 일 | admin/member 계정 2개로 E2E (§7) |

---

## 1. 왜 바꿨나

기존 RLS 는 `shared_workflows` 의 UPDATE/DELETE 를 `owner_user_id = auth.uid()` 로 묶어놨다. 결과:

- 팀원이 남의 공유본 제목 오타를 못 고치고, 잘못 달린 태그도 못 바꾼다. 공유 워크플로는 팀 공용 자산인데 소유자만 손댈 수 있었다.
- WF 탭 "Unshare" 는 **즉시 하드 삭제**였다. `shared_workflow_versions` 가 FK cascade 로 함께 날아가 복구가 불가능했다. 되돌릴 수 없는 동작이 확인 다이얼로그 한 번 뒤에 있었다.

---

## 2. 새 권한 모델

| 동작 | 누가 | 경로 |
|---|---|---|
| 공유 / 재공유(스냅샷 갱신) | **owner 만** | 기존 그대로 — PostgREST upsert (RLS) |
| 제목 · 설명 · 태그 편집 | **org 멤버 누구나** | `update_shared_workflow_meta` RPC |
| Archive / 복구 | **org 멤버 누구나** | `set_shared_workflow_archived` RPC |
| 영구 삭제 | **org admin**, **archived 행만** | `delete_shared_workflow` RPC |

역할은 `organization_members.role` 의 `'admin' | 'member'` 두 가지뿐이다 (`'owner'` 역할은 존재하지 않음 — DB check 제약).

판정은 **org 별**로 한다. 대시보드는 여러 org 의 공유본을 한 그리드에 섞으므로 "어딘가의 admin"이 아니라 "그 행이 속한 org 의 admin"이어야 한다 → `useOrg().adminOrgIds` (신규) 를 쓰고, 기존 org-wide `isAdmin` 은 그대로 뒀다.

---

## 3. ★ 왜 전부 RPC 인가 (되돌리지 말 것)

비-owner 가 `supabase.from('shared_workflows').update(...)` 를 하면 **RLS 가 행을 필터링해서 에러 없이 0-row 성공**이 돌아온다. UI 는 "archive 됨"이라 표시하고, 새로고침하면 그대로 살아있다. 조용히 거짓말하는 실패다.

그래서 멤버 스코프 쓰기 3종은 전부 `security definer` RPC 로만 간다 — 기존 `record_shared_workflow_use` / `log_org_activity` 와 같은 패턴이다. 나중에 "간단하게" `.from().update()` 로 되돌리면 이 무음 실패가 재발한다.

반대로 RPC 가 없으면 PostgREST 가 `PGRST202` 를 주고 래퍼가 `throw` 하므로 실패가 시끄럽게 드러난다. 이게 의도된 비대칭이다.

---

## 4. 깨면 안 되는 불변조건 2개

### 4-1. `updated_at` 은 fork staleness 신호다

[`StaleCopyBanner.tsx`](../src/components/workflow/StaleCopyBanner.tsx) 가 `row.updated_at > sourceShared.copiedUpdatedAt` 로 "원본 업데이트됨" 배너를 띄운다. `updated_at` 의 의미는 **"owner 가 새 내용을 게시함"** 이지 "행이 아무렇게나 바뀜"이 아니다.

→ archive 도, 제목/설명/태그 편집도 `updated_at` 을 **건드리지 않는다**. 건드리면 팀원 전원의 fork 에 가짜 배너가 뜬다.

(전례: `20260710000000_org_activity.sql` 이 같은 이유로 `record_shared_workflow_use` 의 `updated_at` bump 를 제거했다. 사용 최신성은 `last_used_at` 이 따로 들고 있다.)

### 4-2. 버전 스냅샷 트리거를 오염시키지 않는다

`trg_snapshot_shared_workflow` 는 `when (OLD.workflow_json is distinct from NEW.workflow_json)` 조건부라, `workflow_json` 을 안 건드리면 발동하지 않는다.

→ 메타 편집은 `workflow_json` 을 patch 하지 **않는다**. 개명할 때마다 버전이 쌓이고 diff 뷰가 오염되는 걸 막기 위해서다.

**부작용(의도된 것):** `row.title` 이 `row.workflow_json.title` 과 갈라질 수 있다. 그래서 **표시·복사는 항상 row 레벨(팀이 큐레이션한) 값을 우선**한다:

```ts
// TeamDashboardPanel.tsx — SharedCard.copy()
title:       row.title || wf.title,
description: row.description ?? wf.description,
```

상세 모달도 "Current" 를 볼 때는 row 값, 옛 버전을 고르면 그 시점 스냅샷 값을 쓴다.

---

## 5. 변경 파일

### DB

| 파일 | 비고 |
|---|---|
| `~/Dev/X Viral Marketing Tool/supabase/migrations/20260806000000_shared_workflow_archive.sql` | **정본** — `supabase db push` 로 적용됨. 이후 수정 금지 |
| [`docs/supabase/shared_workflow_archive.sql`](supabase/shared_workflow_archive.sql) | 이 레포의 사본(문서용) |

내용:
- `shared_workflows.archived_at timestamptz`, `archived_by uuid` 추가
- `idx_shared_wf_org_active` — `where archived_at is null` 부분 인덱스
- `drop policy "owner delete shared"` — **하드 삭제 경로를 admin RPC 하나로 일원화**. owner INSERT/UPDATE 는 유지(upsert 재공유가 둘 다 필요)
- RPC 3종 (§2)
- `org_activity` action 어휘 확장: `archived` / `unarchived` / `deleted` / `edited` 추가. CHECK 이 **테이블 제약과 `log_org_activity` 함수 본문 두 곳**에 있어서 둘 다 넓혔다. `unshared` 는 과거 행 보존용으로 남겨뒀다(더 이상 안 찍힘)

RPC 에러 코드: `not_authenticated` / `not_in_org` / `not_an_admin` / `not_archived` / `title_too_long` / `description_too_long` / `too_many_tags`

### 클라이언트

| 파일 | 변경 |
|---|---|
| [`src/lib/sharedWorkflows.ts`](../src/lib/sharedWorkflows.ts) | `setSharedArchived` · `deleteSharedWorkflow` · `updateSharedMeta` 추가, **`unshareWorkflow` 삭제**. `SharedWorkflowRow` 에 `archived_at/by`. `OrgActivityAction` 확장 |
| [`src/hooks/useOrg.ts`](../src/hooks/useOrg.ts) | `adminOrgIds` 추가 (org별 admin 판정) |
| [`src/App.tsx`](../src/App.tsx) | `adminOrgIds` 를 `TeamDashboardPanel` 로 전달 |
| [`src/components/TeamDashboardPanel.tsx`](../src/components/TeamDashboardPanel.tsx) | 활성/보관 분리, 카드 `⋯` 메뉴, `EditSharedMetaModal`, 접히는 **Archived (n)** 구역, 태그 편집 owner 게이트 제거, `ACTION_LABEL` 확장 |
| [`src/components/workflow/ShareWorkflowButton.tsx`](../src/components/workflow/ShareWorkflowButton.tsx) | Unshare → Archive, 보관 상태면 `Archived · Re-share` |
| [`src/components/workflow/StaleCopyBanner.tsx`](../src/components/workflow/StaleCopyBanner.tsx) | archive 된 원본은 배너 숨김 |

### 알아둘 만한 구현 디테일

**재공유 = 자동 복구.** `shareWorkflow()` upsert payload 에 `archived_at: null, archived_by: null` 을 넣었다. conflict target 이 `(org_id, owner_user_id, source_wf_id)` 라 archive 된 행을 제자리에서 갱신하기 때문에, 이걸 안 지우면 owner 가 "공유 성공"을 보고도 갤러리에 안 나타난다.

**`findSharedRow` 는 archived 행도 돌려준다.** 일부러다. 걸러내면 owner 에게 "Share to team" 버튼이 보이고, 보이지 않는 archived 행에 upsert 하게 된다.

**`isOwner` 의 의미가 축소됐다.** 이제 두 가지에만 쓴다 — 카드의 `'You'` 라벨, 그리고 `saveTag` 의 로컬 디스크 write-back(그 워크플로 파일은 owner 머신에만 있으므로 이 가드는 유지).

**보관 카드에는 "Copy to my workflows" 가 없다.** 내려둔 템플릿을 계속 퍼뜨리면 archive 의 의미가 없다.

**Archived 는 필터 칩이 아니라 접힌 별도 구역**이다. 영구 삭제가 여기에만 있으므로 "다른 장소"처럼 보이는 편이 2단계 삭제의 의미를 살린다. 열림 상태는 `localStorage['twixy.team.archivedOpen']`.

---

## 6. ⚠ 구버전 빌드 영향

DB 는 이미 적용됐고 클라이언트는 아직 배포 전이다. 이 사이에 **기존에 설치된 빌드**는:

- archived 행을 계속 갤러리에 보여준다 (`archived_at` 을 모르니까)
- WF 탭 "Unshare" 가 **조용히 아무 일도 안 한다** — `owner delete shared` 정책이 사라져 0-row no-op

컬럼 추가는 additive 라 그 외 동작은 정상이다. 필드에 구버전이 돌고 있으면 릴리즈 노트에 한 줄 넣을 것.

---

## 7. 남은 검증 (실계정 E2E)

앱을 아직 띄워보지 않았다. `tsc --noEmit` / `npm run lint` / `npm run build` 는 통과했지만 런타임은 미확인이다.

**혼자 확인 가능**
1. `⋯` 메뉴 팝오버가 카드 클릭(상세 모달)과 충돌하지 않는지
2. Archived 구역 접힘/펼침 + localStorage 유지
3. 내 공유본 archive → 복구 → WF 탭 버튼이 `Archived · Re-share` ↔ `Shared ✓ · Update` 로 왕복하는지

**같은 org 의 admin(A) / member(M) 2계정 필요**

4. A 가 `⋯ → Edit details` 로 M 의 카드 개명 → 저장 → 새로고침 후 제목 유지, **`updated_at` 불변**(SQL 확인), `shared_workflow_versions` 새 행 없음
5. **M(일반 멤버)이 A 의 워크플로를 archive** → 양쪽 모두에서 이동 확인 ← *이번 변경의 핵심. RPC 경로가 실제로 뚫렸는지*
6. M 의 Archived 에는 Restore 만, Delete 없음. RPC 직접 호출해도 `not_an_admin`
7. A 에게만 Delete permanently. 활성 행 id 로 RPC 호출 시 `not_archived`
8. **가장 위험한 회귀:** 4번 전에 A 가 M 의 워크플로를 copy 해 둔다. 위 개명/archive 소동 후 A 의 사본을 열었을 때 "원본 업데이트됨" 배너가 **뜨면 안 된다**. 이후 M 이 진짜 수정본을 재공유하면 그때는 떠야 한다

**DB 확인 쿼리** (Supabase SQL editor)

```sql
select column_name from information_schema.columns
 where table_name='shared_workflows' and column_name in ('archived_at','archived_by');

select proname from pg_proc where proname in
 ('set_shared_workflow_archived','update_shared_workflow_meta','delete_shared_workflow');

select polname, cmd from pg_policies where tablename='shared_workflows';   -- delete 정책 없어야 함

select pg_get_constraintdef(oid) from pg_constraint
 where conrelid='public.org_activity'::regclass and contype='c';
```

배포 직후 PostgREST 프로브로 확인한 것: 세 RPC 모두 존재하며 미인증 호출에 `not_authenticated` 로 막히고, `log_org_activity` 가 `'archived'` 를 받아들이며(`invalid_action` 을 통과해 `not_in_org` 에서 멈춤), `archived_at`/`archived_by` 컬럼 조회가 성공한다.

---

## 8. 관련 문서

- [`docs/supabase/shared_workflow_archive.sql`](supabase/shared_workflow_archive.sql) — 이번 마이그레이션 사본
- [`docs/supabase/shared_workflow_versions.sql`](supabase/shared_workflow_versions.sql) — 버전 스냅샷 트리거 (§4-2)
- [`docs/TEAM_COLLAB_OPEN_QUESTIONS.md`](TEAM_COLLAB_OPEN_QUESTIONS.md) §4 "삭제 전파 정책" — 이번 변경이 그 Option B(비파괴)를 따른다
