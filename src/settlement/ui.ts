import { Biome, type Label, type World } from '../gen/types'
import type { DisplayList } from '../render/atlas/svg/displayList'
import { AtlasViewer } from '../render/atlas/svg/viewer'
import { generateSettlement } from './generate'
import { pointInPoly, type P } from './geom'
import { buildSettlementVector, ensureSettleFonts } from './render'
import { SETTLE_THEMES, type SettleStyleId } from './themes'
import { DEFAULT_SETTLEMENT, WARD_NAMES, type Settlement, type SettlementParams } from './types'

/**
 * 聚落地图模块的界面：左侧面板（参数、风格、导出）+ 舞台（矢量查看器、悬停探针）。
 * 与世界地图共用面板外壳与查看器；世界已生成时可以选一个城镇，继承那里的环境。
 */
export function initSettlement(getWorld: () => World | null) {
  const store = {
    get(k: string) {
      try {
        return localStorage.getItem(k)
      } catch {
        return null
      }
    },
    set(k: string, v: string) {
      try {
        localStorage.setItem(k, v)
      } catch {
        // 隐私模式等场景不可用
      }
    },
  }
  const saved = (() => {
    try {
      return JSON.parse(store.get('settleParams') ?? '{}') as Partial<SettlementParams>
    } catch {
      return {}
    }
  })()
  const params: SettlementParams = { ...DEFAULT_SETTLEMENT, ...saved, coastDir: NaN, riverDir: NaN, hillDir: NaN, name: undefined, nameZh: undefined, climate: undefined }
  let style = (store.get('settleStyle') as SettleStyleId) || 'parchment'
  const opts = { labels: true, contours: true }
  let st: Settlement | null = null
  const cache = new Map<string, DisplayList>()
  let viewer: AtlasViewer | null = null
  const view = { x: 0, y: 0, k: 1 }
  let size: { width: number; height: number } | null = null

  // —— DOM ——
  const panel = document.querySelector('#panel')!
  const scroll = document.createElement('div')
  scroll.className = 'scroll settle-scroll'
  const foot = document.createElement('footer')
  foot.className = 'export settle-foot'
  const worldFoot = panel.querySelector('footer')
  panel.insertBefore(scroll, worldFoot)
  panel.appendChild(foot)
  const stage = document.querySelector('#settlement') as HTMLElement
  stage.innerHTML = `
    <div id="settle-view" class="view"></div>
    <div id="settle-probe" class="hidden"></div>
    <div id="settle-hint">拖动平移 · 滚轮缩放 · 双击复位 · R 随机</div>
    <div id="settle-loading" class="hidden"><div class="load-card"><div class="load-title">正在营建</div><div class="load-stage" id="settle-stage">…</div><div class="bar"><i style="width:100%"></i></div></div></div>`
  const host = stage.querySelector('#settle-view') as HTMLElement
  const probe = stage.querySelector('#settle-probe') as HTMLElement
  const loading = stage.querySelector('#settle-loading') as HTMLElement

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string) => {
    const e = document.createElement(tag)
    if (cls) e.className = cls
    if (html !== undefined) e.innerHTML = html
    return e
  }

  // 种子
  const gen = el('section', 'gen')
  const seedBox = el('div', 'seed-box')
  const seed = el('input') as HTMLInputElement
  seed.spellcheck = false
  seed.placeholder = '输入种子'
  seed.title = '同一种子总是生成同一座聚落'
  seed.value = params.seed
  const dice = el('button', '', '随机')
  dice.title = '随机种子并生成（R）'
  seedBox.append(seed, dice)
  gen.appendChild(seedBox)

  const syncers: (() => void)[] = []
  /** 分段按钮 */
  const seg = <K extends keyof SettlementParams>(label: string, key: K, items: [SettlementParams[K], string, string?][]) => {
    const row = el('div', 'row seg-row')
    row.appendChild(el('label', '', label))
    const box = el('div', 'seg')
    for (const [v, name, tip] of items) {
      const b = el('button', '', name)
      if (tip) b.title = tip
      b.addEventListener('click', () => {
        params[key] = v
        sync()
        run()
      })
      box.appendChild(b)
      syncers.push(() => b.classList.toggle('on', params[key] === v))
    }
    row.appendChild(box)
    gen.appendChild(row)
  }
  seg('规模', 'size', [
    ['hamlet', '小村', '十来户人家'],
    ['village', '村镇', '数十户，有教堂或祠堂'],
    ['town', '城镇', '数千人，常有城墙'],
    ['city', '城市', '上万人，城墙、城堡、多个街区'],
  ])
  seg('文明', 'culture', [
    ['western', '西式', '中世纪欧洲式：有机生长的街巷、城堡、教堂、广场'],
    ['eastern', '东方', '方城与里坊、中轴对称的宫城与寺观、四合院'],
  ])
  seg('奇幻', 'magic', [
    [0, '写实'],
    [1, '奇幻', '法师塔与魔法阵 / 宗门与仙阁'],
    [2, '高魔', '再加浮空岛与灵脉'],
  ])
  seg('城防', 'walls', [
    ['auto', '自动'],
    ['none', '无'],
    ['palisade', '木栅'],
    ['stone', '石墙'],
  ])
  // 环境开关
  const env = el('div', 'toggles')
  const envToggle = (label: string, key: 'river' | 'coast' | 'hills' | 'farms', tip: string) => {
    const b = el('button', 'toggle', label)
    b.title = tip
    b.addEventListener('click', () => {
      params[key] = !params[key]
      sync()
      run()
    })
    syncers.push(() => b.classList.toggle('on', params[key]))
    env.appendChild(b)
  }
  envToggle('河流', 'river', '一条河穿城而过：桥梁、码头、渡口')
  envToggle('临海', 'coast', '城在海湾边：港口、栈桥与船')
  envToggle('依山', 'hills', '地图一侧是山')
  envToggle('农田', 'farms', '城外的条田、水田、果园与牧场')
  gen.appendChild(env)
  // 起伏
  {
    const row = el('div', 'row')
    row.innerHTML = `<label>地形起伏</label><input type="range" min="0" max="1" step="0.05"><output></output>`
    const input = row.querySelector('input')!
    const out = row.querySelector('output')!
    const s = () => {
      input.value = String(params.relief)
      out.textContent = params.relief.toFixed(2)
      input.style.setProperty('--p', `${params.relief * 100}%`)
    }
    input.addEventListener('input', () => {
      params.relief = parseFloat(input.value)
      s()
    })
    input.addEventListener('change', () => run())
    syncers.push(s)
    gen.appendChild(row)
  }
  // 继承世界地图上的地点
  const inherit = el('div', 'row')
  inherit.innerHTML = `<label>世界地点</label><select id="settle-from"><option value="">不继承（独立生成）</option></select>`
  inherit.title = '从当前世界地图选一座城镇：继承名字、规模、河流、海岸、山地与气候'
  const fromSel = inherit.querySelector('select') as HTMLSelectElement
  gen.appendChild(inherit)
  const genBtn = el('button', 'primary', '生成聚落')
  gen.appendChild(genBtn)
  scroll.appendChild(gen)

  // 信息
  const info = el('section', 'hidden')
  info.innerHTML = `<div class="world-name" id="settle-name"></div><div class="stats" id="settle-stats"></div>`
  scroll.appendChild(info)

  // 风格
  const styleSec = el('section')
  styleSec.appendChild(el('h2', '', '绘图风格'))
  const grid = el('div', 'styles')
  for (const t of SETTLE_THEMES) {
    const b = el('button', 'style-card' + (t.id === style ? ' on' : ''))
    b.title = t.desc
    b.innerHTML = `<i style="background:${t.ground}"><b style="border-color:${t.ink}"></b></i><span>${t.name}</span>`
    b.addEventListener('click', () => {
      style = t.id
      store.set('settleStyle', t.id)
      for (const x of grid.children) x.classList.toggle('on', x === b)
      refresh()
    })
    grid.appendChild(b)
  }
  styleSec.appendChild(grid)
  const tg = el('div', 'toggles')
  for (const [label, key] of [
    ['注记', 'labels'],
    ['等高线', 'contours'],
  ] as const) {
    const b = el('button', 'toggle on', label)
    b.addEventListener('click', () => {
      opts[key] = !opts[key]
      b.classList.toggle('on', opts[key])
      cache.clear()
      refresh()
    })
    tg.appendChild(b)
  }
  styleSec.appendChild(tg)
  scroll.appendChild(styleSec)

  const png = el('button', '', '导出 PNG')
  png.title = '按 2 倍分辨率导出'
  const svg = el('button', '', '导出 SVG')
  svg.title = '矢量版本，可无损放大'
  foot.append(png, svg)

  function sync() {
    syncers.forEach((f) => f())
    seed.value = params.seed
  }
  sync()

  // —— 世界地点列表 ——
  let worldRef: World | null = null
  function refreshPlaces() {
    const w = getWorld()
    if (w === worldRef) return
    worldRef = w
    const keep = fromSel.value
    fromSel.innerHTML = `<option value="">不继承（独立生成）</option>`
    if (!w) return
    const towns = w.labels.map((l, i) => ({ l, i })).filter(({ l }) => l.kind === 'city' || l.kind === 'capital')
    towns.sort((a, b) => b.l.weight - a.l.weight)
    for (const { l, i } of towns) {
      const o = document.createElement('option')
      o.value = String(i)
      o.textContent = `${l.kind === 'capital' ? '★ ' : ''}${l.zh} · ${l.name}`
      fromSel.appendChild(o)
    }
    if (keep && fromSel.querySelector(`option[value="${keep}"]`)) fromSel.value = keep
  }
  fromSel.addEventListener('focus', refreshPlaces)
  fromSel.addEventListener('pointerdown', refreshPlaces)
  fromSel.addEventListener('change', () => {
    const w = getWorld()
    const idx = fromSel.value === '' ? -1 : Number(fromSel.value)
    if (!w || idx < 0) {
      params.name = params.nameZh = undefined
      params.climate = undefined
      params.coastDir = params.riverDir = params.hillDir = NaN
      run()
      return
    }
    Object.assign(params, fromWorld(w, w.labels[idx]))
    sync()
    run()
  })

  // —— 生成与绘制 ——
  const SYL = ['thorn', 'ash', 'wick', 'mere', 'ford', 'dale', 'brook', 'holm', 'stead', 'bury', 'ley', 'ton', 'wyn', 'mar', 'vel', 'or']
  function randomSeed() {
    let s = ''
    const n = 2 + Math.floor(Math.random() * 2)
    for (let i = 0; i < n; i++) s += SYL[Math.floor(Math.random() * SYL.length)]
    params.seed = s
    // 随机种子即独立生成
    fromSel.value = ''
    params.name = params.nameZh = undefined
    params.climate = undefined
    params.coastDir = params.riverDir = params.hillDir = NaN
    sync()
    run()
  }
  dice.addEventListener('click', randomSeed)
  seed.addEventListener('keydown', (e) => e.key === 'Enter' && run())
  seed.addEventListener('change', () => {
    params.seed = seed.value.trim() || 'settlement'
  })
  genBtn.addEventListener('click', () => {
    params.seed = seed.value.trim() || 'settlement'
    run()
  })
  window.addEventListener('keydown', (e) => {
    if (document.body.dataset.module !== 'settlement') return
    const t = e.target as HTMLElement
    if (e.ctrlKey || e.metaKey || e.altKey || t.matches('input, select, textarea')) return
    if (e.key === 'r' || e.key === 'R') randomSeed()
  })

  let job = 0
  async function run() {
    const id = ++job
    store.set('settleParams', JSON.stringify({ ...params, name: undefined, nameZh: undefined, climate: undefined }))
    loading.classList.remove('hidden')
    ;(stage.querySelector('#settle-stage') as HTMLElement).textContent = '规划街巷与街坊'
    await new Promise((r) => setTimeout(r, 30))
    if (id !== job) return
    try {
      st = generateSettlement({ ...params })
    } catch (err) {
      console.error(err)
      ;(stage.querySelector('#settle-stage') as HTMLElement).textContent = '生成失败：' + (err instanceof Error ? err.message : String(err))
      return
    }
    cache.clear()
    showInfo(st)
    await refresh(true)
  }

  async function listFor(s: Settlement, id: SettleStyleId) {
    let l = cache.get(id)
    if (l) return l
    await ensureSettleFonts(s, id)
    const measurer = document.createElement('canvas').getContext('2d')!
    l = buildSettlementVector(s, id, opts, measurer)
    cache.set(id, l)
    return l
  }

  async function refresh(fit = false) {
    if (!st) return
    const s = st
    const id = ++job
    if (!cache.has(style)) {
      loading.classList.remove('hidden')
      ;(stage.querySelector('#settle-stage') as HTMLElement).textContent = `绘制${SETTLE_THEMES.find((t) => t.id === style)!.name}`
      await new Promise((r) => setTimeout(r, 20))
    }
    const list = await listFor(s, style)
    if (id !== job) return
    loading.classList.add('hidden')
    if (!viewer) viewer = new AtlasViewer(host)
    const same = size && size.width === list.width && size.height === list.height
    size = { width: list.width, height: list.height }
    viewer.setList(list)
    if (fit || !same) fitView()
    else viewer.setView(view.x, view.y, view.k)
  }

  function fitView() {
    if (!size || !viewer) return
    const k = Math.min((host.clientWidth - 60) / size.width, (host.clientHeight - 60) / size.height)
    view.k = k
    view.x = (host.clientWidth - size.width * k) / 2
    view.y = (host.clientHeight - size.height * k) / 2
    viewer.setView(view.x, view.y, view.k)
  }

  function showInfo(s: Settlement) {
    const tiles: [string, string][] = [
      ['人口', `≈ ${s.stats.population.toLocaleString()}`],
      ['建筑', s.stats.buildings.toLocaleString()],
      ['城区', `${s.stats.area.toFixed(1)} ha`],
      ['范围', `${(s.width / 1000).toFixed(1)}×${(s.height / 1000).toFixed(1)}km`],
      ['城门', String(s.walls[0]?.gates.length ?? 0)],
      ['桥 / 渡', String(s.crossings.length)],
    ]
    ;(info.querySelector('#settle-name') as HTMLElement).innerHTML = `${s.nameZh}<small>${s.name} · ${(s.stats.ms / 1000).toFixed(2)} s</small>`
    ;(info.querySelector('#settle-stats') as HTMLElement).innerHTML = tiles.map(([k, v]) => `<div><b>${v}</b><span>${k}</span></div>`).join('')
    info.classList.remove('hidden')
  }

  // —— 平移缩放 ——
  {
    let drag: { x: number; y: number; vx: number; vy: number } | null = null
    host.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }
      host.classList.add('dragging')
      host.setPointerCapture(e.pointerId)
    })
    host.addEventListener('pointermove', (e) => {
      if (drag) {
        view.x = drag.vx + e.clientX - drag.x
        view.y = drag.vy + e.clientY - drag.y
        viewer?.setView(view.x, view.y, view.k)
      }
      probeAt(e.clientX, e.clientY)
    })
    host.addEventListener('pointerup', () => {
      drag = null
      host.classList.remove('dragging')
    })
    host.addEventListener('pointerleave', () => probe.classList.add('hidden'))
    host.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault()
        const r = host.getBoundingClientRect()
        const cx = e.clientX - r.left
        const cy = e.clientY - r.top
        const nk = Math.min(40, Math.max(0.1, view.k * Math.exp(-e.deltaY * 0.0015)))
        view.x = cx - ((cx - view.x) * nk) / view.k
        view.y = cy - ((cy - view.y) * nk) / view.k
        view.k = nk
        viewer?.setView(view.x, view.y, view.k)
      },
      { passive: false },
    )
    host.addEventListener('dblclick', fitView)
    window.addEventListener('resize', () => document.body.dataset.module === 'settlement' && fitView())
  }

  // —— 探针：悬停显示片区与海拔 ——
  let raf = 0
  function probeAt(clientX: number, clientY: number) {
    cancelAnimationFrame(raf)
    raf = requestAnimationFrame(() => {
      const list = cache.get(style)
      if (!st || !list) return
      const r = host.getBoundingClientRect()
      const S = list.MW / st.width
      const q: P = [((clientX - r.left - view.x) / view.k - list.M) / S, ((clientY - r.top - view.y) / view.k - list.M) / S]
      if (q[0] < 0 || q[1] < 0 || q[0] > st.width || q[1] > st.height) {
        probe.classList.add('hidden')
        return
      }
      const T = st.terrain
      const i = Math.min(T.W - 1, Math.round(q[0] / T.cell))
      const j = Math.min(T.H - 1, Math.round(q[1] / T.cell))
      const k = j * T.W + i
      const wet = T.water[k] < 0
      const ward = st.wards.find((w) => pointInPoly(q, w.poly))
      const title = wet ? (st.sea && T.height[k] < -0.6 && !st.river ? st.sea.name : '水域') : ward ? (ward.name ?? WARD_NAMES[ward.type]) : '野地'
      const rows: [string, string][] = []
      if (ward && !wet) rows.push(['片区', WARD_NAMES[ward.type] + (ward.inner ? '（城内）' : '')])
      rows.push([wet ? '水深' : '海拔', `${Math.abs(T.height[k]).toFixed(1)} m`])
      rows.push(['坐标', `${Math.round(q[0])}, ${Math.round(q[1])} m`])
      probe.innerHTML = `<div class="b">${title}</div>` + rows.map(([a, b]) => `<span class="k">${a}</span><span class="v">${b}</span>`).join('')
      probe.classList.remove('hidden')
    })
  }

  // —— 导出 ——
  const fileBase = () => `${(st?.name ?? 'settlement').toLowerCase()}-${params.seed}-${style}`
  png.addEventListener('click', async () => {
    if (!st) return
    const list = await listFor(st, style)
    const c = document.createElement('canvas')
    c.width = list.width * 2
    c.height = list.height * 2
    list.render(c.getContext('2d')!, 2, 0, 0)
    const a = document.createElement('a')
    a.href = c.toDataURL('image/png')
    a.download = `${fileBase()}.png`
    a.click()
  })
  svg.addEventListener('click', async () => {
    if (!st) return
    const list = await listFor(st, style)
    const url = URL.createObjectURL(new Blob([list.toSVG()], { type: 'image/svg+xml' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${fileBase()}.svg`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
  })

  // 第一次进入聚落模块时才生成
  const start = () => {
    if (document.body.dataset.module !== 'settlement') return
    refreshPlaces()
    if (!st) run()
    else fitView()
  }
  new MutationObserver(start).observe(document.body, { attributes: true, attributeFilter: ['data-module'] })
  start()
}

/**
 * 从世界地图上的一座城镇推断聚落环境：名字、规模、河流与来向、海的方向、山地、气候。
 */
export function fromWorld(w: World, l: Label): Partial<SettlementParams> {
  const { W, H } = w
  const x = Math.min(W - 2, Math.max(1, Math.round(l.x)))
  const y = Math.min(H - 2, Math.max(1, Math.round(l.y)))
  const i = y * W + x
  // 在全部城镇中的重要度排名（0 最低，1 最高）
  const cities = w.labels.filter((c) => c.kind === 'city')
  const rank = cities.length ? cities.filter((c) => c.weight < l.weight).length / cities.length : 0.5
  const out: Partial<SettlementParams> = {
    seed: `${w.params.seed}-${l.name.toLowerCase()}`,
    name: l.name,
    nameZh: l.zh,
    size: l.kind === 'capital' ? 'city' : rank >= 0.6 ? 'town' : 'village',
    climate: { temp: w.temperature[i], rain: w.precipitation[i], biome: w.biome[i] },
  }
  // 海：到海岸距离小；海在距离下降的方向
  const cd = w.coastDist
  out.coast = cd[i] < 3
  if (out.coast) {
    const gx = cd[i + 1] - cd[i - 1]
    const gy = cd[i + W] - cd[i - W]
    out.coastDir = Math.atan2(-gy, -gx)
  } else out.coastDir = NaN
  // 河：附近有河道点
  let best = Infinity
  let dir = NaN
  for (const r of w.rivers) {
    const pts = r.points
    for (let k = 0; k + 1 < pts.length / 2; k++) {
      const d = Math.hypot(pts[k * 2] - l.x, pts[k * 2 + 1] - l.y)
      if (d < best && r.flow[k] > 2) {
        best = d
        // 上游方向（河道点由源头流向河口）
        const k0 = Math.max(0, k - 3)
        dir = Math.atan2(pts[k0 * 2 + 1] - pts[k * 2 + 1], pts[k0 * 2] - pts[k * 2])
      }
    }
  }
  out.river = best < 2.5
  out.riverDir = out.river && Number.isFinite(dir) ? dir : NaN
  // 山：周围 5 格内的最高点明显高于城
  let hx = 0
  let hy = 0
  let hmax = w.elevation[i]
  let sum = 0
  let n = 0
  for (let dy = -5; dy <= 5; dy++)
    for (let dx = -5; dx <= 5; dx++) {
      const xx = x + dx
      const yy = y + dy
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue
      const e = w.elevation[yy * W + xx]
      if (e > 0) {
        sum += Math.abs(e - w.elevation[i])
        n++
      }
      if (e > hmax) {
        hmax = e
        hx = dx
        hy = dy
      }
    }
  out.hills = hmax - w.elevation[i] > 0.25
  out.hillDir = out.hills ? Math.atan2(hy, hx) : NaN
  out.relief = Math.min(1, Math.max(0.1, (sum / Math.max(1, n)) * 2.5))
  const b = w.biome[i]
  out.farms = b !== Biome.IceCap && b !== Biome.Tundra
  return out
}
