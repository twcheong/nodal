// 드롭한 파일의 이름이 살아남는지 — npx tsx scripts/checkImportName.ts
//
// 규칙을 여기 베껴 쓰지 않고 main.ts 소스에서 **그대로 뽑아** 돌린다. 베껴
// 쓰면 원본이 바뀌어도 테스트는 통과하는 가짜 검사가 된다.
//
// 왜 검사가 필요한가(2026-09-15 실사고): 이름을 `[^A-Za-z0-9._-]` → '_' 로
// 씻던 시절, 한국어 파일 여섯 장이 전부 '______.png' 로 도착했다. 사용자는
// "지난번.png 를 2페이지, 라이팅엔무드.png 를 5페이지" 라고 정확히 지시했는데
// 모델에게는 구분 불가능한 밑줄 뭉치뿐이라 이미지가 아무 데나 배치됐다.
// 지시 불이행처럼 보였지만 원인은 파일 이름이었다.
import fs from 'node:fs'
import path from 'node:path'

// 아래 정규식은 '\n' 을 그대로 쓴다. Windows(core.autocrlf=true) 체크아웃은 CRLF 라
// 정규화하지 않으면 "sanitizer block not found" 로 죽는다 — 규칙이 아니라 줄끝 때문에.
const src = fs.readFileSync(path.resolve(__dirname, '../electron/main.ts'), 'utf8').replace(/\r\n/g, '\n')
const block = /const safeBase = path\.basename\(payload\.name\)\n([\s\S]*?)\n    if \(!safeBase\)/.exec(src)
if (!block) throw new Error('sanitizer block not found in main.ts')
const clean: (n: string) => string = new Function('path', 'name',
  `return path.basename(name)\n${block[1]}`) as never as (n: string) => string
const run = (n: string) => (clean as unknown as (p: typeof path, n: string) => string)(path, n)

let fail = 0
const ok = (c: boolean, m: string) => { console.log(`${c ? '  ok  ' : '  FAIL'} ${m}`); if (!c) fail++ }

// ① 사용자가 실제로 첨부한 이름들 — 서로 구분 가능해야 한다
const real = ['지난번.png', '라이팅엔무드.png', '액팅 마이크 소품.png', '샷참조이미지.png',
              'Reference_D.O._1.png', 'Reference_D.O_3.png']
const cleaned = real.map(run)
cleaned.forEach((c, i) => console.log(`     ${JSON.stringify(real[i]).padEnd(26)} → ${JSON.stringify(c)}`))
ok(new Set(cleaned).size === real.length, `여섯 장이 서로 다른 이름으로 남는다 (${new Set(cleaned).size}/6)`)
ok(cleaned.every((c) => !/^_+\.png$/.test(c)), '밑줄 뭉치로 뭉개지지 않는다')
ok(run('지난번.png') === '지난번.png', '한글 이름은 그대로')
ok(run('액팅 마이크 소품.png') === '액팅_마이크_소품.png', '공백만 _ 로 (경로 토큰이 잘리지 않게)')

// ② 안전 — 경로 탈출·예약문자·숨김파일
ok(!run('../../../etc/passwd').includes('/'), '경로 구분자는 남지 않는다')
ok(run('../../../etc/passwd') === 'passwd', `상위 경로는 basename 으로 떨어진다 (${run('../../../etc/passwd')})`)
ok(!/[<>:"/\\|?*]/.test(run('a:b*c?<>.png')), '윈도우 예약 문자 제거')
ok(!run('.hidden.png').startsWith('.'), '숨김파일로 만들지 않는다')
ok(run('   ') === '', '이름이 안 남으면 빈 문자열 → 호출부가 거부')
ok(run('가'.repeat(200) + '.png').length <= 80, '길이 상한 80')

console.log(fail ? `\n${fail} FAILED` : '\nall passed')
process.exit(fail ? 1 : 0)
