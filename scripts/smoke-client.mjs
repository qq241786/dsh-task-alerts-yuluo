#!/usr/bin/env node
/**
 * dsh-task-alerts — browser-half smoke test (contract §7/§8, no DOM, no deps).
 *
 * The compiled `lib/client.js` is a browser artifact, so this script fakes the
 * whole browser surface on `globalThis` — `window`, `document`, `require`,
 * `fetch`, and a recording pass-through `setTimeout`/`clearTimeout` that never
 * keeps the process alive — and drives the module the way the DSH web client
 * would: capture the `__ModuleLoader__.load` descriptor, call the factory,
 * invoke `apply(ctx)` with a recording fake ctx, dispatch a hotkey, click the
 * rendered controls, then tear everything down.
 *
 * Every assertion prints its own PASS/FAIL line with the observed value;
 * `process.exitCode` carries the verdict.
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const CLIENT_JS = join(ROOT, 'lib', 'client.js')

let failures = 0
let checks = 0

function check(label, ok, detail) {
  checks += 1
  if (!ok) failures += 1
  const suffix = detail === undefined ? '' : ` — ${detail}`
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}${suffix}\n`)
}

const flush = () => new Promise((done) => setImmediate(done))

// ------------------------------------------------------------ 0. syntax -----

const syntax = spawnSync(process.execPath, ['--check', CLIENT_JS], { encoding: 'utf8' })
check(
  'node --check lib/client.js exits 0',
  syntax.status === 0,
  `exit=${syntax.status}${syntax.stderr ? ' ' + String(syntax.stderr).trim().split('\n')[0] : ''}`,
)
if (syntax.status !== 0) {
  process.stdout.write('\nclient half does not parse; aborting.\n')
  process.exit(1)
}

const source = readFileSync(CLIENT_JS, 'utf8')
check('lib/client.js is non-empty', source.length > 0, `${Buffer.byteLength(source, 'utf8')} bytes`)

// ------------------------------------------------------- 1. fake browser ----

const loads = []
const headChildren = []
const listeners = new Map()
const requests = []
const timers = new Map()
const warnings = []
const mediaListeners = []

let timerSeq = 0

function fakeElement(tagName) {
  return {
    tagName: String(tagName || '').toLowerCase(),
    nodeType: 1,
    attrs: {},
    children: [],
    parentNode: null,
    textContent: '',
    style: {},
    setAttribute(name, value) {
      this.attrs[String(name)] = String(value)
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, String(name)) ? this.attrs[String(name)] : null
    },
    appendChild(child) {
      this.children.push(child)
      if (child && typeof child === 'object') child.parentNode = this
      return child
    },
    removeChild(child) {
      const at = this.children.indexOf(child)
      if (at >= 0) this.children.splice(at, 1)
      if (child && typeof child === 'object') child.parentNode = null
      return child
    },
    addEventListener() {},
    removeEventListener() {},
  }
}

const head = fakeElement('head')
const body = fakeElement('body')

const documentStub = {
  head,
  body,
  documentElement: fakeElement('html'),
  readyState: 'complete',
  createElement: (tag) => fakeElement(tag),
  createTextNode: (text) => ({ nodeType: 3, nodeValue: String(text) }),
  querySelector: (selector) => {
    if (selector === 'style[data-dsa-style]') {
      return head.children.find((child) => child.attrs && child.attrs['data-dsa-style'] !== undefined) || null
    }
    return null
  },
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
}

const mediaQuery = {
  matches: false,
  media: '(prefers-color-scheme: dark)',
  addEventListener(type, handler) {
    if (type === 'change') mediaListeners.push(handler)
  },
  removeEventListener(type, handler) {
    const at = mediaListeners.indexOf(handler)
    if (at >= 0) mediaListeners.splice(at, 1)
  },
  addListener() {},
  removeListener() {},
}

const windowStub = {
  __ModuleLoader__: {
    load(descriptor) {
      loads.push(descriptor)
    },
  },
  addEventListener(type, handler) {
    const list = listeners.get(type) || []
    list.push(handler)
    listeners.set(type, list)
  },
  removeEventListener(type, handler) {
    const list = listeners.get(type) || []
    listeners.set(type, list.filter((item) => item !== handler))
  },
  matchMedia: () => mediaQuery,
  location: { href: 'http://localhost/', origin: 'http://localhost' },
}

function record(url, init) {
  const entry = { url: String(url), method: (init && init.method) || 'GET', body: init && init.body }
  requests.push(entry)
  return entry
}

function sampleState() {
  return {
    revision: 7,
    generatedAt: new Date().toISOString(),
    config: {
      hotkey: 'ctrl+alt+s',
      ui: { blurStrength: 12, primaryColor: '#87CEEB', borderRadius: 18, opacity: 0.66 },
      programFinishAlert: true,
      alertOnUnresolved: true,
      maxAttempts: 2,
      reportDir: 'E:/deepseek work/dsh-task-alerts/reports',
    },
    stats: { problems: 1, unresolved: 1, alerts: 2 },
    audioPlaying: false,
    alerts: [
      {
        id: 'al_2',
        kind: 'unresolved',
        level: 'error',
        title: '未解决的问题',
        message: '两次尝试后仍未解决',
        problemId: 'p_1',
        attempts: 2,
        maxAttempts: 2,
        reportPath: 'E:/deepseek work/dsh-task-alerts/reports/p_1.txt',
        createdAt: new Date().toISOString(),
        audio: true,
        dismissed: false,
      },
      {
        id: 'al_1',
        kind: 'finish',
        level: 'success',
        title: '程序完成',
        message: '任务已结束',
        createdAt: new Date().toISOString(),
        audio: true,
        dismissed: false,
      },
    ],
  }
}

const fetchStub = (input, init) => {
  const entry = record(input, init)
  return Promise.resolve({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () =>
      entry.url.indexOf('/task-alerts/control') >= 0 ? { ok: true, state: sampleState() } : sampleState(),
  })
}

const reactStub = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props || {}), children: children.length <= 1 ? children[0] : children } }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect() {},
  useRef(initial) {
    return { current: typeof initial === 'function' ? initial() : initial }
  },
  useCallback(fn) {
    return fn
  },
  Fragment: 'Fragment',
}

const requireStub = (id) => {
  if (id === 'react') return reactStub
  throw new Error(`unexpected require("${id}")`)
}

const fakeSetTimeout = (handler, ms) => {
  const id = ++timerSeq
  timers.set(id, { handler, ms })
  return id
}
const fakeClearTimeout = (id) => {
  timers.delete(id)
}
windowStub.setTimeout = fakeSetTimeout
windowStub.clearTimeout = fakeClearTimeout

const realConsole = globalThis.console
globalThis.console = {
  log: (...args) => realConsole.log(...args),
  info: (...args) => realConsole.log(...args),
  warn: (...args) => {
    warnings.push(args.join(' '))
  },
  error: (...args) => realConsole.error(...args),
  debug: () => {},
}

// Installed on globalThis: under `module: none` the artifact is a plain script
// that reads these as free variables.
globalThis.window = windowStub
globalThis.document = documentStub
globalThis.require = requireStub
globalThis.fetch = fetchStub
globalThis.setTimeout = fakeSetTimeout
globalThis.clearTimeout = fakeClearTimeout

// ------------------------------------------------------ 2. load the module --

const moduleExports = await import(`file:///${CLIENT_JS.replace(/\\/g, '/')}`)
check('lib/client.js executes without throwing', moduleExports !== null)

// ------------------------------------------------------------- 3. load() ----

check('__ModuleLoader__.load called exactly once', loads.length === 1, `calls=${loads.length}`)
const descriptor = loads[0]
if (!descriptor) {
  process.stdout.write('\nno module descriptor captured; aborting.\n')
  process.exit(1)
}
check("load({ id }) uses id 'dsh-task-alerts-yuluo'", descriptor.id === 'dsh-task-alerts-yuluo', `id=${String(descriptor.id)}`)
check('load({ factory }) is a function', typeof descriptor.factory === 'function', `type=${typeof descriptor.factory}`)

check(
  'load({ factory }) takes the loader-provided require parameter',
  descriptor.factory.length === 1,
  `arity=${descriptor.factory.length}`,
)

// Regression test for the crash that made the harness unbootable: a factory
// WITHOUT a require parameter threw "require is not defined", which the loader
// reports as "1 entry did not activate" and treats as a fatal web-boot failure.
// The factory must instead degrade to an activating no-op plugin.
try {
  const degraded = descriptor.factory(undefined)
  check(
    'factory(no usable require) degrades to an activating no-op instead of throwing',
    !!degraded &&
      Array.isArray(degraded.inject) &&
      degraded.inject.length === 0 &&
      typeof degraded.apply === 'function',
    `inject=${JSON.stringify(degraded && degraded.inject)} apply=${typeof (degraded && degraded.apply)}`,
  )
} catch (error) {
  check(
    'factory(no usable require) degrades to an activating no-op instead of throwing',
    false,
    `threw ${error && error.message}`,
  )
}

const factoryResult = descriptor.factory(requireStub)
check('factory() returns an object', !!factoryResult && typeof factoryResult === 'object')
check(
  "factory().inject includes 'slots'",
  !!factoryResult && Array.isArray(factoryResult.inject) && factoryResult.inject.indexOf('slots') >= 0,
  `inject=${JSON.stringify(factoryResult && factoryResult.inject)}`,
)
check('factory().apply is a function', typeof factoryResult.apply === 'function', `type=${typeof factoryResult.apply}`)

// ------------------------------------------------------- 4. apply(ctx) -----

/** A recording client ctx: every service call is captured, `slots.inject` fires immediately. */
function captureCtx() {
  const record = { injectedKeys: [], registrations: [], effectCalls: [], disposer: null }
  record.ctx = {
    slots: {
      inject(key, callback) {
        record.injectedKeys.push(key)
        callback()
      },
      register(options, component) {
        record.registrations.push({ options, component })
        return () => {}
      },
    },
    theme: {
      getTheme: () => ({
        active: { colorScheme: 'dark' },
        themes: [],
        revision: 3,
        preference: 'system',
        fontSize: 14,
      }),
      exportInspectTokens: () => [
        { name: 'color.primary', description: 'primary', valueType: 'color', requiresLightAndDark: true },
        { name: 'color.accent', description: 'accent', valueType: 'color', requiresLightAndDark: true },
        { name: 'space.md', description: 'spacing', valueType: 'length', requiresLightAndDark: false },
      ],
      overrideTokens: () => () => {},
    },
    on(event, handler) {
      if (event === 'theme/change') handler({ active: { colorScheme: 'dark' } })
      return () => {}
    },
    effect(callback) {
      record.effectCalls.push(callback)
      record.disposer = callback()
    },
  }
  return record
}

const main = captureCtx()
const ctx = main.ctx
const injectedKeys = main.injectedKeys
const registrations = main.registrations
const effectCalls = main.effectCalls

let applyThrew = null
try {
  factoryResult.apply(ctx)
} catch (error) {
  applyThrew = error
}
check('apply(ctx) does not throw', applyThrew === null, applyThrew ? String(applyThrew && applyThrew.message) : '')

/*
 * Contract §12.7 adds two OPTIONAL slots on top of the two `shell.overlay`
 * seats, so "exactly one inject call / exactly two registrations" stopped
 * being the invariant. These checks keep their labels and their meaning — the
 * overlay seats are still injected first, still target `shell.overlay`, still
 * ascend in order — and the two new slots are asserted in section 13.
 */
check(
  "slots.inject covers 'shell.overlay' and starts with it",
  injectedKeys.indexOf('shell.overlay') === 0,
  `keys=${JSON.stringify(injectedKeys)}`,
)
check('slots.register registered at least the two overlay seats', registrations.length >= 2, `calls=${registrations.length}`)
check(
  "the first two register ids are ['task-alerts.toast', 'task-alerts.panel'] in that order",
  registrations.slice(0, 2).map((entry) => entry.options.id).join(',') === 'task-alerts.toast,task-alerts.panel',
  `ids=${JSON.stringify(registrations.map((entry) => entry.options.id))}`,
)
check(
  "the two overlay seats target 'shell.overlay' with ascending order",
  registrations.slice(0, 2).every((entry) => entry.options.name === 'shell.overlay') &&
    registrations[0].options.order < registrations[1].options.order,
  `orders=${JSON.stringify(registrations.slice(0, 2).map((entry) => entry.options.order))}`,
)
check(
  'every registered entry is a component function',
  registrations.length >= 2 && registrations.every((entry) => typeof entry.component === 'function'),
  `types=${JSON.stringify(registrations.map((entry) => typeof entry.component))}`,
)
check(
  'window.__DSA__ exposes apply / AlertPanel / AlertToastStack',
  !!windowStub.__DSA__ &&
    typeof windowStub.__DSA__.apply === 'function' &&
    typeof windowStub.__DSA__.AlertPanel === 'function' &&
    typeof windowStub.__DSA__.AlertToastStack === 'function',
  `keys=${JSON.stringify(Object.keys(windowStub.__DSA__ || {}))}`,
)
check(
  'window.__DSA__.css carries the stylesheet',
  typeof windowStub.__DSA__.css === 'string' && windowStub.__DSA__.css.indexOf('backdrop-filter') >= 0,
  `length=${String((windowStub.__DSA__.css || '').length)}`,
)

// ------------------------------------------- 5. one poll cycle + polling -----

const scheduled = [...timers.entries()]
check('apply() scheduled a poll timer', scheduled.length === 1, `timers=${scheduled.length}`)
if (scheduled.length > 0) {
  const [id, timer] = scheduled[0]
  timers.delete(id)
  try {
    timer.handler()
  } catch (error) {
    check('poll tick does not throw', false, String(error && error.message))
  }
  await flush()
  await flush()
}

const stateGets = requests.filter(
  (entry) => entry.method === 'GET' && entry.url.indexOf('/task-alerts/state') >= 0,
)
check('a GET /task-alerts/state poll was issued', stateGets.length >= 1, `gets=${stateGets.length}`)
check(
  'the poll URL carries ?since=<revision>',
  stateGets.length > 0 && /\?since=-?\d+/.test(stateGets[0].url),
  `url=${stateGets.length > 0 ? stateGets[0].url : ''}`,
)
const nextTimer = [...timers.values()][0]
check('the next poll is scheduled after the response', timers.size === 1, `pendingTimers=${timers.size}`)
check(
  'the panel-open poll interval is 1500ms (an unresolved alert is showing)',
  !!nextTimer && nextTimer.ms === 1500,
  `delay=${nextTimer ? nextTimer.ms : 'none'}`,
)

// ------------------------------------------------------ 6. style injection ---

const styleNodes = head.children.filter((node) => node.attrs && node.attrs['data-dsa-style'] !== undefined)
check(
  'exactly one <style data-dsa-style> in document.head',
  styleNodes.length === 1,
  `count=${styleNodes.length}`,
)
const styleText = styleNodes.length > 0 ? String(styleNodes[0].textContent || '') : ''
check('injected CSS contains backdrop-filter', styleText.indexOf('backdrop-filter') >= 0, `length=${styleText.length}`)
check('injected CSS contains #87CEEB', styleText.indexOf('#87CEEB') >= 0)
check('injected CSS contains #E0F7FA', styleText.indexOf('#E0F7FA') >= 0)

// ------------------------------------------------------------- 7. hotkey ----

const keydownHandlers = listeners.get('keydown') || []
check('a keydown listener is attached to window', keydownHandlers.length === 1, `handlers=${keydownHandlers.length}`)

let preventDefaulted = false
let keydownThrew = null
try {
  for (const handler of keydownHandlers) {
    handler({
      key: 's',
      code: 'KeyS',
      ctrlKey: true,
      altKey: true,
      shiftKey: false,
      metaKey: false,
      preventDefault() {
        preventDefaulted = true
      },
      stopPropagation() {},
    })
  }
} catch (error) {
  keydownThrew = error
}
await flush()
await flush()

check(
  'keydown handler does not throw',
  keydownThrew === null,
  keydownThrew ? String(keydownThrew && keydownThrew.message) : '',
)
check('ctrl+alt+s calls preventDefault', preventDefaulted === true)

const controlPosts = requests.filter(
  (entry) => entry.method === 'POST' && entry.url.indexOf('/task-alerts/control') >= 0,
)
check(
  'a POST /task-alerts/control was issued',
  controlPosts.length >= 1,
  `posts=${JSON.stringify(controlPosts.map((entry) => entry.url))}`,
)
let postBody = null
try {
  postBody = controlPosts.length > 0 ? JSON.parse(String(controlPosts[0].body)) : null
} catch (error) {
  postBody = { parseError: String(error && error.message) }
}
check(
  "the POST body action is 'stop-audio'",
  !!postBody && postBody.action === 'stop-audio',
  `body=${JSON.stringify(postBody)}`,
)

// ------------------------------------------------------------ 8. teardown ---

check('ctx.effect received one disposer factory', effectCalls.length === 1, `calls=${effectCalls.length}`)

let seatThrew = null
try {
  for (const entry of registrations) {
    const rendered = entry.component({})
    if (!rendered) throw new Error(`${entry.options.id} rendered nothing`)
  }
} catch (error) {
  seatThrew = error
}
check('both seats render without throwing', seatThrew === null, seatThrew ? String(seatThrew && seatThrew.message) : '')

let teardownThrew = null
try {
  if (typeof main.disposer === 'function') main.disposer()
} catch (error) {
  teardownThrew = error
}
check(
  'the disposer runs without throwing',
  teardownThrew === null,
  teardownThrew ? String(teardownThrew && teardownThrew.message) : '',
)

for (const id of [...timers.keys()]) timers.delete(id)
check('polling is stopped after dispose', timers.size === 0, `timers=${timers.size}`)

const stylesAfter = head.children.filter((node) => node.attrs && node.attrs['data-dsa-style'] !== undefined)
check('the stylesheet is removed on dispose', stylesAfter.length === 0, `remaining=${stylesAfter.length}`)

check('no warning was logged while services were healthy', warnings.length === 0, `warnings=${JSON.stringify(warnings)}`)

// ------------------------------------------- 9. style reuse (idempotent) ---

const foreign = fakeElement('style')
foreign.setAttribute('data-dsa-style', '')
foreign.textContent = '/* injected by another plugin instance */'
head.appendChild(foreign)
const second = captureCtx()
let secondThrew = null
try {
  windowStub.__DSA__.apply(second.ctx)
} catch (error) {
  secondThrew = error
}
check('a second apply() does not throw', secondThrew === null, secondThrew ? String(secondThrew.message) : '')
const afterSecond = head.children.filter((node) => node.attrs && node.attrs['data-dsa-style'] !== undefined)
check(
  'a pre-existing <style data-dsa-style> is reused, not duplicated',
  afterSecond.length === 1 && afterSecond[0] === foreign,
  `count=${afterSecond.length}`,
)
const secondKeydown = listeners.get('keydown') || []
check(
  'the second apply() re-attaches exactly one keydown listener',
  secondKeydown.length === 1,
  `handlers=${secondKeydown.length}`,
)
let recallThrew = null
try {
  if (typeof second.disposer === 'function') second.disposer()
} catch (error) {
  recallThrew = error
}
const afterRecall = head.children.filter((node) => node.attrs && node.attrs['data-dsa-style'] !== undefined)
check('the disposer runs again without throwing', recallThrew === null, recallThrew ? String(recallThrew.message) : '')
check(
  'a stylesheet this plugin did not create is left in place on dispose',
  afterRecall.length === 1 && afterRecall[0] === foreign,
  `count=${afterRecall.length}`,
)

// ------------------------------------ 10. degradation after 3 failures -----

globalThis.fetch = () => Promise.reject(new Error('offline'))
const degraded = captureCtx()
let degradedThrew = null
try {
  windowStub.__DSA__.apply(degraded.ctx)
} catch (error) {
  degradedThrew = error
}
check(
  'apply() with a failing transport does not throw',
  degradedThrew === null,
  degradedThrew ? String(degradedThrew.message) : '',
)
for (let round = 0; round < 4; round += 1) {
  const entry = [...timers.entries()][0]
  if (!entry) break
  timers.delete(entry[0])
  try {
    entry[1].handler()
  } catch (error) {
    check('a failing poll tick does not throw', false, String(error && error.message))
  }
  await flush()
}
const degradedTimer = [...timers.values()][0]
const controlPostsAfterFailure = requests.filter((entry) => entry.method === 'POST').length
check(
  'polling degrades to 5000ms after 3 consecutive failures',
  !!degradedTimer && degradedTimer.ms === 5000,
  `delay=${degradedTimer ? degradedTimer.ms : 'none'}`,
)
check(
  'transport failures are swallowed (no extra control calls)',
  controlPostsAfterFailure === 1,
  `posts=${controlPostsAfterFailure}`,
)
if (typeof degraded.disposer === 'function') degraded.disposer()
for (const id of [...timers.keys()]) timers.delete(id)

// --------------------------------------------- 11. rendered element tree ----

/** Flatten the descriptor tree produced by the React shim into text + class names. */
function flatten(node, acc = { texts: [], classes: [], attrs: [] }) {
  if (node === null || node === undefined || node === false || node === true) return acc
  if (typeof node === 'string' || typeof node === 'number') {
    acc.texts.push(String(node))
    return acc
  }
  // The shim does not render function components, so render them here the way React would.
  if (typeof node.type === 'function') return flatten(node.type(node.props), acc)
  const props = node.props || {}
  if (typeof props.className === 'string') acc.classes.push(props.className)
  if (props['data-dsa-scheme']) acc.attrs.push(`data-dsa-scheme=${props['data-dsa-scheme']}`)
  const kids = props.children === undefined ? [] : Array.isArray(props.children) ? props.children : [props.children]
  for (const kid of kids) flatten(kid, acc)
  return acc
}

const panelSeat = registrations.find((entry) => entry.options.id === 'task-alerts.panel')
const toastSeat = registrations.find((entry) => entry.options.id === 'task-alerts.toast')
const panelNode = panelSeat.component({})
const toastNode = toastSeat.component({})
const panelTree = flatten(panelNode)
const toastTree = flatten(toastNode)
const panelText = panelTree.texts.join(' | ')
const toastText = toastTree.texts.join(' | ')

check(
  'panel renders the .dsa-panel root',
  panelTree.classes.indexOf('dsa-panel') >= 0,
  `classes=${JSON.stringify(panelTree.classes.slice(0, 3))}`,
)
check('panel shows its title', panelText.indexOf('任务提醒') >= 0)
check('panel shows problemId', panelText.indexOf('problemId p_1') >= 0, `text=${panelText.slice(0, 80)}`)
check('panel shows attempts/maxAttempts', panelText.indexOf('attempts 2/2') >= 0)
check(
  'panel shows the report path',
  panelText.indexOf('E:/deepseek work/dsh-task-alerts/reports/p_1.txt') >= 0,
)
check('panel shows the recent-alert list', panelText.indexOf('最近提醒') >= 0)
check(
  'panel shows the three buttons',
  panelText.indexOf('停止音效') >= 0 && panelText.indexOf('测试提醒') >= 0 && panelText.indexOf('关闭') >= 0,
)
check('panel has a primary button class', panelTree.classes.indexOf('dsa-btn dsa-btn--primary') >= 0)
check(
  'panel root carries data-dsa-scheme=dark from ctx.theme',
  panelTree.attrs.indexOf('data-dsa-scheme=dark') >= 0,
  `attrs=${JSON.stringify(panelTree.attrs)}`,
)
check('toast renders the .dsa-toast root', toastTree.classes.indexOf('dsa-toast') >= 0)
check(
  'toast shows only the newest finish alert',
  toastText.indexOf('程序完成') >= 0 && toastText.indexOf('两次尝试后仍未解决') < 0,
  `text=${toastText}`,
)

// ------------------------------------- 12. control wire format (clicks) -----

// Section 10 swapped fetch for a failing transport; restore the recording stub.
globalThis.fetch = fetchStub

/** Every element carrying an onClick, with the text of its own subtree. */
function clickables(node, out = []) {
  if (!node || typeof node !== 'object') return out
  if (typeof node.type === 'function') return clickables(node.type(node.props), out)
  const props = node.props || {}
  if (typeof props.onClick === 'function') {
    out.push({ text: flatten({ type: node.type, props }).texts.join(''), fire: props.onClick })
  }
  const kids = props.children === undefined ? [] : Array.isArray(props.children) ? props.children : [props.children]
  for (const kid of kids) clickables(kid, out)
  return out
}

function lastControlBody() {
  const posts = requests.filter((entry) => entry.method === 'POST')
  if (posts.length === 0) return null
  try {
    return JSON.parse(String(posts[posts.length - 1].body))
  } catch (error) {
    return null
  }
}

const panelButtons = clickables(panelNode)
const toastButtons = clickables(toastNode)
check(
  'panel exposes its clickable controls',
  panelButtons.length >= 5,
  `buttons=${JSON.stringify(panelButtons.map((button) => button.text))}`,
)

const stopButton = panelButtons.find((button) => button.text.indexOf('停止音效') >= 0)
const testButton = panelButtons.find((button) => button.text.indexOf('测试提醒') >= 0)
const dismissRow = panelButtons.find((button) => button.text.indexOf('忽略') >= 0)
const toastClose = toastButtons.find((button) => button.text === '×')

let clickThrew = null
const fire = (button) => {
  try {
    if (button) button.fire()
  } catch (error) {
    clickThrew = error
  }
}

fire(stopButton)
check(
  'panel 停止音效 posts { action: stop-audio }',
  !!stopButton && (lastControlBody() || {}).action === 'stop-audio',
  `body=${JSON.stringify(lastControlBody())}`,
)
fire(testButton)
check(
  'panel 测试提醒 posts { action: test-alert }',
  !!testButton && (lastControlBody() || {}).action === 'test-alert',
  `body=${JSON.stringify(lastControlBody())}`,
)
fire(dismissRow)
check(
  'panel 忽略 posts { action: dismiss, alertId: al_2 }',
  !!dismissRow && (lastControlBody() || {}).action === 'dismiss' && (lastControlBody() || {}).alertId === 'al_2',
  `body=${JSON.stringify(lastControlBody())}`,
)
fire(toastClose)
check(
  'toast close posts { action: dismiss, alertId: al_1 }',
  !!toastClose && (lastControlBody() || {}).action === 'dismiss' && (lastControlBody() || {}).alertId === 'al_1',
  `body=${JSON.stringify(lastControlBody())}`,
)
check('no click handler threw', clickThrew === null, clickThrew ? String(clickThrew.message) : '')

// ------------- 13. v1.2: settings page, sidebar action, config wire ----------

/** Walk the descriptor tree, rendering function components the way React would. */
function walk(node, visit, acc = []) {
  if (!node || typeof node !== 'object') return acc
  if (typeof node.type === 'function') return walk(node.type(node.props), visit, acc)
  const props = node.props || {}
  visit(node, props, acc)
  const kids = props.children === undefined ? [] : Array.isArray(props.children) ? props.children : [props.children]
  for (const kid of kids) walk(kid, visit, acc)
  return acc
}

/** Every element carrying one attribute. */
function findByAttr(node, attr) {
  return walk(node, (element, props, acc) => {
    if (props[attr] !== undefined) acc.push({ element, props })
  })
}

/** A complete EditableConfig (contract §12.5). */
function sampleConfig(overrides = {}) {
  return {
    enabled: true,
    audioPath: 'E:/deepseek work/dsh-task-alerts/alert.wav',
    repeatInterval: 5,
    repeatMax: 0,
    hotkey: 'ctrl+alt+s',
    programFinishAlert: true,
    alertOnUnresolved: true,
    reportDir: 'E:/deepseek work/dsh-task-alerts/reports',
    reportAutoOpen: 'folder',
    ui: { blurStrength: 14, primaryColor: '#87CEEB', borderRadius: 22, opacity: 0.62 },
    ...overrides,
  }
}

/** A config-aware transport: /task-alerts/config serves the config, PUT replies with the canned answer. */
function configTransport(config, put) {
  return (input, init) => {
    const entry = record(input, init)
    const reply = (status, payload) =>
      Promise.resolve({
        ok: status < 400,
        status,
        headers: { get: () => 'application/json' },
        json: async () => payload,
      })
    if (entry.url.indexOf('/task-alerts/config') >= 0) {
      if (entry.method === 'PUT') {
        const status = (put && put.status) || 200
        return reply(status, (put && put.payload) || { ok: true, applied: true, config, state: sampleState() })
      }
      return reply(200, { ok: true, config, state: sampleState() })
    }
    return reply(200, sampleState())
  }
}

const settingsSeat = registrations.find((entry) => entry.options.id === 'task-alerts')
const sidebarSeat = registrations.find((entry) => entry.options.id === 'task-alerts.settings')

check(
  'slots.inject received shell.overlay, settings.section and sidebar.footer.action',
  ['shell.overlay', 'settings.section', 'sidebar.footer.action'].every((key) => injectedKeys.indexOf(key) >= 0),
  `keys=${JSON.stringify(injectedKeys)}`,
)
check(
  'registration ids cover task-alerts.panel / task-alerts.toast / task-alerts / task-alerts.settings',
  ['task-alerts.panel', 'task-alerts.toast', 'task-alerts', 'task-alerts.settings'].every((id) =>
    registrations.some((entry) => entry.options.id === id),
  ),
  `ids=${JSON.stringify(registrations.map((entry) => entry.options.id))}`,
)
check(
  "settings.section options are { id: 'task-alerts', order: 500, label: '任务提醒' }",
  !!settingsSeat &&
    settingsSeat.options.name === 'settings.section' &&
    settingsSeat.options.order === 500 &&
    settingsSeat.options.label === '任务提醒',
  settingsSeat ? JSON.stringify(settingsSeat.options) : 'missing',
)
check(
  "sidebar.footer.action options are { id: 'task-alerts.settings', order: 400 }",
  !!sidebarSeat && sidebarSeat.options.name === 'sidebar.footer.action' && sidebarSeat.options.order === 400,
  sidebarSeat ? JSON.stringify(sidebarSeat.options) : 'missing',
)
check(
  'window.__DSA__ publishes SettingsSection and SidebarAction',
  typeof windowStub.__DSA__.SettingsSection === 'function' && typeof windowStub.__DSA__.SidebarAction === 'function',
  `keys=${JSON.stringify(Object.keys(windowStub.__DSA__ || {}))}`,
)

// --- 13a. the page renders, then shows the config it fetched ----------------

globalThis.fetch = configTransport(sampleConfig())

const settingsNode = settingsSeat.component({})
check('the settings seat renders without throwing', !!settingsNode)
const settingsFlat = flatten(settingsNode)
const settingsText = settingsFlat.texts.join(' | ')
check(
  'settings page renders the 音效 / 重复 / 快捷键 field labels',
  settingsText.indexOf('音效') >= 0 && settingsText.indexOf('重复') >= 0 && settingsText.indexOf('快捷键') >= 0,
  `text=${settingsText.slice(0, 160)}`,
)
check(
  'settings page renders the status summary (轮询 / 报告目录)',
  settingsText.indexOf('轮询') >= 0 && settingsText.indexOf('报告目录') >= 0,
  `text=${settingsText.slice(0, 160)}`,
)
check(
  'settings page exposes 保存 / 重置 / 试听 controls',
  settingsText.indexOf('保存') >= 0 && settingsText.indexOf('重置') >= 0 && settingsText.indexOf('试听') >= 0,
)
check(
  'settings page carries the glass surface class',
  settingsFlat.classes.some((name) => name.indexOf('dsa-settings') >= 0),
  `classes=${JSON.stringify(settingsFlat.classes.slice(0, 4))}`,
)

await windowStub.__DSA__.settings.load()
await flush()
const configGets = requests.filter((entry) => entry.method === 'GET' && entry.url.indexOf('/task-alerts/config') >= 0)
check('the settings page GETs /task-alerts/config', configGets.length >= 1, `gets=${configGets.length}`)
const loadedFields = findByAttr(settingsSeat.component({}), 'data-dsa-field')
const fieldValue = (key) => {
  const hit = loadedFields.find((entry) => entry.props['data-dsa-field'] === key)
  if (!hit) return '(missing)'
  // The reportAutoOpen control is an in-flow segmented group, not a <select>:
  // its current value is the option marked data-dsa-selected="true".
  if (hit.props['data-dsa-control'] === 'choices') {
    const on = findByAttr(hit.element, 'data-dsa-selected').find(
      (entry) => entry.props['data-dsa-selected'] === 'true',
    )
    return on ? String(on.props['data-dsa-choice']) : '(none-selected)'
  }
  return String(hit.props.value)
}
check(
  'the fetched config reaches the form (blurStrength 14 / opacity 0.62 / reportAutoOpen folder)',
  fieldValue('ui.blurStrength') === '14' && fieldValue('ui.opacity') === '0.62' && fieldValue('reportAutoOpen') === 'folder',
  `blur=${fieldValue('ui.blurStrength')} opacity=${fieldValue('ui.opacity')} autoOpen=${fieldValue('reportAutoOpen')}`,
)

// --- the reportAutoOpen control must never depend on a popup layer ----------
//
// Reported defect: the option list lived in a native <select> popup and came out
// clipped / same-colour, so the options were invisible. The control is now an
// in-flow segmented group, so assert BOTH halves: the popup form is gone, and
// every option is really present in the tree with the right one selected.
const choiceHost = loadedFields.find((entry) => entry.props['data-dsa-field'] === 'reportAutoOpen')
check(
  'reportAutoOpen renders as an in-flow segmented group, not a <select>',
  !!choiceHost && choiceHost.element.type === 'div' && choiceHost.props['data-dsa-control'] === 'choices',
  `type=${choiceHost && choiceHost.element.type} control=${choiceHost && choiceHost.props['data-dsa-control']}`,
)
const choiceNodes = choiceHost ? findByAttr(choiceHost.element, 'data-dsa-choice') : []
check(
  'all four reportAutoOpen options are present in the tree (nothing hidden behind a popup)',
  JSON.stringify(choiceNodes.map((entry) => entry.props['data-dsa-choice']).sort()) ===
    JSON.stringify(['browser', 'file', 'folder', 'none']),
  JSON.stringify(choiceNodes.map((entry) => entry.props['data-dsa-choice'])),
)
const selectedChoices = choiceNodes.filter((entry) => entry.props['data-dsa-selected'] === 'true')
check(
  'exactly one option is marked selected, and it matches the fetched config (folder)',
  selectedChoices.length === 1 && selectedChoices[0].props['data-dsa-choice'] === 'folder',
  JSON.stringify(selectedChoices.map((entry) => entry.props['data-dsa-choice'])),
)
const allElementTypes = []
walk(settingsSeat.component({}), (element) => {
  if (element && element.type) allElementTypes.push(element.type)
})
check(
  'no native <select> element remains anywhere in the settings tree',
  allElementTypes.indexOf('select') < 0,
  `selects=${allElementTypes.filter((type) => type === 'select').length} types=${JSON.stringify([...new Set(allElementTypes)].slice(0, 8))}`,
)

// --- 13b. one edit -> PUT carries only that key, then /state is re-pulled ---

const fieldProps = (key) => {
  const hit = findByAttr(settingsSeat.component({}), 'data-dsa-field').find(
    (entry) => entry.props['data-dsa-field'] === key,
  )
  return hit ? hit.props : null
}

const intervalField = fieldProps('repeatInterval')
check('the repeatInterval field is rendered', !!intervalField)
const stateGetsBeforeSave = requests.filter(
  (entry) => entry.method === 'GET' && entry.url.indexOf('/task-alerts/state') >= 0,
).length
intervalField.onChange({ target: { value: '9' } })
await windowStub.__DSA__.settings.save()
await flush()

const putCalls = requests.filter((entry) => entry.method === 'PUT' && entry.url.indexOf('/task-alerts/config') >= 0)
let putBody = null
try {
  putBody = putCalls.length > 0 ? JSON.parse(String(putCalls[putCalls.length - 1].body)) : null
} catch (error) {
  putBody = { parseError: String(error && error.message) }
}
check('saving PUTs /task-alerts/config', putCalls.length === 1, `puts=${putCalls.length}`)
check(
  'the PUT body contains ONLY the changed key',
  !!putBody && Object.keys(putBody).join(',') === 'repeatInterval' && putBody.repeatInterval === 9,
  `body=${JSON.stringify(putBody)}`,
)
const stateGetsAfterSave = requests.filter(
  (entry) => entry.method === 'GET' && entry.url.indexOf('/task-alerts/state') >= 0,
).length
check(
  'a successful save immediately re-pulls /task-alerts/state (§12.7)',
  stateGetsAfterSave > stateGetsBeforeSave,
  `before=${stateGetsBeforeSave} after=${stateGetsAfterSave}`,
)

// --- 13c. a ui.* edit is one top-level key (`ui`) with all four sub-keys ----

const opacityField = fieldProps('ui.opacity')
check('the ui.opacity field is rendered', !!opacityField)
opacityField.onChange({ target: { value: '0.4' } })
await windowStub.__DSA__.settings.save()
await flush()
let uiBody = null
try {
  uiBody = JSON.parse(String(requests.filter((entry) => entry.method === 'PUT').pop().body))
} catch (error) {
  uiBody = { parseError: String(error && error.message) }
}
check(
  'a ui.* edit sends exactly the touched sub-key under `ui` (partial patch, no stale siblings)',
  !!uiBody &&
    Object.keys(uiBody).join(',') === 'ui' &&
    !!uiBody.ui &&
    Object.keys(uiBody.ui).join(',') === 'opacity' &&
    uiBody.ui.opacity === 0.4,
  `body=${JSON.stringify(uiBody)}`,
)

// --- 13d. the segmented reportAutoOpen control still edits and saves ---------
//
// Structural presence is not enough: the control must still drive the same
// partial PATCH. This simulates picking an option the way the DOM would (the
// hidden radio's onChange), which is also the keyboard/AT path.

const browserChoice = findByAttr(settingsSeat.component({}), 'data-dsa-choice').find(
  (entry) => entry.props['data-dsa-choice'] === 'browser',
)
check('the browser option is rendered in the tree', !!browserChoice)
const browserInput = browserChoice
  ? findByAttr(browserChoice.element, 'className').find(
      (entry) => String(entry.props.className).indexOf('dsa-choice-input') >= 0,
    )
  : null
check(
  'the option is driven by a real radio input (keyboard / screen-reader semantics)',
  !!browserInput && browserInput.props.type === 'radio',
  browserInput ? String(browserInput.props.type) : 'missing',
)
if (browserInput) {
  browserInput.props.onChange()
  await windowStub.__DSA__.settings.save()
  await flush()
  let choiceBody = null
  try {
    choiceBody = JSON.parse(String(requests.filter((entry) => entry.method === 'PUT').pop().body))
  } catch (error) {
    choiceBody = { parseError: String(error && error.message) }
  }
  check(
    'picking the segmented option sends exactly { reportAutoOpen: "browser" }',
    !!choiceBody && Object.keys(choiceBody).join(',') === 'reportAutoOpen' && choiceBody.reportAutoOpen === 'browser',
    `body=${JSON.stringify(choiceBody)}`,
  )
}
const putsBeforeNoop = requests.filter((entry) => entry.method === 'PUT').length
await windowStub.__DSA__.settings.save()
await flush()
check(
  'an unchanged form sends no PUT at all',
  requests.filter((entry) => entry.method === 'PUT').length === putsBeforeNoop,
  `puts=${requests.filter((entry) => entry.method === 'PUT').length}`,
)

// --- 13d. 400 -> per-field error; transport failure -> one line -------------

globalThis.fetch = configTransport(sampleConfig(), {
  status: 400,
  payload: { ok: false, error: 'invalid configuration', errors: { repeatInterval: '必须是非负数' } },
})
fieldProps('repeatInterval').onChange({ target: { value: '-1' } })
await windowStub.__DSA__.settings.save()
await flush()
const errorNode = settingsSeat.component({})
const errorText = flatten(errorNode).texts.join(' | ')
check(
  'a 400 renders the host error under the offending field',
  errorText.indexOf('必须是非负数') >= 0,
  `text=${errorText.slice(-160)}`,
)
check(
  'the offending field is flagged with data-dsa-invalid',
  findByAttr(errorNode, 'data-dsa-invalid').some(
    (entry) => entry.props['data-dsa-invalid'] === 'true' && entry.props['data-dsa-field-row'] === 'repeatInterval',
  ),
  `invalid=${JSON.stringify(findByAttr(errorNode, 'data-dsa-invalid').map((entry) => entry.props['data-dsa-field-row']))}`,
)

globalThis.fetch = () => Promise.reject(new Error('offline'))
fieldProps('repeatInterval').onChange({ target: { value: '7' } })
await windowStub.__DSA__.settings.save()
await flush()
const offlineText = flatten(settingsSeat.component({})).texts.join(' | ')
check(
  'a transport failure renders one error line',
  offlineText.indexOf('保存失败') >= 0 && offlineText.indexOf('offline') >= 0,
  `text=${offlineText.slice(-160)}`,
)

// --- 13e. enabled:false keeps every control usable (§12.1 rescue path) ------

globalThis.fetch = configTransport(sampleConfig({ enabled: false }))
await windowStub.__DSA__.settings.load()
await flush()
const closedNode = settingsSeat.component({})
const closedText = flatten(closedNode).texts.join(' | ')
const closedFields = findByAttr(closedNode, 'data-dsa-field')
check(
  'enabled:false still renders every form control',
  closedFields.length >= 13,
  `fields=${closedFields.length} keys=${JSON.stringify(closedFields.map((entry) => entry.props['data-dsa-field']))}`,
)
check(
  'enabled:false disables no control (the rescue path stays usable)',
  closedFields.every((entry) => entry.props.disabled !== true),
  `disabled=${JSON.stringify(closedFields.filter((entry) => entry.props.disabled === true).map((entry) => entry.props['data-dsa-field']))}`,
)
check('enabled:false explains the closed state on the page', closedText.indexOf('已关闭') >= 0, `text=${closedText.slice(0, 160)}`)
const closedActions = findByAttr(closedNode, 'data-dsa-action')
const closedTest = closedActions.find((entry) => entry.props['data-dsa-action'] === 'test')
const closedSave = closedActions.find((entry) => entry.props['data-dsa-action'] === 'save')
check(
  'enabled:false keeps 试听 and 保存 enabled (§12.8)',
  !!closedTest && closedTest.props.disabled !== true && !!closedSave && closedSave.props.disabled !== true,
)
const postsBeforeClosedTest = requests.filter((entry) => entry.method === 'POST').length
closedTest.props.onClick()
await flush()
const closedTestBody = JSON.parse(String(requests.filter((entry) => entry.method === 'POST').pop().body))
check(
  "试听 posts { action: 'test-alert' } even while alerts are disabled",
  requests.filter((entry) => entry.method === 'POST').length === postsBeforeClosedTest + 1 &&
    closedTestBody.action === 'test-alert',
  `body=${JSON.stringify(closedTestBody)}`,
)

// --- 13f. only a `finish` toast may disappear on its own (§12.6) ------------

windowStub.__DSA__.pushState({ ...sampleState(), alerts: [sampleState().alerts[0]] })
const controlPostsBefore = requests.filter(
  (entry) => entry.method === 'POST' && entry.url.indexOf('/task-alerts/control') >= 0,
).length
const toastWithUnresolved = flatten(toastSeat.component({}))
const panelWithUnresolved = flatten(panelSeat.component({}))
check(
  'a state whose only alert is unresolved renders no Toast (nothing auto-hides it)',
  toastWithUnresolved.classes.indexOf('dsa-toast') < 0 &&
    toastWithUnresolved.texts.join('').indexOf('未解决的问题') < 0,
  `classes=${JSON.stringify(toastWithUnresolved.classes)} texts=${JSON.stringify(toastWithUnresolved.texts)}`,
)
check(
  'the same state still renders the panel (unresolved is never auto-dismissed)',
  panelWithUnresolved.classes.indexOf('dsa-panel') >= 0,
  `classes=${JSON.stringify(panelWithUnresolved.classes.slice(0, 3))}`,
)
check(
  'rendering an unresolved alert issues no dismiss call',
  requests.filter((entry) => entry.method === 'POST' && entry.url.indexOf('/task-alerts/control') >= 0).length ===
    controlPostsBefore,
  `posts=${requests.filter((entry) => entry.method === 'POST').length}`,
)

// --- 13g. sidebar.footer.action: preferred path probed, fallback verified ---

const sidebarNode = sidebarSeat.component({ wide: true })
const sidebarFlat = flatten(sidebarNode)
check(
  'the sidebar action renders .dsa-sidebar-action',
  sidebarFlat.classes.some((name) => name.indexOf('dsa-sidebar-action') >= 0),
  `classes=${JSON.stringify(sidebarFlat.classes)}`,
)
check(
  'the sidebar action shows its label in the wide column state',
  sidebarFlat.texts.join('').indexOf('任务提醒') >= 0,
  `text=${sidebarFlat.texts.join(' | ')}`,
)
const probeResult = windowStub.__DSA__.openSettingsPanel()
check(
  'no supported API opens DSH settings from a footer action (probe answers honestly)',
  probeResult === false,
  `openSettingsPanel()=${String(probeResult)}`,
)
const hiddenBefore = windowStub.__DSA__.panelHidden()
const postsBeforeSidebar = requests.filter((entry) => entry.method === 'POST').length
const sidebarButton = findByAttr(sidebarNode, 'data-dsa-sidebar-action')[0]
let sidebarThrew = null
try {
  sidebarButton.props.onClick()
} catch (error) {
  sidebarThrew = error
}
check('clicking the sidebar action does not throw', sidebarThrew === null, sidebarThrew ? String(sidebarThrew.message) : '')
check(
  'the click toggles this plugin panel — a guaranteed visible reaction',
  windowStub.__DSA__.panelHidden() === !hiddenBefore,
  `before=${hiddenBefore} after=${windowStub.__DSA__.panelHidden()}`,
)
check(
  'the click sends no control request of its own',
  requests.filter((entry) => entry.method === 'POST').length === postsBeforeSidebar,
)
const collapsedPanel = flatten(panelSeat.component({}))
check(
  'the collapsed panel renders nothing while the alert stays undismissed',
  collapsedPanel.classes.indexOf('dsa-panel') < 0,
  `classes=${JSON.stringify(collapsedPanel.classes)}`,
)
sidebarButton.props.onClick()
check(
  'clicking again restores the panel',
  windowStub.__DSA__.panelHidden() === false && flatten(panelSeat.component({})).classes.indexOf('dsa-panel') >= 0,
  `hidden=${windowStub.__DSA__.panelHidden()}`,
)

// --- 13h. the optional slots are isolated from shell.overlay (§12.7) --------

function extensionCtx(mode) {
  const rec = { injectedKeys: [], registrations: [] }
  rec.ctx = {
    slots: {
      inject(key, callback) {
        rec.injectedKeys.push(key)
        if (mode === 'inject-throws' && key === 'sidebar.footer.action') throw new Error('declaration unavailable')
        callback()
      },
      register(options, component) {
        if (mode === 'register-throws' && options.name === 'settings.section') throw new Error('register blew up')
        rec.registrations.push({ options, component })
        return () => {}
      },
    },
    effect(callback) {
      rec.disposer = callback()
    },
  }
  return rec
}

const registerThrows = extensionCtx('register-throws')
let registerThrowsError = null
try {
  windowStub.__DSA__.apply(registerThrows.ctx)
} catch (error) {
  registerThrowsError = error
}
check(
  'a throwing settings.section registration never escapes apply()',
  registerThrowsError === null,
  registerThrowsError ? String(registerThrowsError.message) : '',
)
check(
  'shell.overlay registration still happens when settings.section blows up',
  ['task-alerts.panel', 'task-alerts.toast'].every((id) =>
    registerThrows.registrations.some((entry) => entry.options.id === id),
  ),
  `ids=${JSON.stringify(registerThrows.registrations.map((entry) => entry.options.id))}`,
)
check(
  'the failing optional slot is skipped rather than half-registered',
  !registerThrows.registrations.some((entry) => entry.options.id === 'task-alerts'),
  `ids=${JSON.stringify(registerThrows.registrations.map((entry) => entry.options.id))}`,
)
check(
  'the contained failure is logged instead of silently swallowed',
  warnings.some((warning) => warning.indexOf('settings.section') >= 0),
  `warnings=${JSON.stringify(warnings.slice(-2))}`,
)

const injectThrows = extensionCtx('inject-throws')
let injectThrowsError = null
try {
  windowStub.__DSA__.apply(injectThrows.ctx)
} catch (error) {
  injectThrowsError = error
}
check(
  'a throwing inject for an optional slot never escapes apply()',
  injectThrowsError === null,
  injectThrowsError ? String(injectThrowsError.message) : '',
)
check(
  'shell.overlay is still registered when an optional inject throws',
  injectThrows.registrations.some((entry) => entry.options.id === 'task-alerts.panel'),
  `ids=${JSON.stringify(injectThrows.registrations.map((entry) => entry.options.id))}`,
)

const noSlotsCtx = { effect() {} }
let noSlotsError = null
try {
  windowStub.__DSA__.apply(noSlotsCtx)
} catch (error) {
  noSlotsError = error
}
check('apply() with ctx.slots missing does not throw', noSlotsError === null, noSlotsError ? String(noSlotsError.message) : '')

const warningsBeforeNoInject = warnings.length
const noInjectCtx = { slots: { register: () => () => {} }, effect() {} }
let noInjectError = null
try {
  windowStub.__DSA__.apply(noInjectCtx)
} catch (error) {
  noInjectError = error
}
check('apply() with slots.inject missing does not throw', noInjectError === null, noInjectError ? String(noInjectError.message) : '')
check(
  'slots.inject missing skips the optional slots with a warning (§12.7)',
  warnings.slice(warningsBeforeNoInject).some((warning) => warning.indexOf('slots.inject unavailable') >= 0),
  `warnings=${JSON.stringify(warnings.slice(warningsBeforeNoInject))}`,
)

// --- 13i. artifact-level proof that the settings page really ships ----------

const buildScript = readFileSync(join(ROOT, 'scripts', 'build-client.mjs'), 'utf8')
check(
  "scripts/build-client.mjs PARTS contains 'SettingsForm.js'",
  /PARTS\s*=\s*\[[^\]]*'SettingsForm\.js'/.test(buildScript),
  `PARTS=${(buildScript.match(/const PARTS = \[[^\]]*\]/) || ['(not found)'])[0]}`,
)
check(
  'lib/client.js contains the SettingsForm.js part banner (the page is in the bundle)',
  source.indexOf('/* ---- begin SettingsForm.js ---- */') >= 0,
)
/*
 * Order matters as much as presence: every part that only *publishes* onto
 * `window.__DSA__` must be concatenated before the part that reads it back.
 * A real bundle is >100000 bytes, so the size floor also guards against a
 * truncated or empty assembly.
 */
const bundleBytes = Buffer.byteLength(source, 'utf8')
const settingsPartAt = source.indexOf('/* ---- begin SettingsForm.js ---- */')
const clientPartAt = source.indexOf('/* ---- begin client.js ---- */')
check(
  'lib/client.js is >100000 bytes and its SettingsForm.js part precedes the client.js part (publisher before consumer)',
  bundleBytes > 100000 && settingsPartAt >= 0 && clientPartAt >= 0 && settingsPartAt < clientPartAt,
  `bytes=${bundleBytes} SettingsForm@${settingsPartAt} client@${clientPartAt}`,
)
check(
  'lib/client.js publishes SettingsSection / SidebarAction',
  source.indexOf('root.SettingsSection = SettingsSection') >= 0 && source.indexOf('root.SidebarAction = SidebarAction') >= 0,
)

// ------------- 14. v1.3: the panel can always be reopened (§13) -------------
//
// The reported defect: 面板「关闭」→ dismiss → 提醒被移除 → 此后没有任何东西能让面板
// 再渲染。The fix is the collapsed pill (same `task-alerts.panel` seat, second form)
// driven by a module-scoped `manualOpen` that survives the dismiss.

const dsa = windowStub.__DSA__

// --- 14a. the entrance rides the EXISTING seat (no extra slot registration) ---
check(
  'the reopened entrance is the existing task-alerts.panel seat (no extra shell.overlay registration)',
  registrations
    .filter((entry) => entry.options.name === 'shell.overlay')
    .map((entry) => entry.options.id)
    .join(',') === 'task-alerts.toast,task-alerts.panel',
  `ids=${JSON.stringify(registrations.map((entry) => entry.options.id))}`,
)
check(
  'window.__DSA__ publishes the panel visibility face (manualOpen / toggle / collapse)',
  typeof dsa.panelExpanded === 'function' &&
    typeof dsa.panelPillAllowed === 'function' &&
    typeof dsa.setManualOpen === 'function' &&
    typeof dsa.togglePanel === 'function' &&
    typeof dsa.collapsePanel === 'function' &&
    typeof dsa.manualOpen === 'function',
  `keys=${JSON.stringify(Object.keys(dsa || {}))}`,
)

const panelClasses = () => flatten(panelSeat.component({})).classes
const panelTextNow = () => flatten(panelSeat.component({})).texts.join(' | ')
const pillClassIn = (classes) => classes.some((name) => name.indexOf('dsa-pill') >= 0)

// Baseline: a pending unresolved alert + manualOpen → expanded form, no pill.
// `setManualOpen(true)` also clears the local-hide key, so this baseline does
// not depend on what the earlier sections left behind.
dsa.setManualOpen(true)
dsa.pushState(sampleState())
check(
  'with a pending alert the seat renders the expanded panel (.dsa-panel), not the pill',
  panelClasses().indexOf('dsa-panel') >= 0 && !pillClassIn(panelClasses()),
  `classes=${JSON.stringify(panelClasses().slice(0, 4))}`,
)

// --- 14b. config.panel_hotkey (in-app keydown) toggles manualOpen ------------
const panelHandlers = listeners.get('keydown') || []
check(
  'the last apply() left exactly one keydown listener (both hotkeys share it)',
  panelHandlers.length === 1,
  `handlers=${panelHandlers.length}`,
)
const dispatchKey = (event) => {
  let prevented = false
  let threw = null
  for (const handler of panelHandlers) {
    try {
      handler({
        shiftKey: false,
        metaKey: false,
        ...event,
        preventDefault() {
          prevented = true
        },
        stopPropagation() {},
      })
    } catch (error) {
      threw = error
    }
  }
  return { prevented, threw }
}
const postsBeforePanelKey = requests.filter((entry) => entry.method === 'POST').length
const panelKeyPress = dispatchKey({ key: 'a', code: 'KeyA', ctrlKey: true, altKey: true })
check(
  'panel_hotkey (ctrl+alt+a) keydown does not throw',
  panelKeyPress.threw === null,
  panelKeyPress.threw ? String(panelKeyPress.threw.message) : '',
)
check('panel_hotkey (ctrl+alt+a) calls preventDefault', panelKeyPress.prevented === true)
check(
  'panel_hotkey collapses the visible panel (切换), clearing manualOpen',
  dsa.panelExpanded() === false && dsa.manualOpen() === false && pillClassIn(panelClasses()),
  `expanded=${dsa.panelExpanded()} manualOpen=${dsa.manualOpen()}`,
)
check(
  'panel_hotkey posts no control request of its own (it is a pure local toggle)',
  requests.filter((entry) => entry.method === 'POST').length === postsBeforePanelKey,
  `posts=${requests.filter((entry) => entry.method === 'POST').length}`,
)
const panelKeyAgain = dispatchKey({ key: 'a', code: 'KeyA', ctrlKey: true, altKey: true })
check(
  'panel_hotkey pressed again expands it again — and that IS manualOpen = true',
  panelKeyAgain.threw === null && dsa.manualOpen() === true && dsa.panelExpanded() === true,
  `manualOpen=${dsa.manualOpen()}`,
)
check(
  'the stop_hotkey (ctrl+alt+s) still wins its own combo',
  (() => {
    const before = requests.filter((entry) => entry.method === 'POST').length
    dispatchKey({ key: 's', code: 'KeyS', ctrlKey: true, altKey: true })
    const posts = requests.filter((entry) => entry.method === 'POST')
    return posts.length === before + 1 && JSON.parse(String(posts[posts.length - 1].body)).action === 'stop-audio'
  })(),
  `body=${JSON.stringify(lastControlBody())}`,
)

// --- 14c. showPill:false → neither form (the pre-1.3 behaviour) -------------
const pendingOnlyState = { ...sampleState(), alerts: [sampleState().alerts[0]] }
dsa.collapsePanel()
dsa.pushState({ ...pendingOnlyState, config: { ...sampleState().config, showPill: false } })
const showPillOffTree = flatten(panelSeat.component({}))
check(
  // The seat always renders its transparent `.dsa-root` host; what must vanish
  // is both panel forms.
  'showPill:false renders neither the expanded panel nor the collapsed pill',
  showPillOffTree.classes.indexOf('dsa-panel') < 0 && !pillClassIn(showPillOffTree.classes),
  `classes=${JSON.stringify(showPillOffTree.classes)}`,
)
dsa.pushState({ ...pendingOnlyState, config: { ...sampleState().config, showPill: true } })
check(
  'showPill:true with the same collapsed state brings the pill back',
  pillClassIn(panelClasses()) && panelClasses().indexOf('dsa-panel') < 0,
  `classes=${JSON.stringify(panelClasses())}`,
)

// --- 14d. THE REPORTED BUG: every alert dismissed → manual open still renders -
const dismissedState = {
  ...sampleState(),
  stats: { problems: 1, unresolved: 0, alerts: 1 },
  alerts: [{ ...sampleState().alerts[0], dismissed: true }],
}
dsa.pushState(dismissedState)
dsa.setManualOpen(false)
const collapsedAfterDismiss = panelSeat.component({})
check(
  'with every alert dismissed the seat falls back to the collapsed pill (.dsa-pill / .dsa-pill--idle)',
  pillClassIn(panelClasses()) && panelClasses().some((name) => name.indexOf('dsa-pill--idle') >= 0),
  `classes=${JSON.stringify(panelClasses())}`,
)
check(
  'the collapsed form is NOT the expanded panel (mutually exclusive, no overlap to fight over)',
  panelClasses().indexOf('dsa-panel') < 0,
  `classes=${JSON.stringify(panelClasses())}`,
)
const pillButtons = clickables(collapsedAfterDismiss)
check(
  'the collapsed pill exposes an 展开 control',
  pillButtons.some((button) => button.text === '展开'),
  `buttons=${JSON.stringify(pillButtons.map((button) => button.text))}`,
)
dsa.setManualOpen(false)
fire(pillButtons.find((button) => button.text === '展开'))
check(
  'clicking 展开 sets manualOpen=true even with nothing pending',
  dsa.manualOpen() === true,
  `manualOpen=${dsa.manualOpen()}`,
)
check(
  'MANUAL OPEN WITH NOTHING PENDING STILL RENDERS THE PANEL (.dsa-panel) — the reported bug',
  panelClasses().indexOf('dsa-panel') >= 0,
  `classes=${JSON.stringify(panelClasses().slice(0, 4))}`,
)
check(
  'the empty expanded panel explains itself with .dsa-empty',
  panelClasses().some((name) => name.indexOf('dsa-empty') >= 0) &&
    panelTextNow().indexOf('当前没有待处理提醒，以下是最近提醒') >= 0,
  `text=${panelTextNow().slice(0, 120)}`,
)
check(
  'the empty expanded panel still offers the recent list and every control',
  panelTextNow().indexOf('最近提醒') >= 0 &&
    panelTextNow().indexOf('停止音效') >= 0 &&
    panelTextNow().indexOf('测试提醒') >= 0 &&
    panelTextNow().indexOf('关闭') >= 0,
  `text=${panelTextNow().slice(0, 160)}`,
)
check(
  'a manually opened empty panel keeps the faster poll interval (1500ms)',
  dsa.pollInterval() === 1500,
  `interval=${dsa.pollInterval()}`,
)

// --- 14e. 关闭 = dismiss + manualOpen=false, and the pill reopens it ---------
dsa.pushState(sampleState())
dsa.setManualOpen(true)
const expandedNode = panelSeat.component({})
const expandedButtons = clickables(expandedNode)
const closeButtons = expandedButtons.filter((button) => button.text === '关闭')
const collapseButtons = expandedButtons.filter((button) => button.text === '收起')
check(
  'the expanded panel distinguishes 关闭 (dismiss) from 收起 (visual only)',
  closeButtons.length === 1 && collapseButtons.length === 1,
  `buttons=${JSON.stringify(expandedButtons.map((button) => button.text))}`,
)
const postsBeforeCollapse = requests.filter((entry) => entry.method === 'POST').length
fire(collapseButtons[0])
check(
  '收起 hides the panel without dismissing or stopping anything',
  dsa.manualOpen() === false &&
    requests.filter((entry) => entry.method === 'POST').length === postsBeforeCollapse &&
    pillClassIn(panelClasses()),
  `manualOpen=${dsa.manualOpen()} posts=${requests.filter((entry) => entry.method === 'POST').length}`,
)
dsa.setManualOpen(true)
fire(clickables(panelSeat.component({})).find((button) => button.text === '关闭'))
check(
  '关闭 dismisses the current alert (POST dismiss) and clears manualOpen',
  dsa.manualOpen() === false && (lastControlBody() || {}).action === 'dismiss' && (lastControlBody() || {}).alertId === 'al_2',
  `manualOpen=${dsa.manualOpen()} body=${JSON.stringify(lastControlBody())}`,
)
check(
  'after 关闭 the collapsed pill is still on screen (the reopenable entrance)',
  pillClassIn(panelClasses()),
  `classes=${JSON.stringify(panelClasses())}`,
)
fire(clickables(panelSeat.component({})).find((button) => button.text === '展开'))
check(
  'after 关闭, clicking the pill reopens the panel — 用户报的那个 bug 的修复本身',
  dsa.manualOpen() === true && panelClasses().indexOf('dsa-panel') >= 0,
  `manualOpen=${dsa.manualOpen()} classes=${JSON.stringify(panelClasses().slice(0, 3))}`,
)

// --- 14f. the host's global hotkey: panelOpenSeq growth opens the panel ------
dsa.collapsePanel()
dsa.pushState({ ...sampleState(), panelOpenSeq: 5 })
check(
  'the FIRST panelOpenSeq sighting only records the counter (a reload must not pop the panel)',
  dsa.manualOpen() === false,
  `manualOpen=${dsa.manualOpen()}`,
)
dsa.pushState({ ...sampleState(), panelOpenSeq: 5 })
check(
  'an unchanged panelOpenSeq does not reopen the panel (no open-per-poll)',
  dsa.manualOpen() === false,
  `manualOpen=${dsa.manualOpen()}`,
)
dsa.pushState({ ...sampleState(), panelOpenSeq: 6 })
check(
  'a grown panelOpenSeq opens the panel (host global panel_hotkey)',
  dsa.manualOpen() === true && panelClasses().indexOf('dsa-panel') >= 0,
  `manualOpen=${dsa.manualOpen()}`,
)
dsa.pushState({ ...sampleState(), panelOpenSeq: 6 })
check(
  'and it stays open (the counter is recorded, not re-consumed)',
  dsa.manualOpen() === true,
  `manualOpen=${dsa.manualOpen()} keys=${JSON.stringify(dsa.panelKeys())}`,
)

// --- 14g. the sidebar action toggles the same manualOpen state --------------
dsa.pushState(sampleState())
dsa.collapsePanel()
const sidebarNodeV13 = sidebarSeat.component({ wide: true })
const sidebarFlatV13 = flatten(sidebarNodeV13)
check(
  'the sidebar action advertises the collapsed state (展开 affordance)',
  sidebarFlatV13.classes.some((name) => name.indexOf('dsa-sidebar-action--collapsed') >= 0),
  `classes=${JSON.stringify(sidebarFlatV13.classes)}`,
)
const postsBeforeSidebarV13 = requests.filter((entry) => entry.method === 'POST').length
findByAttr(sidebarNodeV13, 'data-dsa-sidebar-action')[0].props.onClick()
check(
  'the sidebar action opens the panel (manualOpen = true) and sends no control request',
  dsa.manualOpen() === true &&
    panelClasses().indexOf('dsa-panel') >= 0 &&
    requests.filter((entry) => entry.method === 'POST').length === postsBeforeSidebarV13,
  `manualOpen=${dsa.manualOpen()}`,
)
findByAttr(sidebarSeat.component({ wide: true }), 'data-dsa-sidebar-action')[0].props.onClick()
check(
  'clicking the sidebar action again collapses it (same state as the pill)',
  dsa.manualOpen() === false && pillClassIn(panelClasses()),
  `manualOpen=${dsa.manualOpen()}`,
)

// --- 14h. the settings page can edit both new keys (§13.2) ------------------
globalThis.fetch = configTransport(sampleConfig())
await dsa.settings.load()
await flush()
const v13Fields = findByAttr(settingsSeat.component({}), 'data-dsa-field')
check(
  'settings page renders the panelHotkey field and the showPill switch',
  v13Fields.some((entry) => entry.props['data-dsa-field'] === 'panelHotkey') &&
    v13Fields.some((entry) => entry.props['data-dsa-field'] === 'showPill'),
  `fields=${JSON.stringify(v13Fields.map((entry) => entry.props['data-dsa-field']))}`,
)
const v13SettingsText = flatten(settingsSeat.component({})).texts.join(' | ')
check(
  'the two new controls are recognisable by their own copy (面板快捷键 / 收起把手)',
  v13SettingsText.indexOf('面板快捷键') >= 0 &&
    v13SettingsText.indexOf('收起') >= 0 &&
    v13SettingsText.indexOf('把手') >= 0,
  `text=${v13SettingsText.slice(0, 200)}`,
)
check(
  'the status summary shows the current panel hotkey value',
  findByAttr(settingsSeat.component({}), 'data-dsa-panel-hotkey').some(
    (entry) => entry.props['data-dsa-panel-hotkey'] === 'ctrl+alt+a',
  ),
  `badge=${JSON.stringify(
    findByAttr(settingsSeat.component({}), 'data-dsa-panel-hotkey').map((entry) => entry.props['data-dsa-panel-hotkey']),
  )}`,
)
const v13FieldProps = (key) => {
  const hit = findByAttr(settingsSeat.component({}), 'data-dsa-field').find(
    (entry) => entry.props['data-dsa-field'] === key,
  )
  return hit ? hit.props : null
}
const panelHotkeyField = v13FieldProps('panelHotkey')
check(
  'the panelHotkey input is a captured-hotkey field (onKeyDown capture wired)',
  !!panelHotkeyField && panelHotkeyField.onKeyDown !== undefined,
  `props=${JSON.stringify(Object.keys(panelHotkeyField || {}))}`,
)
panelHotkeyField.onKeyDown({
  key: 'p',
  code: 'KeyP',
  ctrlKey: true,
  altKey: true,
  shiftKey: false,
  metaKey: false,
  preventDefault() {},
  stopPropagation() {},
})
const putsBeforePanelEdit = requests.filter((entry) => entry.method === 'PUT').length
await dsa.settings.save()
await flush()
let panelHotkeyPutBody = null
try {
  const putsAfter = requests.filter((entry) => entry.method === 'PUT')
  panelHotkeyPutBody = putsAfter.length > putsBeforePanelEdit ? JSON.parse(String(putsAfter[putsAfter.length - 1].body)) : null
} catch (error) {
  panelHotkeyPutBody = { parseError: String(error && error.message) }
}
check(
  'capturing ctrl+alt+p then saving sends exactly { panelHotkey: "ctrl+alt+p" } (partial patch)',
  !!panelHotkeyPutBody &&
    Object.keys(panelHotkeyPutBody).join(',') === 'panelHotkey' &&
    panelHotkeyPutBody.panelHotkey === 'ctrl+alt+p',
  `body=${JSON.stringify(panelHotkeyPutBody)}`,
)
const showPillField = v13FieldProps('showPill')
showPillField.onChange({ target: { checked: false } })
await dsa.settings.save()
await flush()
let showPillPutBody = null
try {
  showPillPutBody = JSON.parse(String(requests.filter((entry) => entry.method === 'PUT').pop().body))
} catch (error) {
  showPillPutBody = { parseError: String(error && error.message) }
}
check(
  'toggling the showPill switch sends exactly { showPill: false }',
  !!showPillPutBody && Object.keys(showPillPutBody).join(',') === 'showPill' && showPillPutBody.showPill === false,
  `body=${JSON.stringify(showPillPutBody)}`,
)

// --- 14i. the settings page can edit maxAttempts too (§14) ------------------
//
// The user asked for the "stuck" attempt cap to be fillable like the others, so
// assert all three things that makes true: the field exists, its copy explains
// what it caps, and editing it drives the same partial PATCH.
check(
  '§14 the settings page renders the maxAttempts field (the "stuck" attempt cap)',
  v13Fields.some((entry) => entry.props['data-dsa-field'] === 'maxAttempts'),
  `fields=${JSON.stringify(v13Fields.map((entry) => entry.props['data-dsa-field']))}`,
)
check(
  '§14 the maxAttempts control is labelled so the user knows what it caps',
  v13SettingsText.indexOf('卡住上限') >= 0,
  `text=${v13SettingsText.slice(0, 160)}`,
)
const maxAttemptsField = v13FieldProps('maxAttempts')
check(
  '§14 the maxAttempts field is an editable control',
  !!maxAttemptsField && typeof maxAttemptsField.onChange === 'function',
  `props=${JSON.stringify(Object.keys(maxAttemptsField || {}))}`,
)
if (maxAttemptsField && typeof maxAttemptsField.onChange === 'function') {
  maxAttemptsField.onChange({ target: { value: '5' } })
  const putsBeforeAttemptsEdit = requests.filter((entry) => entry.method === 'PUT').length
  await dsa.settings.save()
  await flush()
  let attemptsPutBody = null
  try {
    const putsAfterAttempts = requests.filter((entry) => entry.method === 'PUT')
    attemptsPutBody =
      putsAfterAttempts.length > putsBeforeAttemptsEdit
        ? JSON.parse(String(putsAfterAttempts[putsAfterAttempts.length - 1].body))
        : null
  } catch (error) {
    attemptsPutBody = { parseError: String(error && error.message) }
  }
  check(
    '§14 editing maxAttempts sends exactly { maxAttempts: 5 } (partial patch)',
    !!attemptsPutBody && Object.keys(attemptsPutBody).join(',') === 'maxAttempts' && attemptsPutBody.maxAttempts === 5,
    `body=${JSON.stringify(attemptsPutBody)}`,
  )
}

// -------------------------------------------------------------- verdict -----

process.stdout.write(`\n${checks - failures}/${checks} assertions passed\n`)
process.exitCode = failures === 0 ? 0 : 1
