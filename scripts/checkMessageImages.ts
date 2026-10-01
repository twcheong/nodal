// 올린 사진이 다음 턴에도 살아 있는지 — npx tsx scripts/checkMessageImages.ts
//
// 실사고(2026-09-16): 사용자가 사진 일곱 장을 붙여 덱을 만들고, 다음 턴에
// "살 붙이지 말고 그대로 다시" 라고만 했다. 그 메시지에는 경로가 없으니
// 모델에게 가는 사진 목록이 비었고, 모델은 기억에 남은 것만으로 덱을 다시 써서
// **마이크 소품 사진이 빠진 버전**이 나왔다.
//
// 첨부는 메시지가 아니라 대화에 속한다. 한 번 올린 사진은 그 대화 내내 쓸 수
// 있어야 한다.

import { buildMessageImageNote, imagePathsIn } from '../src/lib/messageImages'

let fail = 0
const ok = (c: boolean, m: string) => { console.log(`${c ? '  ok  ' : '  FAIL'} ${m}`); if (!c) fail++ }

const P = (n: string) => `data/raw/2026-09-16T14-35-01-${n}.png`
const FIRST = `@${P('지난번')} @${P('라이팅엔무드')} @${P('액팅_마이크_소품')}\n커버곡 제안서 만들어줘`
const prior = [{ role: 'user' as const, content: FIRST }, { role: 'assistant' as const, content: '8장으로 정리했어요' }]

// ① 한글 경로를 찾는다 (ASCII 전용 정규식이면 여기서 0건이 된다)
ok(imagePathsIn(FIRST).length === 3, `한글 파일명 3장 인식 (${imagePathsIn(FIRST).length})`)
ok(imagePathsIn(FIRST).every((p) => !p.startsWith('@')), '@ 는 떼고 경로만')

// ② 이번 메시지에 경로가 없어도 이전 첨부가 따라온다 — 이게 실사고 수정
{
  const note = buildMessageImageNote('살 붙이지말고 그냥 이대로 다시 만들어줘', prior)
  ok(note.includes(P('액팅_마이크_소품')), '경로를 다시 안 써도 마이크 소품 사진이 목록에 남는다')
  ok(note.includes('Attached earlier in this conversation'), '"예전에 붙인 것" 으로 구분해 적는다')
  ok(!note.includes('Attached with this message'), '이번에 새로 붙인 게 없으면 그 머리말은 안 쓴다')
}

// ③ 새로 붙인 것과 예전 것을 섞지 않는다
{
  const note = buildMessageImageNote(`@${P('샷참조이미지')} 이거 추가`, prior)
  ok(note.indexOf('Attached with this message') < note.indexOf('Attached earlier'), '새 것이 먼저, 예전 것이 뒤')
  ok(note.includes(P('샷참조이미지')) && note.includes(P('지난번')), '둘 다 들어간다')
  const dup = (note.match(new RegExp(P('샷참조이미지').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length
  ok(dup === 1, `같은 경로를 두 번 적지 않는다 (${dup})`)
}

// ④ 사진이 없으면 아무것도 안 붙인다 (모든 메시지에 군더더기를 달지 않는다)
ok(buildMessageImageNote('매출 정리해줘', [{ role: 'user', content: '안녕' }]) === '', '사진 없으면 빈 문자열')

// ⑤ 볼 수 없다는 사실을 반드시 말한다 — 빌더는 vision 이 없다
ok(buildMessageImageNote(FIRST).includes('CANNOT see them'), '내용을 지어내지 말라는 경고 포함')

// ⑥ 어시스턴트가 쓴 경로는 가져오지 않는다 (모델이 지어낸 경로 유입 차단)
{
  const note = buildMessageImageNote('다시', [{ role: 'assistant', content: `@${P('모델이_지어낸것')}` }])
  ok(note === '', '어시스턴트 메시지의 경로는 첨부로 치지 않는다')
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed')
process.exit(fail ? 1 : 0)
