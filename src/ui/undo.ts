/**
 * 有上限的撤销栈：改动之前 push 记下原样，undo 取回最近的一份。
 * 撤销时把当前的样子交给 undo，就能 redo 回来；新的改动清空重做。
 * 栈只对一份对象（一个世界、一座城、一局生长）有意义：换了对象要 clear。
 */
export class UndoStack<T> {
  private done: T[] = []
  private undone: T[] = []
  constructor(private readonly max: number) {}

  get undoCount() {
    return this.done.length
  }
  get redoCount() {
    return this.undone.length
  }

  push(before: T) {
    this.done.push(before)
    if (this.done.length > this.max) this.done.shift()
    this.undone.length = 0
  }

  /** 取回最近记下的原样；current 给了就记进重做 */
  undo(current?: T): T | undefined {
    const prev = this.done.pop()
    if (prev !== undefined && current !== undefined) this.undone.push(current)
    return prev
  }

  /** 取回最近撤销掉的样子，current 记回撤销栈 */
  redo(current: T): T | undefined {
    const next = this.undone.pop()
    if (next !== undefined) this.done.push(current)
    return next
  }

  clear() {
    this.done.length = 0
    this.undone.length = 0
  }
}
