/* QA only: run the installed host's public static module seeds, without booting its app.
 * Production client.js only requires the public primitives module. No copied component code ships.
 */
import fs from 'node:fs'
import path from 'node:path'

export function hostPrimitiveAssets() {
  const host = process.env.TEACH_HOST_ROOT ?? path.resolve(path.dirname(process.execPath), '../lib/node_modules/@deepseek-ai/dsh')
  const assets = path.join(host, 'node_modules/@deepseek-ai/dsh-web-frontend/dist/assets')
  const html = fs.readFileSync(path.join(assets, '../index.html'), 'utf8')
  const file = /src="(?:\.\/)?assets\/(index-[^"]+\.js)"/.exec(html)?.[1]
  if (!file) throw new Error('Host public primitive seeds not found')
  const source = fs.readFileSync(path.join(assets, file), 'utf8')
  const seeds = /function (\w+)\(\)\{return\{react:[^}]+"@deepseek-ai\/dsh-client-ui-primitives":/.exec(source)
  const boot = /const \w+=globalThis\.dshDesktopBoot/.exec(source)
  if (!seeds || !boot) throw new Error('Host QA boot seam changed; refusing to substitute fake menus')
  const styles = [...html.matchAll(/href="(?:\.\/)?assets\/([^"]+\.css)"/g)].map((match) => match[1])
  if (!styles.length) throw new Error('Host primitive styles not found')
  const loadStyles = `await Promise.all(${JSON.stringify(styles)}.map(name => new Promise((resolve, reject) => { const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = '/host-assets/' + name; link.onload = resolve; link.onerror = reject; document.head.appendChild(link); })));`
  const moduleSource = source.slice(0, boot.index) + '\n' + loadStyles + '\nexport const hostModules=' + seeds[1] + `();
const symbols = hostModules['@deepseek-ai/dsh-client-ui-primitives'].ICON_SYMBOLS;
if (symbols) { const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden'; svg.setAttribute('aria-hidden', 'true'); svg.innerHTML = Object.entries(symbols).map(([id, markup]) => '<symbol id="' + id + '">' + markup + '</symbol>').join(''); document.body.appendChild(svg); }
`
  return function route(request, response) {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname
    if (!pathname.startsWith('/host-assets/')) return false
    const relative = decodeURIComponent(pathname.slice('/host-assets/'.length))
    const absolute = path.resolve(assets, relative)
    if (!absolute.startsWith(assets + path.sep) || !/\.(js|css)$/.test(relative)) { response.writeHead(404); response.end(); return true }
    const body = relative === 'host-primitives.js' ? moduleSource : fs.readFileSync(absolute)
    response.writeHead(200, { 'content-type': relative.endsWith('.css') ? 'text/css' : 'text/javascript', 'cache-control': 'no-store' })
    response.end(body)
    return true
  }
}
