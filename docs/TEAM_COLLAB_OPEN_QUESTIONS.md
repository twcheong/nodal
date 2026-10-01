# Team Collaboration — Open Questions

Phase 1 구현 시작 시점(2026-04-20)에 아직 확정되지 않은 설계 결정들. 각 Phase 진입 전에 답을 확정해야 함.

## 1. Init vs Clone UX (Phase 1~2 경계)

**질문**: owner가 프로젝트를 생성해 공유한 후, 다른 팀원이 합류할 때 경로는?

- Option A: **서버에서 clone** — owner가 서버에 push → 팀원은 서버 URL + projectId 입력 → 로컬로 pull
- Option B: **공유 폴더 attach** — owner가 Dropbox/iCloud 폴더 경로 공유 → 팀원은 그 폴더 선택만 하면 .twixy/config.json이 projectId 식별
- Option C: **둘 다 지원** — SetupScreen에서 "팀 프로젝트 합류" → "서버 URL" / "공유 폴더" 선택

**잠정**: Phase 2 말에 C로 가되, Phase 1은 B만 구현.

## 2. Blob 크기 상한 / chunk upload (Phase 3)

**질문**: 프로젝트 총량 100GB 가정 시 단일 MR 업로드 한도는?

- MR당 상한 (예: 2GB)?
- Presigned URL의 chunk upload (S3 multipart)?
- 클라이언트 측 resumable upload?

**잠정**: Phase 3에서 2GB/MR 상한, S3 multipart 도입.

## 3. APFS 외 파일시스템 fallback (Phase 1 필수)

**질문**: 외장 HDD(HFS+, exFAT) 사용 시 `COPYFILE_FICLONE_FORCE`가 `ENOTSUP` 반환 — fallback 순서?

**결정안**:
```
1차: fs.copyFile(src, dst, COPYFILE_FICLONE_FORCE)  // APFS COW
2차 (ENOTSUP 시): fs.copyFile(src, dst, COPYFILE_FICLONE)  // force 아님
3차 (여전히 실패): fs.copyFile(src, dst)  // 일반 복사
```
첫 번째 실패한 파일 기준으로 해당 `ensureWorkspace` 호출 전체를 3차 모드로 다운그레이드 (성능 최적화).

**Phase 1에 포함**. 잠정 결정으로 진행.

## 4. 삭제 전파 정책 (Phase 2)

**질문**: `shared/`에서 파일 삭제 MR이 머지되면 `user/`의 동일 파일은?

- Option A: **강제 삭제** — user가 개인적으로 수정했어도 덮어써짐 (destructive)
- Option B: **orphan 유지** — user/에는 남지만 `shared/`에서는 사라짐. `.twixy-overlay.json`이 "이 파일은 이제 공용이 아님"으로 마킹
- Option C: **사용자에게 선택 UI** — pull 시점에 "shared에서 삭제된 파일 N개, 로컬 유지/삭제?"

**잠정**: B가 non-destructive 원칙에 부합. Phase 2에서 확정.

## 5. 온프렘 Supabase 불가 (Phase 3)

**질문**: 엔터프라이즈 온프렘에서 Supabase 외부 접속 불가할 경우 auth?

- Option A: 서버가 **OIDC 프록시** 역할
- Option B: **API 토큰 모드** 병행 (어드민이 발급, 환경변수 주입)
- Option C: 서버 자체에 **로컬 auth** (간단한 JWT)

**잠정**: Phase 3에서 A+B 병행.

## 6. 바이너리 diff UI (Phase 2)

**질문**: MR 리뷰 시 이미지·PDF 변경을 어떻게 보여줄지?

**잠정 (MVP)**: before/after 썸네일 나란히 표시. PDF는 첫 페이지만. 상세 diff는 Phase 3+.

## 7. 동시 작성 중 상태 (Phase 2~3)

**질문**: A가 `data/raw/foo.png`를 수정 중일 때 B도 같은 파일을 편집하면 lost update 위험 — GitHub draft PR처럼 "작성 중" 상태를 서버에 알릴지?

**잠정**: Phase 2에서는 머지 시점에 `baseSnapshot` 검증으로 충돌 감지만. Phase 3에서 draft PR 도입 검토.

## 8. openclaw.json 처리 (Phase 1 즉시)

**질문**: `openclaw.json`은 user-local 전용 맞음? `workspace` 필드가 user 경로로 주입되니 절대 shared에 복사하면 안 됨.

**결정**: user-local. `ensureWorkspace`(electron/main.ts:411-490)가 `user/openclaw.json`에 쓰도록 하되, shared 초기 복사 대상에서 제외.

## 9. SOUL.md / AGENTS.md 공용 or 개인? (Phase 1)

**질문**: 현재 `ensureWorkspace`가 SOUL.md·AGENTS.md를 workspace 루트에 복사. 이건 공용 상수로 봐도 되나 개인 커스텀 허용?

**잠정**: Phase 1은 개인 파일(`user/`)로. 팀에서 공통 소울을 쓰고 싶다면 Phase 2에서 `shared/` 배치 + MR로 수정 플로우.

---

## 우선순위

**Phase 1 즉시 확정 필요**:
- #3 (APFS fallback) — 결정안대로 진행
- #8 (openclaw.json user-local) — 결정
- #9 (SOUL/AGENTS user-local) — 결정

**Phase 2 전에 확정**:
- #1 (Init vs Clone UX)
- #4 (삭제 전파)
- #6 (바이너리 diff UI)

**Phase 3 전에 확정**:
- #2 (chunk upload)
- #5 (온프렘 auth)
- #7 (동시 작성 상태)
