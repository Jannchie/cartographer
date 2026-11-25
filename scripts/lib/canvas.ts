// node 下用 @napi-rs/canvas 顶替浏览器的 Canvas 全局量。
// 只为副作用引入（import './lib/canvas'），并且 src/ 里的模块要在它之后用动态 import 加载。
import { createCanvas, DOMMatrix, ImageData, Path2D } from '@napi-rs/canvas'

const g = globalThis as any
g.ImageData = ImageData
g.Path2D = Path2D
g.DOMMatrix = DOMMatrix
g.document = { createElement: () => createCanvas(1, 1) }
