import type { LayerSetup } from '../../kernel'
import { AtlasStyles, type Theme } from '../../render/atlas/styles'
import { ATLAS_STYLES } from '../cartography/paper/styles'

/**
 * 示例插件（只在开发构建里出现）的 paper 层入口：登记一种纸图风格——内置的"自然地理"换成棕褐色调，
 * 用来验证"选中插件的风格 → 停用插件 → 提示并回到默认风格"。它借用 cartography 的风格定义，所以依赖 cartography。
 */
const base = ATLAS_STYLES.find((s) => s.id === 'physical')!

/** 棕褐色调：亮度乘上一组暖色的系数 */
const SEPIA = [1.07, 0.87, 0.63]

const style: Theme = {
  ...base,
  id: 'sample-sepia',
  name: '示例风格',
  desc: '示例插件 · 棕褐色调的自然地理',
  paper: [226, 210, 178],
  ink: '#4a3624',
  pixel(p, o, f, opts) {
    base.pixel(p, o, f, opts)
    const y = o[0] * 0.3 + o[1] * 0.59 + o[2] * 0.11
    for (let k = 0; k < 3; k++) o[k] = y * SEPIA[k]
  },
  async vector() {
    const draw = await base.vector()
    return (L, world, F, env) => {
      const after = draw(L, world, F, env)
      // 矢量版做不到逐像素去色：整张图罩一层棕褐色
      return () => {
        if (after) after()
        L.rect('rgb(112,66,20)', 0.32)
      }
    }
  },
}

const setup: LayerSetup = (host) => {
  host.add(AtlasStyles, style.id, style)
}
export default setup
