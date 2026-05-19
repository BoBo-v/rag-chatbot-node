# 前端 + AI 应用工程师 面试复习资料

> 基于个人技术栈定制，重点覆盖 JS/TS/Vue3/浏览器/Node/AI 工程
> 每个知识点按「概念精讲 → 高频追问 → 手写题」组织

---

## 一、JavaScript 核心

### 1.1 Event Loop

**精确模型（浏览器环境）：**

一轮 Event Loop 的执行顺序：

1. 从宏任务队列取**一个**任务执行（首次是整个 script）
2. 执行过程中遇到微任务就推入微任务队列
3. 当前宏任务执行完毕，**清空整个微任务队列**（包括执行微任务过程中新产生的微任务）
4. 如果有渲染时机（通常 16.6ms 一次），执行 rAF 回调 → Style → Layout → Paint
5. 回到第 1 步，取下一个宏任务

**宏任务 vs 微任务：**

- 宏任务：setTimeout / setInterval / MessageChannel / I/O / UI rendering
- 微任务：Promise.then/catch/finally / MutationObserver / queueMicrotask

**关键细节：**

- `setTimeout(fn, 0)` 最小延迟是 4ms（嵌套超过 5 层时）
- 微任务会在渲染前全部执行完 → 微任务死循环会阻塞渲染
- `rAF` 不是宏任务也不是微任务，是渲染阶段的回调
- Node.js 的 Event Loop 分为 6 个阶段（timers → pending → idle → poll → check → close），和浏览器模型不同

**高频追问：**

- Q：`Promise.then` 里再 `Promise.resolve().then(...)` 会在什么时候执行？
- A：当前微任务队列末尾立即执行，不会等到下一轮宏任务。微任务队列是「清空式」执行。

- Q：rAF 的回调在 Event Loop 的哪个阶段？
- A：在微任务清空后、浏览器判断需要渲染时，渲染流程的最前面执行。不是每轮 loop 都会触发。

---

**✏️ 手写题 1：输出顺序**

```js
console.log('1')

setTimeout(() => {
  console.log('2')
  Promise.resolve().then(() => console.log('3'))
}, 0)

Promise.resolve().then(() => {
  console.log('4')
  setTimeout(() => console.log('5'), 0)
})

Promise.resolve().then(() => console.log('6'))

console.log('7')
```

<details>
<summary>答案</summary>

```
1 → 7 → 4 → 6 → 2 → 3 → 5
```

解析：
- 同步：1, 7
- 微任务队列（第一轮）：4, 6（两个 Promise.then 按注册顺序执行）
- 执行 4 时注册了 setTimeout(5)，推入宏任务队列
- 宏任务队列：先 setTimeout(2)（先注册），执行 2 后立即清空微任务 → 3
- 下一个宏任务：5
</details>

---

**✏️ 手写题 2：综合输出**

```js
async function async1() {
  console.log('a1 start')
  await async2()
  console.log('a1 end')
}

async function async2() {
  console.log('a2')
}

console.log('script start')

setTimeout(() => console.log('setTimeout'), 0)

async1()

new Promise((resolve) => {
  console.log('promise1')
  resolve()
}).then(() => {
  console.log('promise2')
})

console.log('script end')
```

<details>
<summary>答案</summary>

```
script start → a1 start → a2 → promise1 → script end → a1 end → promise2 → setTimeout
```

关键：`await async2()` 之后的代码等价于 `.then(() => { console.log('a1 end') })`，作为微任务排队。
</details>

---

### 1.2 Promise

**核心规范要点：**

- 三种状态：pending / fulfilled / rejected，状态不可逆
- `then` 返回**新的 Promise**（链式调用的基础）
- `then` 的回调是异步执行的（微任务）
- 值穿透：`.then(非函数)` 会被忽略，值直接传递给下一个 `.then`
- 错误冒泡：rejected 状态会沿着链向后传递，直到遇到 `.catch` 或 `.then(null, onRejected)`

**then 的返回值规则：**
1. 回调 return 普通值 → 新 Promise 以该值 fulfilled
2. 回调 return Promise → 新 Promise 跟随这个 Promise 的状态
3. 回调 throw → 新 Promise 以该错误 rejected
4. 不 return → 等价于 return undefined

---

**✏️ 手写题 3：手写 Promise（核心版）**

要求实现：构造函数、then（支持链式）、微任务调度。

```js
class MyPromise {
  // 你的实现
}

// 测试用例
const p = new MyPromise((resolve) => {
  setTimeout(() => resolve('ok'), 100)
})
p.then(v => {
  console.log(v) // 'ok'
  return v + '!'
}).then(v => {
  console.log(v) // 'ok!'
})
```

<details>
<summary>参考实现</summary>

```js
class MyPromise {
  #state = 'pending'
  #value = undefined
  #callbacks = []

  constructor(executor) {
    const resolve = (value) => {
      if (this.#state !== 'pending') return
      this.#state = 'fulfilled'
      this.#value = value
      this.#callbacks.forEach(cb => cb.onFulfilled(value))
    }
    const reject = (reason) => {
      if (this.#state !== 'pending') return
      this.#state = 'rejected'
      this.#value = reason
      this.#callbacks.forEach(cb => cb.onRejected(reason))
    }
    try {
      executor(resolve, reject)
    } catch (e) {
      reject(e)
    }
  }

  then(onFulfilled, onRejected) {
    // 值穿透
    onFulfilled = typeof onFulfilled === 'function' ? onFulfilled : v => v
    onRejected = typeof onRejected === 'function' ? onRejected : e => { throw e }

    return new MyPromise((resolve, reject) => {
      const handle = (fn, value) => {
        // 用 queueMicrotask 保证异步
        queueMicrotask(() => {
          try {
            const result = fn(value)
            // 如果返回的是 Promise，跟随它的状态
            if (result instanceof MyPromise) {
              result.then(resolve, reject)
            } else {
              resolve(result)
            }
          } catch (e) {
            reject(e)
          }
        })
      }

      if (this.#state === 'fulfilled') {
        handle(onFulfilled, this.#value)
      } else if (this.#state === 'rejected') {
        handle(onRejected, this.#value)
      } else {
        // pending 状态，存回调
        this.#callbacks.push({
          onFulfilled: (v) => handle(onFulfilled, v),
          onRejected: (r) => handle(onRejected, r),
        })
      }
    })
  }

  catch(onRejected) {
    return this.then(null, onRejected)
  }

  static resolve(value) {
    if (value instanceof MyPromise) return value
    return new MyPromise(resolve => resolve(value))
  }

  static reject(reason) {
    return new MyPromise((_, reject) => reject(reason))
  }
}
```

**面试讲解要点（总-分-总）：**

总：Promise 的核心是状态机 + 回调暂存 + 微任务调度。

分：
- 状态机：pending → fulfilled/rejected，不可逆，用 `#state` 守卫
- 回调暂存：pending 时把 then 的回调存起来，resolve/reject 时遍历执行
- 链式调用：then 返回新 Promise，内部根据回调返回值决定新 Promise 的状态
- 微任务：用 queueMicrotask 保证 then 回调异步执行

总：整个实现的关键 tradeoff 是用闭包 + 回调队列代替同步阻塞，这也是 Promise 解决回调地狱的本质。
</details>

---

**✏️ 手写题 4：Promise.all**

```js
MyPromise.all = function(promises) {
  // 你的实现
}

// 测试
MyPromise.all([
  MyPromise.resolve(1),
  new MyPromise(r => setTimeout(() => r(2), 100)),
  MyPromise.resolve(3)
]).then(console.log) // [1, 2, 3]
```

<details>
<summary>参考实现</summary>

```js
MyPromise.all = function(promises) {
  return new MyPromise((resolve, reject) => {
    const results = []
    let count = 0
    const arr = Array.from(promises)

    if (arr.length === 0) return resolve([])

    arr.forEach((p, i) => {
      // 用 Promise.resolve 包一层，处理非 Promise 值
      MyPromise.resolve(p).then(
        (value) => {
          results[i] = value  // 注意用 i 而不是 push，保证顺序
          count++
          if (count === arr.length) resolve(results)
        },
        reject  // 任意一个 reject 就整体 reject
      )
    })
  })
}
```

**易错点：** 用 `count` 而不是 `results.length` 判断完成，因为 `results[2] = x` 会让 length 变成 3 但 index 0、1 可能还是 empty。
</details>

---

**✏️ 手写题 5：Promise.race**

```js
MyPromise.race = function(promises) {
  return new MyPromise((resolve, reject) => {
    const arr = Array.from(promises)
    arr.forEach(p => {
      MyPromise.resolve(p).then(resolve, reject)
    })
    // 第一个 settled 的会触发 resolve/reject
    // 后续调用会被 Promise 的状态不可逆特性忽略
  })
}
```

---

### 1.3 this 指向

**五条规则（优先级从高到低）：**

1. `new` 绑定 → this 指向新创建的实例
2. 显式绑定 → `call / apply / bind` 指定的对象
3. 隐式绑定 → 调用时的上下文对象（`obj.fn()` → this 是 obj）
4. 默认绑定 → 非严格模式 window，严格模式 undefined
5. 箭头函数 → **没有自己的 this**，继承定义时外层函数的 this（词法 this）

**高频陷阱：**

```js
const obj = {
  name: 'obj',
  getName: function() { return this.name },
  getNameArrow: () => this.name  // 这里的 this 是模块/全局的 this，不是 obj
}

const fn = obj.getName
fn()         // undefined（默认绑定，隐式绑定丢失）
obj.getName() // 'obj'（隐式绑定）
```

**追问：** `bind` 返回的函数再 `bind` 有效吗？
**答：** 无效。`bind` 只生效一次，第二次 `bind` 不会覆盖第一次的 this 绑定。

---

### 1.4 闭包

**定义：** 函数能够访问其定义时所在的词法作用域中的变量，即使该函数在其他作用域中执行。

**本质：** 函数对象内部持有对其外部词法环境（LexicalEnvironment）的引用，GC 不会回收被引用的变量。

**经典问题与解法：**

```js
// 问题：循环中的闭包
for (var i = 0; i < 3; i++) {
  setTimeout(() => console.log(i), 0)
}
// 输出 3, 3, 3 —— 共享同一个 i

// 解法 1：let（块级作用域，每轮循环创建新绑定）
for (let i = 0; i < 3; i++) {
  setTimeout(() => console.log(i), 0)
}

// 解法 2：IIFE（手动创建新作用域）
for (var i = 0; i < 3; i++) {
  ((j) => setTimeout(() => console.log(j), 0))(i)
}
```

**你项目中的闭包实践：**
Day 4 踩坑 —— `queue` 和 `flushQueue` 必须在同一个闭包中。如果 `flushQueue` 捕获的是旧的 `queue` 引用，push 到新 queue 的数据 flushQueue 读不到。这是闭包 + 引用共享的典型问题。

---

### 1.5 原型链

**核心关系：**

```
实例.__proto__ === 构造函数.prototype
构造函数.prototype.constructor === 构造函数
构造函数.__proto__ === Function.prototype
Function.prototype.__proto__ === Object.prototype
Object.prototype.__proto__ === null
```

**属性查找：** 沿着 `__proto__` 链向上查找，找到就返回，到 `null` 就返回 `undefined`

**`instanceof` 原理：** 沿着左侧对象的原型链查找，看是否有节点 === 右侧构造函数的 `prototype`

---

**✏️ 手写题 6：手写 instanceof**

```js
function myInstanceof(obj, Constructor) {
  if (obj === null || typeof obj !== 'object') return false
  let proto = Object.getPrototypeOf(obj)
  while (proto !== null) {
    if (proto === Constructor.prototype) return true
    proto = Object.getPrototypeOf(proto)
  }
  return false
}
```

---

**✏️ 手写题 7：手写 new**

```js
function myNew(Constructor, ...args) {
  // 1. 创建空对象，原型指向构造函数的 prototype
  const obj = Object.create(Constructor.prototype)
  // 2. 执行构造函数，this 绑定到新对象
  const result = Constructor.apply(obj, args)
  // 3. 如果构造函数返回了对象，就用它；否则返回新对象
  return result !== null && typeof result === 'object' ? result : obj
}
```

---

### 1.6 其他高频手写

**✏️ 手写题 8：防抖 debounce**

```js
function debounce(fn, delay, immediate = false) {
  let timer = null
  return function(...args) {
    const callNow = immediate && !timer
    clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      if (!immediate) fn.apply(this, args)
    }, delay)
    if (callNow) fn.apply(this, args)
  }
}
```

**✏️ 手写题 9：节流 throttle**

```js
function throttle(fn, interval) {
  let lastTime = 0
  return function(...args) {
    const now = Date.now()
    if (now - lastTime >= interval) {
      lastTime = now
      fn.apply(this, args)
    }
  }
}
```

**✏️ 手写题 10：深拷贝（处理循环引用）**

```js
function deepClone(obj, map = new WeakMap()) {
  if (obj === null || typeof obj !== 'object') return obj
  if (map.has(obj)) return map.get(obj) // 处理循环引用

  const clone = Array.isArray(obj) ? [] : {}
  map.set(obj, clone)

  for (const key of Reflect.ownKeys(obj)) {
    clone[key] = deepClone(obj[key], map)
  }
  return clone
}
```

**追问：** 为什么用 `WeakMap` 而不是 `Map`？
**答：** WeakMap 的 key 是弱引用，不阻止 GC 回收原对象。如果用 Map，clone 完成后 map 仍然持有所有原对象的强引用，造成内存泄漏。

**追问：** 为什么用 `Reflect.ownKeys` 而不是 `Object.keys`？
**答：** `Reflect.ownKeys` 能拿到 Symbol 键 + 不可枚举属性，`Object.keys` 只拿可枚举的字符串键。

---

**✏️ 手写题 11：柯里化 curry**

```js
function curry(fn) {
  return function curried(...args) {
    if (args.length >= fn.length) {
      return fn.apply(this, args)
    }
    return function(...moreArgs) {
      return curried.apply(this, [...args, ...moreArgs])
    }
  }
}

// 测试
const add = (a, b, c) => a + b + c
const curried = curry(add)
curried(1)(2)(3)    // 6
curried(1, 2)(3)    // 6
curried(1)(2, 3)    // 6
```

---

**✏️ 手写题 12：call / apply / bind**

```js
// call
Function.prototype.myCall = function(context, ...args) {
  context = context ?? globalThis
  context = Object(context) // 处理原始值
  const key = Symbol()
  context[key] = this
  const result = context[key](...args)
  delete context[key]
  return result
}

// apply（只是参数形式不同）
Function.prototype.myApply = function(context, args = []) {
  context = context ?? globalThis
  context = Object(context)
  const key = Symbol()
  context[key] = this
  const result = context[key](...args)
  delete context[key]
  return result
}

// bind
Function.prototype.myBind = function(context, ...outerArgs) {
  const fn = this
  return function bound(...innerArgs) {
    // 如果作为构造函数调用（new bound()），this 指向实例
    if (new.target) {
      return new fn(...outerArgs, ...innerArgs)
    }
    return fn.apply(context, [...outerArgs, ...innerArgs])
  }
}
```

---

**✏️ 手写题 13：EventEmitter**

```js
class EventEmitter {
  #events = new Map()

  on(event, fn) {
    if (!this.#events.has(event)) this.#events.set(event, [])
    this.#events.get(event).push(fn)
    return this
  }

  off(event, fn) {
    const fns = this.#events.get(event)
    if (!fns) return this
    this.#events.set(event, fns.filter(f => f !== fn && f._original !== fn))
    return this
  }

  once(event, fn) {
    const wrapper = (...args) => {
      fn.apply(this, args)
      this.off(event, wrapper)
    }
    wrapper._original = fn // 支持 off 时用原函数移除
    this.on(event, wrapper)
    return this
  }

  emit(event, ...args) {
    const fns = this.#events.get(event)
    if (!fns) return false
    fns.forEach(fn => fn.apply(this, args))
    return true
  }
}
```

---

**✏️ 手写题 14：数组扁平化 flat**

```js
// 递归版
function flat(arr, depth = 1) {
  if (depth <= 0) return arr.slice()
  return arr.reduce((acc, item) => {
    return acc.concat(Array.isArray(item) ? flat(item, depth - 1) : item)
  }, [])
}

// Infinity 深度版（迭代，避免栈溢出）
function flatDeep(arr) {
  const stack = [...arr]
  const result = []
  while (stack.length) {
    const item = stack.pop()
    if (Array.isArray(item)) {
      stack.push(...item)
    } else {
      result.unshift(item)
    }
  }
  return result
}
```

---

## 二、TypeScript

### 2.1 泛型 + 约束

```ts
// 基本约束
function getProperty<T, K extends keyof T>(obj: T, key: K): T[K] {
  return obj[key]
}

// 多重约束
function merge<T extends object, U extends object>(a: T, b: U): T & U {
  return { ...a, ...b }
}
```

**追问：** `keyof` 作用于联合类型和交叉类型时的区别？
```ts
keyof (A | B)  // 得到 A 和 B 的公共键（交集）
keyof (A & B)  // 得到 A 和 B 的所有键（并集）
```
记忆：`keyof` 对类型运算的结果和直觉相反，因为联合类型上只能安全访问公共属性。

---

### 2.2 工具类型手写

**✏️ 手写题 15：Partial / Required / Readonly / Pick / Omit**

```ts
// Partial：所有属性变可选
type MyPartial<T> = {
  [K in keyof T]?: T[K]
}

// Required：所有属性变必选（-? 去掉可选修饰符）
type MyRequired<T> = {
  [K in keyof T]-?: T[K]
}

// Readonly
type MyReadonly<T> = {
  readonly [K in keyof T]: T[K]
}

// Pick
type MyPick<T, K extends keyof T> = {
  [P in K]: T[P]
}

// Omit = Pick 取反
type MyOmit<T, K extends keyof T> = {
  [P in keyof T as P extends K ? never : P]: T[P]
}
// 或者
type MyOmit2<T, K extends keyof T> = MyPick<T, Exclude<keyof T, K>>
```

---

### 2.3 条件类型 + infer

```ts
// Exclude / Extract
type MyExclude<T, U> = T extends U ? never : T
type MyExtract<T, U> = T extends U ? T : never

// ReturnType
type MyReturnType<T extends (...args: any[]) => any> = 
  T extends (...args: any[]) => infer R ? R : never

// Parameters
type MyParameters<T extends (...args: any[]) => any> = 
  T extends (...args: infer P) => any ? P : never
```

**条件类型的分发特性：**
```ts
// 当 T 是联合类型时，条件类型会分发到每个成员
type ToArray<T> = T extends any ? T[] : never
type Result = ToArray<string | number>
// = (string extends any ? string[] : never) | (number extends any ? number[] : never)
// = string[] | number[]

// 阻止分发：用方括号包裹
type ToArrayNoDistribute<T> = [T] extends [any] ? T[] : never
type Result2 = ToArrayNoDistribute<string | number>
// = (string | number)[]
```

---

### 2.4 项目中的实际运用

```ts
// 你的 updateMessage 接口设计
type UpdatePayload = Omit<Partial<Message>, 'id'>
// 意义：允许更新 Message 的任意字段，但 id 不可变
// 面试讲法：通过组合工具类型在类型层面表达业务约束——"消息可以部分更新，但 id 永远不能改"

// StreamController 显式 interface vs ReturnType 推断
// 稳定的公开 API → 用 interface 显式声明（文档性、IDE 提示）
// 内部工具函数 → 用 ReturnType 推断（跟随实现变化，减少维护成本）
```

---

## 三、Vue 3 源码

### 3.1 响应式系统

**核心三件套：reactive / ref / effect**

```
reactive(obj)
  → new Proxy(obj, { get: track, set: trigger })
    → get 时：track(target, key) → 收集当前活跃的 effect
    → set 时：trigger(target, key) → 执行所有依赖该 key 的 effect
```

**依赖收集数据结构：**
```
targetMap: WeakMap<target, Map<key, Set<effect>>>
```
- 外层 WeakMap：以原始对象为 key（弱引用，不阻止 GC）
- 中层 Map：以属性名为 key
- 内层 Set：存放依赖该属性的所有 effect（自动去重）

**ref vs reactive：**
- `ref` 用于基本类型，通过 `.value` 的 getter/setter 触发依赖收集
- `reactive` 用于对象，通过 Proxy 拦截
- `ref` 包裹对象时，内部会调用 `reactive` 处理 `.value`

**高频追问：**

- Q：为什么用 Proxy 不用 Object.defineProperty？
- A：三个原因：(1) Proxy 可以拦截数组索引赋值和 length 变化，defineProperty 不行；(2) Proxy 可以拦截属性新增/删除；(3) Proxy 是惰性的，不需要递归遍历整个对象预先定义 getter/setter。

- Q：依赖收集什么时候触发？
- A：effect 函数执行时访问响应式属性触发 get → track。组件的 render 函数就是一个 effect，渲染时读取模板中的变量就会触发 track。

- Q：`shallowReactive` / `shallowRef` 是什么？
- A：只代理第一层，深层对象不做响应式处理。用于性能优化（大对象只关心顶层变化时）。

---

### 3.2 Scheduler（调度器）

**核心机制：**

```
组件状态变化
  → trigger
  → 不立即执行 render effect
  → 而是调用 queueJob(componentUpdateFn) 推入任务队列
  → queueFlush() 用 Promise.resolve().then(flushJobs) 调度
  → 微任务阶段一次性执行所有 job（已去重、已排序）
```

**queueJob 的去重 + 排序：**
- 去重：同一个 effect 不会重复入队（通过 id 或引用判断）
- 排序：父组件 job 排在子组件前面（保证先更新父再更新子）

**nextTick 的本质：**
```js
function nextTick(fn) {
  return fn ? currentFlushPromise.then(fn) : currentFlushPromise
}
```
就是把回调排在 flushJobs 的 Promise 链后面。如果没有正在调度的 flush，就创建一个 `Promise.resolve()` 作为 `currentFlushPromise`。

**面试讲法：** Vue 3 的更新是「批量异步」的 —— 同步修改多个响应式变量，只会触发一次组件更新。这是通过微任务调度 + 任务去重实现的。

---

### 3.3 Diff 算法（双端 + 最长递增子序列）

**整体流程（patchKeyedChildren）：**

1. **头头对比**：新旧数组从头开始比，相同的直接 patch，指针后移
2. **尾尾对比**：新旧数组从尾开始比，相同的直接 patch，指针前移
3. **新增的处理**：旧数组比完了新数组还有剩 → 批量 mount
4. **删除的处理**：新数组比完了旧数组还有剩 → 批量 unmount
5. **乱序的处理**（核心）：
    - 建立新数组的 key → index 映射（Map）
    - 遍历旧数组中间部分，通过 key 查找在新数组中的位置
    - 找不到的 → unmount
    - 找到的 → 记录到 `newIndexToOldIndexMap`
    - 对 `newIndexToOldIndexMap` 求**最长递增子序列（LIS）**
    - LIS 中的元素不需要移动，其余元素需要移动

**为什么用 LIS？**
LIS 表示可以保持相对顺序不动的最大节点集合。只移动不在 LIS 中的节点，可以最小化 DOM 操作。

**为什么需要 key？**
没有 key 时，Vue 只能按位置逐个 patch（就地更新策略），无法识别节点的移动和复用。有 key 后可以建立 key → vnode 的映射，准确找到可复用节点。

---

### 3.4 Compiler 优化

**patchFlag：** 编译器在生成 vnode 时标记节点的动态部分类型
```
TEXT = 1        // 动态文本
CLASS = 2       // 动态 class
STYLE = 4       // 动态 style
PROPS = 8       // 动态属性（非 class/style）
FULL_PROPS = 16 // 有动态 key 的属性，需要完整 diff
```

**Block Tree：**
- 编译器把模板按「结构稳定」的区域划分成 Block
- 每个 Block 收集内部所有动态节点到 `dynamicChildren` 数组
- patch 时直接遍历 `dynamicChildren`，跳过静态节点 → O(动态节点数) 而非 O(全部节点数)

**静态提升（hoistStatic）：**
- 纯静态节点只创建一次，后续 render 复用引用
- 减少 vnode 创建开销和 GC 压力

**面试讲法：** Vue 3 的编译器做了三件事来优化运行时性能：patchFlag 让 diff 知道节点的哪些部分是动态的，Block Tree 让 diff 只关注动态节点，静态提升避免重复创建不变的 vnode。

---

## 四、浏览器

### 4.1 渲染流水线

```
HTML → DOM Tree
CSS  → CSSOM
         ↓
     Render Tree（DOM + CSSOM 合并，display:none 的节点不进入）
         ↓
     Layout（计算几何信息：位置、大小）
         ↓
     Paint（生成绘制指令：颜色、边框、阴影）
         ↓
     Raster（光栅化：指令 → 像素位图，可能在 GPU 线程）
         ↓
     Composite（合成层合并，最终输出到屏幕）
```

---

### 4.2 回流 / 重绘 / 合成

| 类型 | 触发条件 | 开销 | 跳过的阶段 |
|------|---------|------|-----------|
| 回流 Reflow | 几何变化（宽高、位置、字体大小、DOM 增删） | 最高 | 无，从 Layout 重新开始 |
| 重绘 Repaint | 外观变化（颜色、背景、visibility） | 中等 | 跳过 Layout |
| 合成 Composite | transform / opacity 变化 | 最低 | 跳过 Layout + Paint |

**Layout Thrashing（强制同步布局）：**
```js
// 反模式：读写交替
for (let i = 0; i < elements.length; i++) {
  const height = elements[i].offsetHeight  // 读 → 触发同步 Layout
  elements[i].style.height = height + 10 + 'px'  // 写 → 布局失效
}

// 优化：先批量读，再批量写
const heights = elements.map(el => el.offsetHeight)
elements.forEach((el, i) => {
  el.style.height = heights[i] + 10 + 'px'
})
```

**GPU 合成层触发条件：**
- `transform` / `opacity` 动画
- `will-change: transform`
- `position: fixed`
- `<video>` / `<canvas>` / CSS filter

**追问：** `transform: translateZ(0)` 有什么用？
**答：** 创建独立合成层（GPU 加速），变化时不需要重绘其他层。但不要滥用，合成层过多会增加 GPU 内存占用。

---

### 4.3 性能优化要点（和你项目相关）

**你项目中用到的优化策略：**

1. **rAF + queue 调度打字机效果**：用 requestAnimationFrame 批量消费 token，避免每个 token 都触发 DOM 更新
2. **滚动中断检测**：用 passive: true 的 scroll 事件 + 节流，避免阻塞滚动
3. **Markdown 异步渲染**：流式结束后才解析 Markdown，避免流式过程中反复 re-parse

---

## 五、Node.js / 后端

### 5.1 流式处理（你项目的核心）

**Node Stream 四种类型：** Readable / Writable / Duplex / Transform

**你的流式代理架构：**
```
客户端 ← SSE/NDJSON ← Fastify 后端 ← HTTP Stream ← Ollama
```

**关键实现点：**
- 后端从 Ollama 拿到 Readable Stream，边读边通过 response 转发给前端
- NDJSON 格式：每行一个 JSON 对象，以 `\n` 分隔
- 前端用 `fetch` + `ReadableStream` + `TextDecoder` 逐块解析

**面试讲法：** 流式架构的核心 tradeoff 是「首字节延迟 vs 整体吞吐」。传统 API 是等模型生成完再返回（高延迟、高吞吐），流式是生成一个 token 就发一个（低延迟、适合交互场景）。我的实现是后端做透明代理，边从 Ollama 读边向前端转发 NDJSON 流。

---

### 5.2 RAG Pipeline（你的核心技术亮点）

**全链路：**
```
文件上传 → 文本提取（PDF/TXT）→ 切片（chunk）→ 向量化（embedding）→ 存储 → 检索 → 注入 prompt
```

**切片策略（面试重点）：**
- 按段落累加，到达阈值就切一片
- overlap：相邻切片重叠一部分文本，防止语义在边界断裂
- 超长段落：按句号二次分割

**向量检索：**
- Ollama `/api/embed` 生成向量
- 余弦相似度计算：`cos(A, B) = (A·B) / (|A| × |B|)`
- 取 Top-K 相似切片注入 system prompt

**面试追问准备：**

- Q：为什么要 overlap？
- A：防止关键信息刚好在切片边界被截断。比如一个概念跨两段，没有 overlap 的话两个切片各自只有一半信息，检索时匹配度都不高。

- Q：chunk size 怎么定？
- A：tradeoff 是粒度和上下文。太小（<100 token）→ 丢失上下文，匹配精准但信息不完整。太大（>1000 token）→ 噪声多，影响检索精度。一般 200-500 token 是比较平衡的区间。

- Q：余弦相似度 vs 欧氏距离？
- A：余弦关注方向（语义角度），欧氏关注距离（数值绝对差异）。文本向量通常维度高且稀疏，余弦相似度更稳定。

- Q：内存 vector store 的局限？后续怎么升级？
- A：重启丢失、无法持久化、不支持大规模数据。下一步方案：SQLite + 向量扩展（简单持久化），或者上 Chroma / Milvus 等专用向量数据库。

---

## 六、架构 / 设计模式 / 工程化

### 6.1 你的抽象方法论：「找不变量」五步法

```
1. 列出所有动作（handleSend / handleRetry / handleContinue）
2. 圈出共有逻辑（创建流、消费 token、更新消息状态）
3. 圈出差异（消息来源不同：新建 / 已有失败消息 / 已有暂停消息）
4. 给共有逻辑起名（runStream）
5. 各入口函数只做准备工作，然后调用 runStream
```

**面试讲法：** 重构的核心不是代码技巧，是识别「变与不变」。我把三个消息动作的共有流程抽成 `runStream`，每个入口函数只负责准备 payload。这样新增第四种消息动作时，只需要写一个新入口函数，核心流程零改动。

---

### 6.2 状态守卫设计

你项目中的状态守卫体系：

```
入口守卫：isStreaming → 防止并发请求
状态校验：message.status → 确认可操作
中断信号：AbortController → 取消网络请求
资源清理：finally → 重置 queue / isFlushing / isStreaming
职责分离：handleStop 只中断流，onDone 统一设状态
```

**面试讲法：** 流式交互最容易出 bug 的地方是状态不一致 —— 比如用户快速点发送、中断、重试。我的方案是分层守卫：入口层防并发，业务层校验状态，网络层用 AbortController 取消请求，finally 层兜底清理。每一层只管自己的职责。

---

## 七、算法手写题（面试高频）

### ✏️ 手写题 16：数组去重

```js
// Set
const unique = arr => [...new Set(arr)]

// 手动（保留首次出现的顺序）
function unique(arr) {
  const seen = new Map()
  return arr.filter(item => {
    if (seen.has(item)) return false
    seen.set(item, true)
    return true
  })
}
```

---

### ✏️ 手写题 17：发布订阅 vs 观察者模式

```
观察者模式：Subject 直接维护 observer 列表，耦合度较高
发布订阅：Publisher → EventChannel → Subscriber，中间有调度中心，解耦

Vue 的响应式是观察者模式（effect 直接注册到 dep 中）
EventEmitter 是发布订阅模式
```

---

### ✏️ 手写题 18：LRU Cache

```js
class LRUCache {
  #capacity
  #cache = new Map() // Map 保持插入顺序

  constructor(capacity) {
    this.#capacity = capacity
  }

  get(key) {
    if (!this.#cache.has(key)) return -1
    const value = this.#cache.get(key)
    // 移到最新位置
    this.#cache.delete(key)
    this.#cache.set(key, value)
    return value
  }

  put(key, value) {
    if (this.#cache.has(key)) {
      this.#cache.delete(key)
    } else if (this.#cache.size >= this.#capacity) {
      // 删除最久未使用的（Map 的第一个）
      const oldestKey = this.#cache.keys().next().value
      this.#cache.delete(oldestKey)
    }
    this.#cache.set(key, value)
  }
}
```

**面试讲法：** 利用 `Map` 的插入顺序特性（ES6 规范保证），每次访问就删除再插入到末尾，淘汰时删第一个。时间复杂度 get/put 都是 O(1)。传统方案用双向链表 + HashMap，但 JS 的 Map 天然有序，可以省掉链表。

---

### ✏️ 手写题 19：异步并发控制

```js
async function asyncPool(limit, items, fn) {
  const results = []
  const executing = new Set()

  for (const [index, item] of items.entries()) {
    const p = Promise.resolve().then(() => fn(item, index))
    results.push(p)
    executing.add(p)

    const cleanup = () => executing.delete(p)
    p.then(cleanup, cleanup)

    if (executing.size >= limit) {
      await Promise.race(executing)
    }
  }

  return Promise.all(results)
}

// 使用
const urls = [url1, url2, url3, url4, url5]
const results = await asyncPool(2, urls, fetch) // 最多同时 2 个请求
```

---

### ✏️ 手写题 20：compose 函数组合

```js
function compose(...fns) {
  return function(input) {
    return fns.reduceRight((acc, fn) => fn(acc), input)
  }
}

// pipe（从左到右）
function pipe(...fns) {
  return function(input) {
    return fns.reduce((acc, fn) => fn(acc), input)
  }
}

// 测试
const add1 = x => x + 1
const double = x => x * 2
compose(double, add1)(5) // double(add1(5)) = 12
pipe(add1, double)(5)    // double(add1(5)) = 12
```

---

## 八、项目面试话术模板

### 总-分-总 结构示例

**Q：你项目最有技术含量的地方是什么？**

**总：** 我觉得是流式输出的完整状态管理体系，和 RAG 全链路的从零实现。

**分（流式）：**
- 流式交互的难点不在于拿到数据流，而在于状态一致性。用户可以在任意时刻发送、中断、重试、继续，这四个动作需要和 streaming 状态、消息状态、网络请求三者协调。
- 我设计了分层守卫：入口层用 `isStreaming` 防并发，业务层校验消息 status，网络层用 AbortController 取消请求，finally 层兜底清理。
- 最终把三个入口函数的共有逻辑抽成 `runStream`，用「找不变量」方法论做的抽象。

**分（RAG）：**
- 从文件上传到 prompt 注入是一条完整链路：提取 → 切片（带 overlap）→ 向量化 → 余弦检索 → Top-K 注入。
- 切片策略是自己写的，不是用现成库。做了段落累加 + overlap + 超长段落二次分割。
- 向量化用 Ollama 本地 embedding，不依赖外部 API，完全离线可用。

**总：** 这两个模块让我理解了 AI 应用工程的两个核心问题：一是前端和模型之间的实时交互怎么做得稳定，二是怎么让模型获得上下文之外的知识。

---

## 九、快速自检清单

面试前过一遍，每个能用一两句话讲清楚就行：

**JS：**
- [ ] Event Loop 执行顺序（宏→微→渲染）
- [ ] Promise 状态机 + then 链式原理
- [ ] this 五条规则优先级
- [ ] 闭包定义 + 循环经典问题
- [ ] 原型链查找路径

**TS：**
- [ ] 泛型约束 `extends`
- [ ] 映射类型 `[K in keyof T]`
- [ ] 条件类型 + 分发特性
- [ ] infer 在什么位置推断什么

**Vue3：**
- [ ] 响应式：Proxy → track → trigger → effect
- [ ] 调度器：queueJob → microtask 批量更新
- [ ] Diff：双端对比 + LIS
- [ ] 编译优化：patchFlag + Block Tree + 静态提升

**浏览器：**
- [ ] 渲染流水线六步
- [ ] 回流 vs 重绘 vs 合成的触发条件和开销
- [ ] Layout Thrashing 原因和解法

**项目：**
- [ ] 流式输出：rAF + queue 调度
- [ ] 状态守卫：分层设计
- [ ] 抽象方法论：「找不变量」五步法
- [ ] RAG 全链路：每个环节的作用和 tradeoff
- [ ] 总-分-总表达：每个功能能讲 3-5 分钟