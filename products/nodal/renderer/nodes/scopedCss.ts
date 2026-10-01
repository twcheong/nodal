// 에디터 스타일을 에디터 영역 안에만 적용한다.
//
// 엔진 에디터(engine/apps/web/src/styles.css)는 독립 웹앱용이라 :root · * · html/body/#root · button
// 같은 전역 선택자를 쓴다. 그대로 import 하면 앱 전체(채팅·설정)의 글꼴·배경이 바뀐다. 원본을
// 고치지 않고(subtree 로 계속 받아야 하므로) 런타임에 모든 선택자 앞에 스코프를 붙인다.
//
// 브라우저의 CSS 파서(CSSStyleSheet)에 맡긴다 — 문자열 정규식으로 셀렉터를 자르면 :is(a, b)·
// 문자열 안의 쉼표·@media 중첩에서 틀린다.

/** 선택자 목록 하나를 스코프 아래로. :root·html·body·#root 는 스코프 요소 자신이 된다. */
export function scopeSelector(selectorText: string, scope: string): string {
  if (!scope) return selectorText   // 이미 스코프가 들어간 CSS (호스트 규칙)
  return splitSelectors(selectorText)
    .map((sel) => {
      const s = sel.trim()
      if (s === ':root' || s === 'html' || s === 'body' || s === '#root') return scope
      return `${scope} ${s}`
    })
    .join(', ')
}

/** 최상위 쉼표로만 자른다 — 괄호 안(:is(a, b))의 쉼표는 셀렉터 목록 구분자가 아니다. */
function splitSelectors(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') depth--
    else if (c === ',' && depth === 0) { out.push(text.slice(start, i)); start = i + 1 }
  }
  out.push(text.slice(start))
  return out.filter((s) => s.trim())
}

function scopeRules(rules: CSSRuleList, scope: string, out: string[]): void {
  for (const rule of Array.from(rules)) {
    if (rule instanceof CSSStyleRule) {
      out.push(`${scopeSelector(rule.selectorText, scope)} { ${rule.style.cssText} }`)
    } else if (rule instanceof CSSMediaRule) {
      const inner: string[] = []
      scopeRules(rule.cssRules, scope, inner)
      out.push(`@media ${rule.conditionText} { ${inner.join('\n')} }`)
    } else {
      // @keyframes · @font-face 등 — 선택자가 없으니 그대로.
      out.push(rule.cssText)
    }
  }
}

export function scopeCss(css: string, scope: string): string {
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(css)
  const out: string[] = []
  scopeRules(sheet.cssRules, scope, out)
  return out.join('\n')
}

const installed = new Set<string>()

/** <style> 로 한 번만 넣는다 (탭을 여러 번 열어도). */
export function installScopedCss(id: string, css: string, scope: string): void {
  if (installed.has(id)) return
  installed.add(id)
  const el = document.createElement('style')
  el.dataset.scopedCss = id
  el.textContent = scopeCss(css, scope)
  document.head.appendChild(el)
}
