/** 随机种子：从音节表里随机拼 2–3 个音节 */
export function syllableSeed(syl: readonly string[]) {
  let s = ''
  const n = 2 + Math.floor(Math.random() * 2)
  for (let i = 0; i < n; i++) s += syl[Math.floor(Math.random() * syl.length)]
  return s
}
