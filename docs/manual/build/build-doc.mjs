import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { marked } from 'marked'

const ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const b64 = (p) => fs.readFileSync(path.join(ROOT, p)).toString('base64')

const SERIF = b64('node_modules/@fontsource-variable/source-serif-4/files/source-serif-4-latin-wght-normal.woff2')
const MONO  = b64('node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2')
const MONO5 = b64('node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2')

export const CSS = `
@font-face{font-family:'Source Serif 4';src:url(data:font/woff2;base64,${SERIF}) format('woff2-variations');font-weight:200 900;font-style:normal;font-display:swap}
@font-face{font-family:'Plex Mono';src:url(data:font/woff2;base64,${MONO}) format('woff2');font-weight:400;font-style:normal;font-display:swap}
@font-face{font-family:'Plex Mono';src:url(data:font/woff2;base64,${MONO5}) format('woff2');font-weight:500;font-style:normal;font-display:swap}

:root{
  --paper:#fafaf6; --card:#ffffff; --sunk:#f2f4ef;
  --hair:#d9e1da; --hair-strong:#c3cfc6;
  --ink:#14201b; --ink-2:#4a594f; --ink-3:#8a968d;
  --petrol:#0d5c50; --petrol-deep:#093f37; --mint:#e4f0e9;
  --clay:#b5482f; --clay-bg:#f9ece8;
  --ochre:#8f6513; --ochre-bg:#f7f0df;
  --sel:#dcece4;
  --sans:'Pretendard Variable','Pretendard',-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Malgun Gothic','Segoe UI',sans-serif;
  --serif:'Source Serif 4',Cambria,Georgia,serif;
  --mono:'Plex Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --paper:#0e1512; --card:#151d19; --sunk:#1b241f;
  --hair:#28332d; --hair-strong:#3a4740;
  --ink:#e8efe9; --ink-2:#a8b6ac; --ink-3:#77857b;
  --petrol:#5cbfa6; --petrol-deep:#8ad8c2; --mint:#16332c;
  --clay:#e08d72; --clay-bg:#301b15;
  --ochre:#d3a54a; --ochre-bg:#2c2413;
  --sel:#1d3a32;
}}
:root[data-theme="dark"]{
  --paper:#0e1512; --card:#151d19; --sunk:#1b241f;
  --hair:#28332d; --hair-strong:#3a4740;
  --ink:#e8efe9; --ink-2:#a8b6ac; --ink-3:#77857b;
  --petrol:#5cbfa6; --petrol-deep:#8ad8c2; --mint:#16332c;
  --clay:#e08d72; --clay-bg:#301b15;
  --ochre:#d3a54a; --ochre-bg:#2c2413;
  --sel:#1d3a32;
}

*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--sans);
  font-size:16px;line-height:1.75;-webkit-font-smoothing:antialiased;word-break:keep-all;overflow-wrap:break-word}
::selection{background:var(--sel);color:var(--ink)}

.wrap{max-width:1180px;margin:0 auto;padding:0 28px;display:grid;grid-template-columns:232px minmax(0,1fr);gap:56px;align-items:start}
.single .wrap{grid-template-columns:minmax(0,1fr);max-width:760px}

/* ── masthead ── */
.mast{grid-column:1/-1;padding:64px 0 28px;border-bottom:1px solid var(--hair);margin-bottom:48px}
.brandline{display:flex;align-items:center;gap:10px;margin-bottom:26px}
.mark{width:15px;height:15px;border:1.5px solid var(--petrol);border-radius:50%;position:relative;flex:none}
.mark::after{content:"";position:absolute;inset:3.5px;background:var(--petrol);border-radius:50%}
.brandline b{font-family:var(--serif);font-weight:600;font-size:15px;letter-spacing:.14em;text-transform:uppercase;color:var(--petrol)}
.mast h1{font-size:clamp(30px,4.6vw,46px);line-height:1.22;margin:0 0 14px;font-weight:700;letter-spacing:-.018em;text-wrap:balance}
.mast .lede{font-size:18px;color:var(--ink-2);margin:0;max-width:60ch;line-height:1.65}
.meta{display:flex;flex-wrap:wrap;gap:8px;margin-top:26px}
.meta span{font-size:12.5px;font-variant-numeric:tabular-nums;color:var(--ink-2);
  border:1px solid var(--hair);border-radius:999px;padding:4px 11px;background:var(--card)}

/* ── table of contents ── */
nav.toc{position:sticky;top:20px;max-height:calc(100vh - 40px);overflow-y:auto;
  padding-bottom:40px;font-size:13.5px;line-height:1.5}
nav.toc .tlabel{font-family:var(--serif);font-size:11.5px;font-weight:600;letter-spacing:.16em;
  text-transform:uppercase;color:var(--ink-3);padding-bottom:10px;margin-bottom:12px;border-bottom:1px solid var(--hair)}
nav.toc a{display:flex;gap:9px;text-decoration:none;color:var(--ink-2);padding:5px 0;border-radius:4px}
nav.toc a .n{font-family:var(--serif);font-variant-numeric:tabular-nums;color:var(--ink-3);flex:none;min-width:14px;font-weight:600}
nav.toc a:hover{color:var(--petrol)}
nav.toc a:hover .n{color:var(--petrol)}
nav.toc a:focus-visible{outline:2px solid var(--petrol);outline-offset:2px}

/* ── article ── */
article{min-width:0;padding-bottom:100px}
article h2{font-size:26px;line-height:1.3;font-weight:700;letter-spacing:-.014em;
  margin:72px 0 20px;padding-top:26px;border-top:2px solid var(--ink);text-wrap:balance;scroll-margin-top:20px}
article h2:first-child{margin-top:0;border-top:none;padding-top:0}
article h3{font-size:18.5px;font-weight:650;margin:42px 0 12px;letter-spacing:-.008em;text-wrap:balance;scroll-margin-top:20px}
article h4{font-size:15.5px;font-weight:650;margin:28px 0 8px;color:var(--ink-2)}
article p{margin:0 0 17px;max-width:66ch}
article ul,article ol{margin:0 0 18px;padding-left:22px;max-width:66ch}
article li{margin:0 0 7px}
article li::marker{color:var(--ink-3)}
article strong{font-weight:650}
article hr{border:none;border-top:1px solid var(--hair);margin:56px 0}
article a{color:var(--petrol);text-underline-offset:2px}

/* inline code = literal on-screen text */
article :not(pre)>code{font-family:var(--mono);font-size:.855em;background:var(--sunk);
  border:1px solid var(--hair);border-radius:5px;padding:.1em .38em;color:var(--ink);white-space:nowrap}

/* prompt blocks */
pre{background:var(--card);border:1px solid var(--hair);border-left:2.5px solid var(--petrol);
  border-radius:0 var(--r,8px) var(--r,8px) 0;padding:16px 18px;overflow-x:auto;margin:0 0 20px;max-width:66ch}
pre code{font-family:var(--mono);font-size:13px;line-height:1.65;color:var(--ink);white-space:pre}

/* callouts */
blockquote{margin:0 0 22px;max-width:66ch;background:var(--mint);border:1px solid transparent;
  border-left:2.5px solid var(--petrol);border-radius:0 8px 8px 0;padding:14px 18px;color:var(--ink)}
blockquote p{margin:0 0 8px}
blockquote p:last-child{margin:0}
blockquote.warn{background:var(--clay-bg);border-left-color:var(--clay)}
blockquote.plan{background:var(--ochre-bg);border-left-color:var(--ochre)}
blockquote.quote{background:var(--sunk);border-left-color:var(--hair-strong);color:var(--ink-2);font-style:normal}

/* tables */
.tw{overflow-x:auto;margin:0 0 24px;border:1px solid var(--hair);border-radius:10px;background:var(--card)}
table{border-collapse:collapse;width:100%;font-size:14.5px;line-height:1.6}
th,td{text-align:left;padding:11px 15px;border-bottom:1px solid var(--hair);vertical-align:top}
th{font-weight:650;font-size:12px;letter-spacing:.05em;text-transform:uppercase;
  color:var(--ink-2);background:var(--sunk);white-space:nowrap}
tr:last-child td{border-bottom:none}
td code{white-space:nowrap}
td strong{color:var(--ink)}

/* status glyphs in comparison table */
td:has(>strong:only-child){font-variant-numeric:tabular-nums}

/* embedded screenshots */
figure.shot-fig{margin:0 0 26px;max-width:100%}
figure.shot-fig img{display:block;width:100%;max-width:820px;height:auto;border:1px solid var(--hair);border-radius:10px;box-shadow:0 2px 10px rgba(0,0,0,.06)}
figure.shot-fig figcaption{font-size:12.5px;color:var(--ink-3);margin-top:8px;line-height:1.5}

/* figure placeholder for screenshots */
.shot{border:1px dashed var(--hair-strong);border-radius:10px;background:var(--sunk);
  padding:22px;margin:0 0 24px;max-width:66ch}
.shot .cap{font-family:var(--mono);font-size:11.5px;letter-spacing:.04em;text-transform:uppercase;color:var(--ink-3);margin-bottom:6px}
.shot .what{font-size:14px;color:var(--ink-2);margin:0}

footer{grid-column:1/-1;border-top:1px solid var(--hair);padding:26px 0 60px;
  font-size:13px;color:var(--ink-3);display:flex;flex-wrap:wrap;gap:14px;justify-content:space-between}
footer .mono{font-family:var(--mono);font-size:12px}

@media (max-width:900px){
  .wrap{grid-template-columns:minmax(0,1fr);gap:0}
  nav.toc{position:static;max-height:none;margin-bottom:44px;
    border:1px solid var(--hair);border-radius:10px;padding:16px 18px;background:var(--card)}
  nav.toc .tlabel{border-bottom:none;padding-bottom:6px;margin-bottom:6px}
  .mast{padding-top:44px}
  article h2{margin-top:56px}
}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`

// inline manual screenshots as data-URI figures
export function inlineImages(html, dir) {
  return html.replace(/<p><img src="images\/([^"]+)" alt="([^"]*)"\s*\/?>(<\/p>)?/g, (m, file, alt) => {
    const fp = path.join(dir, 'images', file)
    if (!fs.existsSync(fp)) return `<figure class="shot-fig"><figcaption>[스크린샷 준비 중: ${file}] ${alt}</figcaption></figure>`
    const uri = 'data:image/png;base64,' + fs.readFileSync(fp).toString('base64')
    return `<figure class="shot-fig"><img src="${uri}" alt="${alt}"><figcaption>${alt}</figcaption></figure>`
  })
}

// ── markdown → styled html ────────────────────────────────────────────
export function render(md) {
  const toc = []
  const renderer = new marked.Renderer()

  renderer.heading = function (token) {
    const depth = token.depth
    const text = this.parser.parseInline(token.tokens)
    const plain = text.replace(/<[^>]+>/g, '')
    if (depth === 2) {
      const m = plain.match(/^(\d+|부록)\.\s*(.+)$/)
      const id = 'ch-' + (toc.length + 1)
      toc.push({ id, n: m ? m[1] : '', t: m ? m[2] : plain })
      return `<h2 id="${id}">${text}</h2>\n`
    }
    if (depth === 3) {
      const id = 'h-' + plain.replace(/[^\wㄱ-힣]+/g, '-').toLowerCase().slice(0, 40)
      return `<h3 id="${id}">${text}</h3>\n`
    }
    return `<h${depth}>${text}</h${depth}>\n`
  }

  renderer.table = function (token) {
    const head = '<tr>' + token.header.map(c =>
      `<th>${this.parser.parseInline(c.tokens)}</th>`).join('') + '</tr>'
    const body = token.rows.map(r => '<tr>' + r.map(c =>
      `<td>${this.parser.parseInline(c.tokens)}</td>`).join('') + '</tr>').join('\n')
    return `<div class="tw"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>\n`
  }

  renderer.blockquote = function (token) {
    const inner = this.parser.parse(token.tokens)
    const t = inner.replace(/<[^>]+>/g, '')
    let cls = ''
    const isScreen = /^[A-Z{▶⊕◧✎✕]/.test(t.trim()) && !/[가-힣]/.test(t.slice(0, 40))
    if (isScreen) cls = ' class="quote"'
    else if (/준비 중|아직 기능이 없|예정입니다/.test(t)) cls = ' class="plan"'
    else if (/주의|못 |못합|안 됩니다|없습니다|사라집니다|막힙니다|초과|까지만|반드시|불가/.test(t)) cls = ' class="warn"'
    return `<blockquote${cls}>${inner}</blockquote>\n`
  }

  const html = marked.parse(md, { renderer, gfm: true, breaks: false })
  return { html, toc }
}

export function page({ title, eyebrow, h1, lede, meta, html, toc, single }) {
  const nav = single ? '' : `<nav class="toc"><div class="tlabel">목차</div>${
    toc.map(i => `<a href="#${i.id}"><span class="n">${i.n}</span><span>${i.t}</span></a>`).join('')
  }</nav>`
  return `<title>${title}</title>
<style>${CSS}</style>
<div class="${single ? 'single' : ''}">
<div class="wrap">
  <header class="mast">
    <div class="brandline"><span class="mark"></span><b>${eyebrow}</b></div>
    <h1>${h1}</h1>
    <p class="lede">${lede}</p>
    <div class="meta">${meta.map(m => `<span>${m}</span>`).join('')}</div>
  </header>
  ${nav}
  <article>${html}</article>
  <footer>
    <span>Twixy · Personal Marketing Copilot</span>
    <span class="mono">v0.1.0 · 2026-08</span>
  </footer>
</div>
</div>`
}
