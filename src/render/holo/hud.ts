import { hashString, RNG } from '../../gen/rng'
import type { HoloPalette } from './palettes'

/**
 * 全息沙盘的屏幕界面：四周成排的小号等宽字读数（任务状态、坐标、时钟、链路、数据表），
 * 中央的十字基准线，以及悬停 / 锁定陆块时右侧的目标卡片。
 * 读数里的编号都由世界种子决定，同一个世界每次打开都一样。
 */

export interface HudTarget {
  name: string
  uid: string
  rows: [string, string][]
  pinned: boolean
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

export class HoloHud {
  readonly el: HTMLDivElement
  private dest: HTMLElement | null = null
  private clock: HTMLElement | null = null
  private target: HTMLDivElement
  private t0 = performance.now()
  private lastTarget = ''

  constructor(container: HTMLElement) {
    this.el = document.createElement('div')
    this.el.className = 'holo-hud'
    container.appendChild(this.el)
    this.target = document.createElement('div')
    this.target.className = 'hh-target'
  }

  setPalette(p: HoloPalette) {
    this.el.style.setProperty('--hh-text', p.text)
    this.el.style.setProperty('--hh-line', p.grid)
    this.el.style.setProperty('--hh-accent', p.accent)
  }

  set visible(v: boolean) {
    this.el.style.display = v ? '' : 'none'
  }

  /** 按世界重写全部读数 */
  build(seed: string, worldName: string, scaleKm: number) {
    const rng = new RNG(hashString(seed))
    /** [lo, hi) 里的整数 */
    const int = (lo: number, hi: number) => lo + Math.floor(rng.next() * (hi - lo))
    const pick = (chars: string) => chars[int(0, chars.length)]
    const hex = (n: number) => Array.from({ length: n }, () => pick('0123456789abcdef')).join('')
    const code = () => `${pick('ABCDEFHJKLMNPQRSTVWXYZ')}${pick('ABCDEFHJKLMNPQRSTVWXYZ')}-${int(1000, 10000)}-${hex(2)}`
    const comLvd = (): [string, string][] => [['COM', `D-${hex(3)}-${int(10, 100)}`], ['LVD', `0x${hex(4)}`]]
    const mini = (rows: string[][]) =>
      `<table class="hh-mini">${rows.map((row) => `<tr>${row.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`
    const kv = (k: string, v: string, cls = '') => `<div class="hh-kv ${cls}"><span>${k}</span><b>${v}</b></div>`
    const tiny = (pairs: [string, string][]) => `<div class="hh-tiny">${pairs.map(([k, v]) => `<i>${k}</i><em>${v}</em>`).join('')}</div>`
    const table = Array.from({ length: 3 }, () => Array.from({ length: 6 }, () => code()))
    const hi = int(0, 6)
    const top = `
      <div class="hh-row hh-top">
        ${tiny([['USR', 'root'], ['PID', hex(6)], ['TDL', String(int(0, 99999)).padStart(5, '0')]])}
        ${kv('MISSION STATUS', 'ONLINE')}
        ${kv('OPERATION', esc(worldName))}
        <div class="hh-kv"><span>DESTINATION</span><b data-k="dest">—</b></div>
        <div class="hh-kv"><span>T/L</span><b data-k="clock">0000:00</b></div>
        ${mini([['WRD', 'LS', '—', 'KPT'], ['DTL', 'HLK', 'DOC', 'VIS'], ['INF', 'SVN', 'IMG', 'LNG']])}
        <div class="hh-kv"><span>LNK 01</span><b>STL-${int(100, 1000)}</b>${tiny([['MID', hex(12)], ['HST', hex(6)], ['IPB', `${hex(4)}:${hex(4)}:${hex(4)}`]])}</div>
        <div class="hh-kv dim"><span>LNK 02</span><b>NO SIGNAL</b></div>
        <div class="hh-kv dim hh-wide"><span>LNK 03</span><b>NO SIGNAL</b></div>
        <div class="hh-spacer"></div>
        ${kv('COM', `BFR-${String(int(0, 99)).padStart(3, '0')}`)}
        <div class="hh-kv hh-wide"><span>DATA TABLE</span>${mini(table.map((row) => row.map((c, i) => (i === hi && row === table[1] ? `<u>${c}</u>` : c))))}</div>
      </div>`
    const side = (cls: string, items: string[]) => `<div class="hh-side ${cls}">${items.join('')}</div>`
    const left = side('hh-left', [
      tiny([['COM', `${int(10000, 100000)}-9-A`]]),
      tiny(comLvd()),
      tiny([['COM', `${int(10000, 100000)}-9-A`]]),
    ])
    const right = side('hh-right', [
      tiny(comLvd()),
      kv('MFT', 'KL'),
      kv('SNS', 'SH'),
      kv('SCOUNT', `${pick('ABCDEFGHJKLMN')}${pick('ABCDEFGHJKLMN')}`),
      kv('SECTION', `${pick('ABCD')}${int(1, 10)}`),
    ])
    const bottom = `
      <div class="hh-row hh-bottom">
        ${kv('LISUNIT', `GRP ${pick('ABCDEFG')}`)}
        ${mini([['WRD', 'LS', '—', 'KPT', '—', 'CAL'], ['DTL', 'HLK', 'DOC', 'VIS', '—', 'SLD'], ['INF', 'SVN', 'IMG', 'LNG', 'BOS', 'EPL']])}
        ${kv('ACTIVE', 'PRM')}
        ${tiny([...comLvd(), ['LINK', `HU${hex(3)}`]])}
        ${kv('SCALE', `${Math.round(scaleKm).toLocaleString('en-US')} KM`)}
        <div class="hh-spacer"></div>
        ${kv('TRS', `0${int(1, 10)} / + / 0${int(1, 10)}`)}
        ${kv('PRM', `${int(100, 1000)}-RW`)}
      </div>`
    this.el.innerHTML = `
      <div class="hh-cross-h"></div><div class="hh-cross-v"></div><div class="hh-cross-c"></div>
      <div class="hh-corner tl"></div><div class="hh-corner tr"></div><div class="hh-corner bl"></div><div class="hh-corner br"></div>
      ${top}${left}${right}${bottom}`
    this.el.appendChild(this.target)
    this.dest = this.el.querySelector('[data-k="dest"]')
    this.clock = this.el.querySelector('[data-k="clock"]')
    this.lastTarget = ''
    this.setTarget(null)
  }

  /** 每帧调用：时钟走字（文字没变就不碰 DOM） */
  tick() {
    if (!this.clock) return
    const s = (performance.now() - this.t0) / 1000
    const txt = `${String(Math.floor(s / 60)).padStart(4, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`
    if (this.clock.textContent !== txt) this.clock.textContent = txt
  }

  /** 光标所指的经纬度 */
  setDestination(lat: number | null, lon: number | null) {
    if (!this.dest) return
    this.dest.textContent = lat === null || lon === null ? '—' : `${dms(lat, 'N', 'S')}, ${dms(lon, 'E', 'W')}`
  }

  setTarget(t: HudTarget | null) {
    const key = t ? JSON.stringify(t) : ''
    if (key === this.lastTarget) return
    this.lastTarget = key
    if (!t) {
      this.target.classList.remove('on')
      return
    }
    this.target.classList.add('on')
    this.target.classList.toggle('pinned', t.pinned)
    this.target.innerHTML = `
      <div class="hh-target-head"><span>${t.pinned ? 'TARGET LOCKED' : 'TARGET'}</span><span>UID ${esc(t.uid)}</span></div>
      <div class="hh-target-name">${esc(t.name)}</div>
      <dl>${t.rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`
  }

  dispose() {
    this.el.remove()
  }
}

function dms(v: number, pos: string, neg: string) {
  const a = Math.abs(v)
  const d = Math.floor(a)
  const m = Math.floor((a - d) * 60)
  const s = Math.floor(((a - d) * 60 - m) * 60)
  return `${d}°${m}'${s}"${v >= 0 ? pos : neg}`
}
