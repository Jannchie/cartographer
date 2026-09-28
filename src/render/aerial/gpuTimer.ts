/**
 * GPU 计时（EXT_disjoint_timer_query_webgl2），两种粒度：
 * - 平时每帧一个查询，只要整帧耗时（动态分辨率据此调节缩放）；
 * - detail 打开时（性能读数）每个 pass 一个查询，按名字做指数滑动平均。
 * 查询不能嵌套，begin 会先结束上一个；结果几帧后才可读。没有扩展时所有调用都是空操作。
 */
export class GpuTimer {
  private ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null
  private frames: { tag: number; qs: { label: string; q: WebGLQuery }[] }[] = []
  private cur: { label: string; q: WebGLQuery }[] | null = null
  private open = false
  /** 逐 pass 计时（性能读数打开时） */
  detail = false
  /** 本帧的标记，随结果一起回传（例如这一帧用的渲染缩放） */
  tag = 0
  /** 一帧的结果可读时回调：整帧 GPU 耗时（毫秒）与该帧的标记 */
  onFrame: ((ms: number, tag: number) => void) | null = null
  /** 各 pass 的平均耗时（毫秒，detail 时），按首次出现的顺序 */
  readonly ms = new Map<string, number>()

  constructor(private gl: WebGL2RenderingContext) {
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2')
  }

  get supported() {
    return !!this.ext
  }

  frameStart() {
    // 结果积压太多（GPU 跟不上）时这一帧不计
    this.cur = this.ext && this.frames.length < 4 ? [] : null
    this.tag = 0
    if (this.cur && !this.detail) this.query('帧')
  }

  begin(label: string) {
    if (this.cur && this.detail) this.query(label)
  }

  private query(label: string) {
    this.end()
    const q = this.gl.createQuery()!
    this.gl.beginQuery(this.ext!.TIME_ELAPSED_EXT, q)
    this.cur!.push({ label, q })
    this.open = true
  }

  private end() {
    if (!this.open) return
    this.gl.endQuery(this.ext!.TIME_ELAPSED_EXT)
    this.open = false
  }

  frameEnd() {
    this.end()
    if (this.cur?.length) this.frames.push({ tag: this.tag, qs: this.cur })
    this.cur = null
    const gl = this.gl
    while (this.frames.length) {
      const f = this.frames[0]
      if (!gl.getQueryParameter(f.qs[f.qs.length - 1].q, gl.QUERY_RESULT_AVAILABLE)) break
      this.frames.shift()
      const disjoint = gl.getParameter(this.ext!.GPU_DISJOINT_EXT)
      const sum = new Map<string, number>()
      let total = 0
      for (const { label, q } of f.qs) {
        if (!disjoint) {
          const v = (gl.getQueryParameter(q, gl.QUERY_RESULT) as number) / 1e6
          sum.set(label, (sum.get(label) ?? 0) + v)
          total += v
        }
        gl.deleteQuery(q)
      }
      if (disjoint) continue
      this.onFrame?.(total, f.tag)
      if (!this.detail) continue
      for (const [k, v] of sum) {
        const old = this.ms.get(k)
        this.ms.set(k, old === undefined ? v : old * 0.9 + v * 0.1)
      }
    }
  }

  get total() {
    let s = 0
    for (const v of this.ms.values()) s += v
    return s
  }
}
