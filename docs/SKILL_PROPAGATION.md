# 스킬 전파 — `.tskill` 한 줄 고치면 실제로 어디까지 가나

> **대상:** Twixy 팀
> **한 줄:** 스킬 소스는 한 곳인데 그 아래 캐시가 셋이고, 그중 둘은 **한 번 채워지면 다시는 갱신되지 않는다.** 고쳤는데 안 바뀌는 이유는 거의 항상 여기다.
> **상태:** 현재 동작 기술 + 실측. **미해결 3건** (§6).
> **관련:** [ADDING_A_TOOL_SKILL.md](ADDING_A_TOOL_SKILL.md) (런북 작성법) · [FILE_INGEST.md](FILE_INGEST.md) (같은 부류의 조용한 스킵)

---

## 1. 왜 이 문서가 있나

2026-08-13, `skills/instagram` 의 런북과 TSL 컴파일러 버그를 고쳤다. 레포에서 컴파일까지
확인했고 섹션 4개가 정상으로 나왔다. 그런데 앱을 재시작한 뒤에도 에이전트는 **8월 11일자
깨진 런북**을 계속 읽고 있었다.

세 지점을 나란히 재보고 나서야 원인이 보였다.

```
레포 skills/instagram/      4 섹션  ✅  (고친 것)
shared/skills/instagram/    4 섹션  ✅  (재시작 때 갱신됨)
users/<uid>/skills/instagram/  1 섹션  ❌  (8월 11일자 그대로)
```

`shared` 까지는 왔는데 마지막 한 홉을 못 건넜다. 실패가 아니라 **의도된 스킵**이었고,
로그도 경고도 없었다. 재시작을 몇 번 하든 결과는 같다.

---

## 2. 전체 경로 — 홉 4개, 캐시 3개

```
① skills/<name>/<name>.tskill          ← 사람이 고치는 유일한 파일
        │
        │  ⚠️ 자동화 없음. 손으로 컴파일해야 한다 (§3 밸브 1)
        ▼
② skills/<name>/SKILL.md               ← 레포에 커밋되는 산출물. 실제로 배포되는 건 이것
        │
        │  electron-builder extraResources: { from: "skills", to: "skills" }
        ▼
③ Twixy.app/Contents/Resources/skills/ ← 패키징 산출물 (dev 에서는 레포 skills/ 를 직접 참조)
        │
        │  seedSharedFromBundle()  — 매 기동. 무조건 덮어씀 ✅
        ▼
④ <projectRoot>/shared/skills/         ← 팀 공유 계층
        │
        │  projectSharedIntoUser()  — ⚠️ 없는 것만 복사. 절대 덮지 않음 (§3 밸브 2)
        ▼
⑤ <projectRoot>/users/<uid>/skills/    ← 에이전트가 실제로 읽는 곳
        │
        │  compileTskillFiles()  — ⚠️ mtime 게이트가 항상 닫혀 있음 (§3 밸브 3)
        │  regenerateSkillsIndex() → 워크스페이스 SKILLS.md (절대경로 인덱스)
        ▼
   에이전트: SKILLS.md 에서 경로를 찾아 <workspace>/skills/<name>/SKILL.md 를 연다
```

dev 와 prod 의 차이는 ③ 하나뿐이다. `isDev` 면 번들 소스가 `path.join(__dirname, '..', 'skills')`
= 레포 `skills/`, 아니면 `process.resourcesPath/skills`. ④ 이후는 완전히 동일하다.

`startSkillsWatcher` 가 fs 이벤트 + 30초 폴링으로 `recompileAndNotify` 를 돌리는데, 이것도
같은 `seedSharedFromBundle → projectSharedIntoUser` 를 부른다. **즉 워처가 있어도 밸브 2는
그대로다** — 새 스킬은 재기동 없이 들어오지만, 이미 있는 스킬은 영원히 안 바뀐다.

---

## 3. 일방통행 밸브 3개

### 밸브 1 — `.tskill` → `SKILL.md` 는 레포에서 자동 컴파일되지 않는다

`compileTskillFiles()` 가 호출되는 곳은 **워크스페이스 skills 디렉토리뿐**이다
([main.ts:1018](electron/main.ts:1018), 워처의 `customDir`). 레포의 `skills/` 는 아무도 안 본다.
`npm run build` 도 `prepare:openclaw → tsc → vite build` 뿐이라 tskill 컴파일 단계가 없다.

> **결과:** `.tskill` 만 고치고 커밋하면 **낡은 `SKILL.md` 가 그대로 배포된다.** 실제로 배포되는
> 것은 ②이지 ①이 아니다.

이게 instagram 런북이 깨진 채로 오래 살아남은 이유이기도 하다 — 컴파일러 버그로 잘린
`SKILL.md` 가 한 번 커밋된 뒤, 소스를 볼 일이 없으니 아무도 재컴파일하지 않았다.

### 밸브 2 — `shared` → `user` 는 "없는 것만" 복사한다

```ts
// main.ts:703  projectSharedIntoUser()
if (fs.existsSync(dst)) continue  // never overwrite — user may have edited
```

버전 비교도, 해시 비교도, 로그도 없다. 워크스페이스에 그 이름의 디렉토리가 있으면 끝이다.

> **결과:** 스킬 수정은 **새 워크스페이스에만 도달한다.** 기존 워크스페이스는 첫 기동 때 받은
> 버전에 영구히 고정된다.

의도는 분명하다 — 유저가 워크스페이스에서 스킬을 고쳤을 수 있으니 파괴하지 않는다. 문제는
"고쳤다" 와 "그냥 낡았다" 를 구분할 방법이 없다는 것이다. 지금은 후자도 전자로 취급된다.

### 밸브 3 — 워크스페이스 재컴파일은 mtime 게이트가 항상 닫는다

```ts
// main.ts:1063
if (!force && fs.existsSync(outPath)) {
  const outMtime = fs.statSync(outPath).mtimeMs
  if (outMtime >= srcMtime) continue          // SKILL.md 가 더 최신이면 건너뜀
}
...
const after = new Date(srcMtime + 100)         // 컴파일 직후 mtime 을 src+100ms 로 고정
fs.utimesSync(outPath, after, after)
```

`SKILL.md` 의 mtime 을 항상 소스보다 **뒤로 고정**하므로, 한 번 컴파일된 뒤에는 게이트가 다시
열리지 않는다. (mtime 고정 자체는 macOS FSEvents 피드백 루프를 막으려는 것으로, 이유는 타당하다.)

> **결과:** 워크스페이스에 낡은 `.tskill` 이 있어도 **새 컴파일러로 다시 컴파일되지 않는다.**
> 컴파일러 버그를 고쳐도 기존 워크스페이스의 산출물은 깨진 채로 남는다.

---

## 4. 그래서 스킬을 고칠 때 실제로 해야 하는 일

```bash
# 1) 소스 수정
$EDITOR skills/instagram/instagram.tskill

# 2) 컴파일 — 자동화가 없으므로 반드시 손으로 (밸브 1)
node -e "
const {compileTSL}=require('./dist-electron/electron/tsl-compiler'), fs=require('fs')
const n='instagram'
const r=compileTSL(fs.readFileSync(\`skills/\${n}/\${n}.tskill\`,'utf8'), n+'.tskill')
if(!r.ok){console.error(r.errors);process.exit(1)}
fs.writeFileSync(\`skills/\${n}/SKILL.md\`, r.markdown)
console.log('sections:', (r.markdown.match(/^### /gm)||[]).length)
"

# 3) 컴파일 산출물이 멀쩡한지 확인 — 섹션 수와 evaluate 스니펫이 온전한지
#    (§5 의 "컴파일 결과가 깨졌다" 참고)

# 4) 기존 워크스페이스에 반영 (밸브 2) — 둘 중 하나
rm -rf "<projectRoot>/users/<uid>/skills/instagram"     # 지우고 재기동 → 다시 프로젝션
# 또는 직접 복사 후 SKILL.md 를 더 최신으로 (밸브 3 회피)
cp "<projectRoot>/shared/skills/instagram/"{SKILL.md,instagram.tskill} \
   "<projectRoot>/users/<uid>/skills/instagram/" && \
   touch "<projectRoot>/users/<uid>/skills/instagram/SKILL.md"
```

4번의 `touch` 가 필요한 이유: `.tskill` 이 `SKILL.md` 보다 최신이면 앱이 재컴파일을 시도하는데,
**돌고 있는 앱이 옛 컴파일러를 들고 있으면 방금 고친 것을 다시 깨뜨린다.**

---

## 5. 증상별 진단

가장 먼저 할 일은 **세 지점을 동시에 재는 것**이다. 어느 홉에서 멈췄는지가 바로 나온다.

```bash
R="<projectRoot>"; U="$R/users/<uid>"
for p in "skills/instagram/SKILL.md" \
         "$R/shared/skills/instagram/SKILL.md" \
         "$U/skills/instagram/SKILL.md"; do
  echo "$(grep -c '^### ' "$p") 섹션  $p"
done
```

| 증상 | 막힌 곳 | 확인 |
|---|---|---|
| 레포 `SKILL.md` 가 `.tskill` 수정을 반영 못 함 | 밸브 1 | `SKILL.md` mtime < `.tskill` mtime |
| shared 는 최신인데 user 만 낡음 | 밸브 2 | 위 3점 측정에서 앞 둘만 일치 |
| 컴파일러를 고쳤는데 워크스페이스 산출물이 그대로 | 밸브 3 | `SKILL.md` mtime ≥ `.tskill` mtime |
| shared 도 낡음 | 패키징 | prod 면 앱 버전 확인, dev 면 레포 `SKILL.md` 확인 |
| 컴파일 결과가 깨짐 (섹션 1개로 뭉침) | 컴파일러 | 스니펫이 잘렸는지 — [FILE_INGEST.md](FILE_INGEST.md) 와 같은 부류 |

마지막 줄은 실제 사례다. `stripComments` 가 정규식 리터럴의 `\//` 를 주석으로 보고 라인을
잘라내면 중괄호가 안 맞아 뒤따르는 STAGE 가 전부 앞 블록에 흡수된다. **섹션 수가 갑자기
1개로 줄면 컴파일러가 소스를 잘랐다고 보면 된다.** (2026-08-14 수정됨)

---

## 6. 미해결

**① 밸브 2 가 조용하다.** 스킵할 때 로그 한 줄이 없다. 최소한 이 정도는 찍혀야 한다:

```
[twixy/project] skipped instagram — user copy exists (shared is newer by 3 versions)
```

지금은 "고친 게 왜 안 먹지" 를 알아내려면 파일 세 개를 손으로 비교하는 수밖에 없다.

**② 갱신 경로가 아예 없다.** 로컬 수정을 보존하려는 의도는 옳지만, 그렇다면 "유저가 고쳤는지"
를 실제로 판정해야 한다. 프로젝션 시점의 해시를 남겨두면 세 경우가 구분된다 —
안 건드림(=덮어도 안전) / 건드림(=충돌 표시) / 동일(=할 일 없음). 지금은 셋 다 "스킵" 이다.

**③ 밸브 1 이 빌드에 없다.** `npm run build` 가 `skills/**/*.tskill` 을 컴파일하고, 산출물이
커밋된 `SKILL.md` 와 다르면 실패시키면 된다. 그러면 낡은 산출물이 배포되는 일이 구조적으로
불가능해진다. 지금은 사람이 기억해야 하고, 실제로 잊혀서 깨진 런북이 오래 살아남았다.

---

## 7. 설계 의도와 대가

이 구조가 이상한 게 아니라는 점은 짚어둘 만하다. 3계층(bundle → shared → user)은
팀 공유를 위한 것이다 — `shared` 는 팀원끼리 스킬을 주고받는 자리고, `user` 는 각자가
손댈 수 있는 작업본이다. 작업본을 말없이 덮어쓰는 것은 확실히 더 나쁘다.

대가는 **기본값이 "영원히 안 바뀜" 이라는 것**이다. 스킬을 고치는 사람은 자기 수정이
배포됐다고 믿고, 워크스페이스는 첫 기동 때의 버전을 계속 쓴다. 둘 다 아무 신호를 못 받는다.

이 레포에서 반복적으로 나오는 실패 모양 그대로다 — 실패가 아니라 **조용한 스킵**이고,
다음 단계가 낡은 것을 최신인 줄 알고 쓴다.
