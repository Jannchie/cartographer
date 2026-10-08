/**
 * 导出视频时间轴里配乐需要对齐的时刻（JSON，写到标准输出），交给 bgm.py 合成配乐：
 *   pnpm tsx video/expressway/cues.ts > cues.json
 */
import { BOOT, neonFlicker } from '../../src/render/holo/boot'
import { CAPTIONS, captionsAt, DURATION, INTRO, OUTRO, secOfYear, T_END, T_START } from './timeline'

// 每条事件提示的开、合时刻（合上的时刻取它最后出现的那一刻）
const captions = CAPTIONS.map((c, i) => {
  const open = secOfYear(c.year)
  let close = open
  for (let t = open; t < DURATION; t += 1 / 30) {
    if (!captionsAt(t).some((x) => x.index === i)) break
    close = t
  }
  return { open, close }
})
// 沙盘搭建：各部件开始画出的时刻（秒，按先后排序）
const boot = Object.values(BOOT)
  .map((v) => INTRO.boot + (typeof v === 'number' ? v : v[0]))
  .sort((a, b) => a - b)
// 国界霓虹灯管通电的亮度曲线：进度 0~1 上均匀取 200 个点
const neon = Array.from({ length: 200 }, (_, i) => neonFlicker(i / 199))
console.log(JSON.stringify({ duration: DURATION, tStart: T_START, tEnd: T_END, intro: INTRO, outro: OUTRO, captions, boot, neon }))
