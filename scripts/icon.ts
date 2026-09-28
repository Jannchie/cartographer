// 由 public/favicon.svg 生成 public/favicon.ico（16/32/48/256）与 README 用的 docs/images/logo.png：pnpm icon
import { readFileSync, writeFileSync } from 'node:fs'
import { loadImage, createCanvas } from '@napi-rs/canvas'
const svg = readFileSync('public/favicon.svg', 'utf8')
// 每个尺寸按目标大小栅格化（先栅格化再缩放会发虚）
const imgs = new Map<number, Awaited<ReturnType<typeof loadImage>>>()
for (const n of [16, 32, 48, 256]) imgs.set(n, await loadImage(Buffer.from(svg.replace('<svg ', `<svg width="${n}" height="${n}" `))))
const png = (n: number) => {
  const c = createCanvas(n, n)
  c.getContext('2d').drawImage(imgs.get(n)!, 0, 0, n, n)
  return c.toBuffer('image/png')
}
// ICO：头 6 字节 + 每项 16 字节目录，数据直接放 PNG
const sizes = [16, 32, 48, 256]
const pngs = sizes.map(png)
const head = Buffer.alloc(6 + 16 * sizes.length)
head.writeUInt16LE(0, 0)
head.writeUInt16LE(1, 2)
head.writeUInt16LE(sizes.length, 4)
let off = head.length
sizes.forEach((n, i) => {
  const e = 6 + i * 16
  head.writeUInt8(n >= 256 ? 0 : n, e)
  head.writeUInt8(n >= 256 ? 0 : n, e + 1)
  head.writeUInt16LE(1, e + 4)
  head.writeUInt16LE(32, e + 6)
  head.writeUInt32LE(pngs[i].length, e + 8)
  head.writeUInt32LE(off, e + 12)
  off += pngs[i].length
})
writeFileSync('public/favicon.ico', Buffer.concat([head, ...pngs]))
writeFileSync('docs/images/logo.png', png(256))
console.log('public/favicon.ico', sizes.join('/'), '· docs/images/logo.png 256')
