/**
 * 控制区的前线轮廓：在归属栅格（0 无，1、2 为两方，3 为争夺或不确定）上用 marching squares 提取两方的交界，
 * 得到地图格坐标下的线段（每段 4 个数：x0 y0 x1 y1）。只在四角都有归属的格子里取，海上与区外不出线；
 * 争夺区按两方之间（0.5）处理，交界线落在它与两方之间
 */
export function frontContour(owner: Uint8Array, W: number, H: number, out: number[] = []) {
  out.length = 0
  const val = (o: number) => (o === 1 ? 1 : o === 2 ? 0 : 0.5)
  const iso = 0.5
  const lerp = (a: number, b: number) => (a === b ? 0.5 : (iso - a) / (b - a))
  for (let y = 0; y + 1 < H; y++) {
    const r0 = y * W
    const r1 = r0 + W
    for (let x = 0; x + 1 < W; x++) {
      const o00 = owner[r0 + x]
      const o10 = owner[r0 + x + 1]
      const o01 = owner[r1 + x]
      const o11 = owner[r1 + x + 1]
      if (!o00 || !o10 || !o01 || !o11) continue
      if (o00 === o10 && o00 === o01 && o00 === o11) continue
      const a = val(o00)
      const b = val(o10)
      const c = val(o11)
      const d = val(o01)
      const code = (a > iso ? 8 : 0) | (b > iso ? 4 : 0) | (c > iso ? 2 : 0) | (d > iso ? 1 : 0)
      if (code === 0 || code === 15) continue
      // 四条边上的交点（格心为整数坐标）
      const top: [number, number] = [x + lerp(a, b), y]
      const right: [number, number] = [x + 1, y + lerp(b, c)]
      const bottom: [number, number] = [x + lerp(d, c), y + 1]
      const left: [number, number] = [x, y + lerp(a, d)]
      const seg = (p: [number, number], q: [number, number]) => out.push(p[0], p[1], q[0], q[1])
      switch (code) {
        case 1:
        case 14:
          seg(left, bottom)
          break
        case 2:
        case 13:
          seg(bottom, right)
          break
        case 3:
        case 12:
          seg(left, right)
          break
        case 4:
        case 11:
          seg(top, right)
          break
        case 6:
        case 9:
          seg(top, bottom)
          break
        case 7:
        case 8:
          seg(left, top)
          break
        case 5:
          seg(left, top)
          seg(bottom, right)
          break
        case 10:
          seg(top, right)
          seg(left, bottom)
          break
      }
    }
  }
  return out
}
