/**
 * dsh-task-alerts —— 宿主半冒烟脚本（纯 node，无测试框架）。
 *
 * 用假 ctx（记录 commands.register / webServer.register / on / effect / set 的调用）
 * 与临时目录，逐条断言 CONTRACT §4/§5/§9 的宿主行为，并用 process.exitCode 表达成败。
 *
 * 运行：node scripts/smoke-host.mjs
 * 诊断：DSH_TASK_ALERTS_SMOKE_KEEP=1 保留临时目录。
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TMP_ROOT = mkdtempSync(join(tmpdir(), 'dsh-task-alerts-smoke-'))
const REPORT_DIR = join(TMP_ROOT, 'reports')

// 配置基准指向临时目录：冒烟不写进插件包，也不依赖真实 <DSH_HOME>。
process.env.DSH_TASK_ALERTS_PACKAGE_ROOT = TMP_ROOT
process.env.DSH_HOME = join(TMP_ROOT, 'dsh-home')
writeFileSync(join(TMP_ROOT, 'package.json'), '{"name":"dsh-task-alerts-smoke-fixture","type":"module"}\n', 'utf8')

const CONFIG = {
  audio_path: './alert.wav',
  report_dir: './reports',
  max_attempts: 2,
  stop_hotkey: 'ctrl+alt+s',
  program_finish_alert: true,
  alert_on_unresolved: true,
  log_file: './plugin.log',
  ui: { blur_strength: 10, primary_color: '#87CEEB', border_radius: 20, opacity: 0.7 },
}

const results = []
let failures = 0

function check(label, condition, detail) {
  const ok = condition === true
  if (!ok) failures += 1
  const suffix = detail === undefined ? '' : ` — ${detail}`
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${suffix}`)
  return ok
}

function fatal(label, error) {
  failures += 1
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  results.push(`FAIL  ${label} — ${text}`)
}

/** 让定时器真正跑几轮（响铃循环是异步的，断言必须等一等）。 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 假 ctx：每个能力都被记录；缺失的能力可显式关闭。 */
function createFakeCtx(options = {}) {
  const record = { commands: [], routes: [], events: [], effects: [], effectDisposers: [], sets: [], provides: [] }
  const listeners = new Map()
  const ctx = {
    logger: undefined,
    commands: options.withCommands === false
      ? undefined
      : {
          register(definition) {
            record.commands.push(definition)
            return () => {}
          },
        },
    webServer: options.withWebServer === false
      ? undefined
      : {
          register(route) {
            record.routes.push(route)
            return () => {}
          },
        },
    on(event, listener) {
      record.events.push(event)
      const bucket = listeners.get(event) ?? []
      bucket.push(listener)
      listeners.set(event, bucket)
      return () => {
        listeners.set(event, (listeners.get(event) ?? []).filter((entry) => entry !== listener))
      }
    },
    // Cordis 的 provide(name, value)：以调用者 fiber 的身份注册服务，返回注销 disposer。
    // 必须模拟——宿主半就是这样暴露 ctx.taskAlerts 的；而且真实 Cordis 里
    // `ctx.effect(cb)` 会**立刻调用 cb 取 disposer**，所以这里的 effect 也必须立即调用，
    // 否则会掩盖「把注销回调误写成 effect 回调」这类致命错误。
    provide(name, value) {
      record.provides.push({ name, value })
      ctx[name] = value
      return () => {
        delete ctx[name]
      }
    },
    effect(callback) {
      record.effects.push(callback)
      const disposers = []
      const returned = callback({ collect: (fn) => disposers.push(fn) })
      const dispose = () => {
        for (const fn of disposers) fn()
        if (typeof returned === 'function') returned()
      }
      record.effectDisposers.push(dispose)
      return dispose
    },
    set(name, value) {
      record.sets.push({ name, value })
      ctx[name] = value
      return ctx
    },
  }
  return { ctx, record }
}

/** 响应桩：记录状态码、响应头与响应体。 */
function createResponse() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      res.headers[String(name).toLowerCase()] = value
    },
    end(chunk) {
      res.body += chunk ?? ''
    },
  }
  return res
}

/**
 * 驱动一个路由 handler：先调用拿到 Promise（handler 在同步阶段注册 data/end 监听），
 * 再补发请求体事件，最后 await 结果。
 */
async function runHandler(route, { method, url = route.path, body } = {}) {
  // 带 body 时默认 POST，否则默认 GET：避免桩把方法设错而误判路由行为。
  const resolvedMethod = method ?? (body === undefined ? 'GET' : 'POST')
  const handlers = new Map()
  const req = {
    method: resolvedMethod,
    url,
    headers: {},
    on(event, listener) {
      handlers.set(event, [...(handlers.get(event) ?? []), listener])
      return req
    },
  }
  const res = createResponse()
  const pending = Promise.resolve(route.handler(req, res))
  await Promise.resolve()
  if (body !== undefined) {
    for (const listener of handlers.get('data') ?? []) listener(Buffer.from(body, 'utf8'))
  }
  for (const listener of handlers.get('end') ?? []) listener()
  await pending
  return {
    res,
    status: res.statusCode,
    json() {
      return JSON.parse(res.body)
    },
  }
}

function reportFiles() {
  if (!existsSync(REPORT_DIR)) return []
  return readdirSync(REPORT_DIR).filter((name) => name.endsWith('.txt'))
}

async function main() {
  // ---- 0. 模块形态 ----
  let mod
  try {
    mod = await import(new URL('../lib/index.js', import.meta.url).href)
    check('模块可加载且 apply 是函数', typeof mod.apply === 'function', `typeof apply === ${typeof mod.apply}`)
    check('name === "task-alerts"', mod.name === 'task-alerts', `name === ${JSON.stringify(mod.name)}`)
    // Cordis 4 会在读取**未在 inject 中声明**的服务属性时直接抛
    // `cannot get property "x" without inject`，所以这两个服务必须声明为依赖。
    // （曾经这里是「inject 是空数组」，那条断言把 bug 编码成了期望，线上导致
    //  整条宿主行装配失败、命令与路由全没注册、UI 完全不出现。）
    check(
      'inject 声明了 commands 与 webServer',
      Array.isArray(mod.inject) && mod.inject.includes('commands') && mod.inject.includes('webServer'),
      `inject === ${JSON.stringify(mod.inject)}`,
    )
    check('默认导出存在且 apply 与命名导出一致', mod.default !== undefined && mod.default.apply === mod.apply)
  } catch (error) {
    fatal('模块可加载', error)
    return
  }

  // ---- 1. apply 装配 ----
  const { ctx, record } = createFakeCtx()
  try {
    await mod.apply(ctx, CONFIG)
    check('apply(ctx, config) 未抛异常', true)
  } catch (error) {
    fatal('apply(ctx, config) 未抛异常', error)
  }

  // ---- 2. 命令 ----
  const commandNames = record.commands.map((entry) => entry.name)
  check('commands.register 被调用 2 次', record.commands.length === 2, `实际 ${record.commands.length}：${JSON.stringify(commandNames)}`)
  check('命令名恰为 alert-stop / alert-test', commandNames.includes('alert-stop') && commandNames.includes('alert-test'), JSON.stringify(commandNames))
  check('命令名无前导斜杠', commandNames.every((n) => !n.startsWith('/')), JSON.stringify(commandNames))
  check('两个命令都带 handler 与 description', record.commands.every((d) => typeof d.handler === 'function' && typeof d.description === 'string' && d.description.length > 0))

  // ---- 3. 路由 ----
  const routePaths = record.routes.map((route) => route.path)
  // §12 授权（lead 裁决 A1）：v1.2 **有意**新增第 3 条路由（/task-alerts/config），所以「恰好 N 条」
  // 随之由 2 更新为 3，并**同时**新增下面两条对新增路由的具体断言（覆盖只增不减）。
  check('webServer.register 被调用 3 次', record.routes.length === 3, `实际 ${record.routes.length}：${JSON.stringify(routePaths)}`)
  check('路由 path 含 /task-alerts/state 与 /task-alerts/control', routePaths.includes('/task-alerts/state') && routePaths.includes('/task-alerts/control'), JSON.stringify(routePaths))
  check('两条路由 kind 均为 exact', record.routes.every((route) => route.kind === 'exact'), JSON.stringify(record.routes.map((r) => r.kind)))
  check(
    '§12 注册的路由集合恰为 state / control / config 三条',
    JSON.stringify([...routePaths].sort()) === JSON.stringify(['/task-alerts/config', '/task-alerts/control', '/task-alerts/state']),
    JSON.stringify(routePaths),
  )
  check(
    '§12 新增的 /task-alerts/config 与既有 /task-alerts/control 的 kind 均为 exact',
    record.routes
      .filter((route) => route.path === '/task-alerts/config' || route.path === '/task-alerts/control')
      .every((route) => route.kind === 'exact'),
    JSON.stringify(record.routes.map((r) => `${r.kind} ${r.path}`)),
  )

  // ---- 4. 事件 ----
  check('监听了 agent/status', record.events.includes('agent/status'), JSON.stringify(record.events))
  check('监听了 agent/turn-stopping', record.events.includes('agent/turn-stopping'))
  check('监听了 agent/error', record.events.includes('agent/error'))
  check('监听了 agent/request-error', record.events.includes('agent/request-error'))

  // ---- 5. 服务 ----
  // 必须是 ctx.provide：ctx.set 只允许覆盖**已经 provide 过**的服务，对未提供过的
  // 名字会抛（cordis reflect.d.ts:26 "setting an unprovided name throws"）。
  check(
    'ctx.provide 被调用于 taskAlerts',
    record.provides.some((entry) => entry.name === 'taskAlerts'),
    JSON.stringify(record.provides.map((p) => p.name)),
  )
  const service = ctx.taskAlerts
  check('ctx.taskAlerts 形状正确', service !== undefined && typeof service.recordAttempt === 'function' && typeof service.getState === 'function' && typeof service.stopAudio === 'function' && typeof service.dismiss === 'function')
  if (service === undefined) {
    fatal('无法继续：ctx.taskAlerts 未暴露', new Error('missing service'))
    return
  }

  // ---- 6. 两次失败尝试 ----
  const PROBLEM_ID = 'task-42:unresolved/demo'
  const first = await service.recordAttempt({
    problemId: PROBLEM_ID,
    description: '冒烟测试：同一问题连续失败两次',
    thought: '第一次思考：检查配置解析优先级是否被 apply 参数覆盖。',
    error: '第一次错误：ENOENT 找不到 alert.wav',
    solved: false,
    source: 'smoke/attempt-1',
  })
  check('第 1 次 recordAttempt → attempts === 1', first.attempts === 1, JSON.stringify(first))
  check('第 1 次 recordAttempt → unresolved === false', first.unresolved === false, JSON.stringify(first))
  check('第 1 次不生成报告', first.reportPath === undefined, JSON.stringify(first))

  const second = await service.recordAttempt({
    problemId: PROBLEM_ID,
    description: '冒烟测试：同一问题连续失败两次',
    thought: '第二次思考：确认报告去重集合是否落盘。',
    error: '第二次错误：报告目录不可写（模拟）',
    solved: false,
    source: 'smoke/attempt-2',
  })
  check('第 2 次 recordAttempt → attempts === 2', second.attempts === 2, JSON.stringify(second))
  check('第 2 次 recordAttempt → unresolved === true', second.unresolved === true, JSON.stringify(second))
  const reportPath = second.reportPath
  check('第 2 次返回 reportPath 且文件真实存在', typeof reportPath === 'string' && existsSync(reportPath) === true, String(reportPath))

  const reportText = typeof reportPath === 'string' && existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : ''
  check('报告含问题描述', reportText.includes('冒烟测试：同一问题连续失败两次'))
  check('报告含第 1 次思考内容', reportText.includes('第一次思考：检查配置解析优先级是否被 apply 参数覆盖。'))
  check('报告含第 2 次思考内容', reportText.includes('第二次思考：确认报告去重集合是否落盘。'))
  check('报告含两次错误信息', reportText.includes('第一次错误：ENOENT 找不到 alert.wav') && reportText.includes('第二次错误：报告目录不可写（模拟）'))
  check('报告含问题 ID 与尝试次数', reportText.includes('问题 ID    : task-42:unresolved/demo') && reportText.includes('尝试次数   : 2 / 上限 2'))

  // ---- 7. 第三次同 problemId → 去重 ----
  const beforeFiles = reportFiles()
  const third = await service.recordAttempt({
    problemId: PROBLEM_ID,
    description: '冒烟测试：同一问题连续失败两次',
    thought: '第三次思考：不该再生成报告。',
    error: '第三次错误：不该出现',
    solved: false,
    source: 'smoke/attempt-3',
  })
  const afterFiles = reportFiles()
  check('第 3 次不返回 reportPath（去重）', third.reportPath === undefined, JSON.stringify(third))
  check('第 3 次后报告文件数不变', afterFiles.length === beforeFiles.length, `before=${JSON.stringify(beforeFiles)} after=${JSON.stringify(afterFiles)}`)
  check('去重索引 .reported.json 已落盘', existsSync(join(REPORT_DIR, '.reported.json')))

  // ---- 8. GET /task-alerts/state ----
  const stateRoute = record.routes.find((route) => route.path === '/task-alerts/state')
  if (stateRoute === undefined) {
    fatal('未找到 /task-alerts/state 路由', new Error('missing route'))
  } else {
    try {
      const out = await runHandler(stateRoute, { method: 'GET', url: '/task-alerts/state?since=0' })
      check('state handler 返回 200', out.status === 200, `statusCode=${out.status}`)
      check('state Content-Type 正确', out.res.headers['content-type'] === 'application/json; charset=utf-8', String(out.res.headers['content-type']))
      let parsed = null
      try {
        parsed = out.json()
      } catch (error) {
        fatal('state 返回体可解析为 JSON', error)
      }
      if (parsed !== null) {
        check('state.alerts.length >= 1', Array.isArray(parsed.alerts) && parsed.alerts.length >= 1, `alerts.length=${parsed.alerts?.length}`)
        check('state.revision 为数字且 >= 1', typeof parsed.revision === 'number' && parsed.revision >= 1, `revision=${parsed.revision}`)
        check('state.stats.unresolved >= 1', parsed.stats?.unresolved >= 1, JSON.stringify(parsed.stats))
        check('state.config.hotkey 已归一化', parsed.config?.hotkey === 'ctrl+alt+s', String(parsed.config?.hotkey))
        check('state.config.reportDir 已解析为绝对路径', typeof parsed.config?.reportDir === 'string' && parsed.config.reportDir === REPORT_DIR, String(parsed.config?.reportDir))
        check('state.alerts[0] 为 unresolved 且带报告路径', parsed.alerts?.[0]?.kind === 'unresolved' && parsed.alerts?.[0]?.reportPath === reportPath, JSON.stringify(parsed.alerts?.[0]))
      }
    } catch (error) {
      fatal('GET /task-alerts/state 不抛异常', error)
    }
  }

  // ---- 9. POST /task-alerts/control ----
  const controlRoute = record.routes.find((route) => route.path === '/task-alerts/control')
  if (controlRoute === undefined) {
    fatal('未找到 /task-alerts/control 路由', new Error('missing route'))
  } else {
    try {
      const unknown = await runHandler(controlRoute, { body: JSON.stringify({ action: 'definitely-unknown' }) })
      check('未知 action → 400', unknown.status === 400, `statusCode=${unknown.status} body=${unknown.res.body}`)
      const unknownBody = unknown.json()
      check('未知 action body = {ok:false,error:"unknown action"}', unknownBody.ok === false && unknownBody.error === 'unknown action', unknown.res.body)

      const missingId = await runHandler(controlRoute, { body: JSON.stringify({ action: 'dismiss' }) })
      check('dismiss 缺 alertId → 400', missingId.status === 400, `statusCode=${missingId.status} body=${missingId.res.body}`)

      const testAlert = await runHandler(controlRoute, { body: JSON.stringify({ action: 'test-alert' }) })
      const testBody = testAlert.json()
      check('test-alert → 200 且 ok === true', testAlert.status === 200 && testBody.ok === true, `statusCode=${testAlert.status} body=${testAlert.res.body.slice(0, 160)}`)
      check('test-alert 返回 state', testBody.state !== undefined && typeof testBody.state.revision === 'number')

      const stopAudio = await runHandler(controlRoute, { body: JSON.stringify({ action: 'stop-audio' }) })
      check('stop-audio → 200 且 ok === true', stopAudio.status === 200 && stopAudio.json().ok === true, `statusCode=${stopAudio.status} body=${stopAudio.res.body.slice(0, 160)}`)

      const dismiss = await runHandler(controlRoute, { body: JSON.stringify({ action: 'dismiss', alertId: 'al_missing' }) })
      check('dismiss 未知 alertId → 200 且 dismissed === false', dismiss.status === 200 && dismiss.json().dismissed === false, `statusCode=${dismiss.status} body=${dismiss.res.body.slice(0, 160)}`)

      const badJson = await runHandler(controlRoute, { body: '{not json' })
      check('非法 JSON body → 400', badJson.status === 400, `statusCode=${badJson.status} body=${badJson.res.body}`)

      const wrongMethod = await runHandler(controlRoute, { method: 'GET', url: '/task-alerts/control' })
      check('非 POST 请求 → 400', wrongMethod.status === 400, `statusCode=${wrongMethod.status}`)
    } catch (error) {
      fatal('POST /task-alerts/control 不抛异常', error)
    }
  }

  // ---- 10. 命令处理器 ----
  try {
    const stopCommand = record.commands.find((entry) => entry.name === 'alert-stop')
    const stopResult = await stopCommand.handler({ rawInput: '' })
    check('/alert-stop handler → kind:success', stopResult.kind === 'success', JSON.stringify(stopResult))
    const testCommand = record.commands.find((entry) => entry.name === 'alert-test')
    const testResult = await testCommand.handler({ rawInput: '' })
    check('/alert-test handler → kind:success', testResult.kind === 'success', JSON.stringify(testResult))
  } catch (error) {
    fatal('命令处理器可调用', error)
  }

  // ---- 11. 能力缺失时的降级 ----
  const noWs = createFakeCtx({ withWebServer: false })
  try {
    await mod.apply(noWs.ctx, { report_dir: './reports-bare', log_file: './plugin-bare.log' })
    check('ctx.webServer 缺失时 apply 不抛异常', true)
    check('ctx.webServer 缺失时仍注册 2 条命令', noWs.record.commands.length === 2, `实际 ${noWs.record.commands.length}`)
    check('ctx.webServer 缺失时 ctx.taskAlerts 仍暴露', typeof noWs.ctx.taskAlerts?.recordAttempt === 'function')
    const bareState = noWs.ctx.taskAlerts.getState()
    check('降级实例的 getState() 可调用', bareState !== undefined && typeof bareState.revision === 'number', JSON.stringify(bareState.stats))
  } catch (error) {
    fatal('ctx.webServer 缺失时 apply 不抛异常', error)
  }

  const bare = createFakeCtx({ withCommands: false, withWebServer: false })
  delete bare.ctx.on
  delete bare.ctx.effect
  delete bare.ctx.set
  try {
    await mod.apply(bare.ctx)
    check('ctx 只有最少能力（无 on/effect/set/webServer/commands）时 apply 不抛异常', true)
    check('最少能力 ctx 上直接赋值暴露 taskAlerts', typeof bare.ctx.taskAlerts?.recordAttempt === 'function')
  } catch (error) {
    fatal('最少能力 ctx 上 apply 不抛异常', error)
  }

  // ---- 12. 清理路径 ----
  try {
    check('ctx.effect 被调用（注册清理）', record.effects.length === 1, `effects=${record.effects.length}`)
    // 通过 effect 注册的 disposer 统一触发，等价于宿主卸载插件（含停 OS 级快捷键）。
    for (const dispose of record.effectDisposers) dispose()
    for (const dispose of noWs.record.effectDisposers) dispose()
    check('清理后 stopAudio() 仍返回 boolean', typeof service.stopAudio() === 'boolean')
    check('降级实例也注册了 effect 清理', noWs.record.effectDisposers.length === 1, `disposers=${noWs.record.effectDisposers.length}`)
    // 兜底：任何未被 disposer 覆盖的 OS 级监听器都在这里收尾。
    const stoppedHotkeys = mod.stopAllHotkeys()
    check('stopAllHotkeys() 无残留或已全部停止', typeof stoppedHotkeys === 'number', `stopped=${stoppedHotkeys}`)
  } catch (error) {
    fatal('清理路径不抛异常', error)
  }

  // ---- 13. 程序化入口独立于事件系统 ----
  try {
    const finish = await service.recordProgramFinish({ label: '冒烟程序', ok: true, detail: '正常结束' })
    check('recordProgramFinish → alerted === true', finish.alerted === true, JSON.stringify(finish))
    const state = service.getState()
    check('程序结束提醒进入 alerts', state.alerts.some((alert) => alert.kind === 'finish'), JSON.stringify(state.alerts.map((a) => a.kind)))
  } catch (error) {
    fatal('程序化入口可用', error)
  }

  // =====================================================================
  // v1.1（CONTRACT §11）新增功能的断言。以下全部为**追加**：既有断言一字未改。
  // 所有新实例都注入 openRunner（记录用），因此不会真的弹出窗口/浏览器。
  // =====================================================================

  /** 记录注入 runner 收到的每一次调用：`(path, mode, command, args)`。 */
  function recordingRunner(sink) {
    return function (path, mode, command, args) {
      sink.push({ path, mode, command, args })
      return true
    }
  }

  const RING_BASE = {
    audio_path: './alert.wav',
    log_file: './ring.log',
    repeat_interval: 0.05,
    repeat_max: 0,
    report_auto_open: 'none',
  }

  // ---- 14. F1 响铃直到关闭 ----
  try {
    const ringCtx = createFakeCtx()
    await mod.apply(ringCtx.ctx, { ...RING_BASE, report_dir: './reports-ring' })
    const ringService = ringCtx.ctx.taskAlerts
    const ringControl = ringCtx.record.routes.find((route) => route.path === '/task-alerts/control')
    check('F1 降级实例/新实例都暴露 openReport', typeof ringService.openReport === 'function')

    await ringService.recordProgramFinish({ label: '响铃测试', ok: true })
    const ringImmediate = ringService.getState()
    check('F1 提醒立刻进入响铃循环（repeatActive === true）', ringImmediate.repeatActive === true, JSON.stringify({ repeatActive: ringImmediate.repeatActive, repeatCount: ringImmediate.repeatCount }))
    check('F1 state.config.repeatInterval 透出（秒，小数保留）', ringImmediate.config.repeatInterval === 0.05, String(ringImmediate.config.repeatInterval))
    check('F1 state.config.repeatMax 透出（0 = 不限）', ringImmediate.config.repeatMax === 0, String(ringImmediate.config.repeatMax))

    await sleep(240)
    const ringAfter = ringService.getState()
    check('F1 repeatCount 至少增长 1 次', ringAfter.repeatCount >= 1, `repeatCount=${ringAfter.repeatCount}`)
    check('F1 循环中仍在响（repeatActive === true）', ringAfter.repeatActive === true, String(ringAfter.repeatActive))

    const ringStop = await runHandler(ringControl, { body: JSON.stringify({ action: 'stop-audio' }) })
    const ringStopped = ringService.getState()
    check('F1 stop-audio → 200 且 ok === true', ringStop.status === 200 && ringStop.json().ok === true, `statusCode=${ringStop.status} body=${ringStop.res.body.slice(0, 160)}`)
    check('F1 stop-audio 后 repeatActive === false', ringStopped.repeatActive === false, String(ringStopped.repeatActive))
    const frozenCount = ringStopped.repeatCount
    await sleep(240)
    check('F1 stop-audio 后 repeatCount 不再增长', ringService.getState().repeatCount === frozenCount, `before=${frozenCount} after=${ringService.getState().repeatCount}`)

    // dismiss 也必须停（CONTRACT §11.3：“任何 dismiss 都停”）
    await ringService.recordProgramFinish({ label: '响铃测试 2', ok: true })
    const ringRearmed = ringService.getState()
    check('F1 再次提醒重新进入响铃循环', ringRearmed.repeatActive === true, JSON.stringify({ repeatActive: ringRearmed.repeatActive, repeatCount: ringRearmed.repeatCount }))
    await sleep(120)
    const ringAlertId = ringService.getState().alerts[0].id
    const ringDismiss = await runHandler(ringControl, { body: JSON.stringify({ action: 'dismiss', alertId: ringAlertId }) })
    const afterDismiss = ringService.getState()
    check('F1 dismiss 前确实已经重复过（repeatCount >= 1）', afterDismiss.repeatCount >= 1, `repeatCount=${afterDismiss.repeatCount}`)
    check('F1 dismiss → 200 且 dismissed === true', ringDismiss.status === 200 && ringDismiss.json().dismissed === true, `statusCode=${ringDismiss.status} body=${ringDismiss.res.body.slice(0, 160)}`)
    check('F1 dismiss 停掉响铃（repeatActive === false）', afterDismiss.repeatActive === false, String(afterDismiss.repeatActive))
    const dismissCount = afterDismiss.repeatCount
    await sleep(240)
    check('F1 dismiss 后 repeatCount 不再增长', ringService.getState().repeatCount === dismissCount, `before=${dismissCount} after=${ringService.getState().repeatCount}`)

    // /alert-stop 命令同样走同一条终止路径
    await ringService.recordProgramFinish({ label: '响铃测试 3', ok: true })
    const stopCommand = ringCtx.record.commands.find((entry) => entry.name === 'alert-stop')
    const stopResult = await stopCommand.handler({ rawInput: '' })
    check('F1 /alert-stop 命令停掉响铃', stopResult.kind === 'success' && ringService.getState().repeatActive === false, JSON.stringify(stopResult))
    check('F1 /alert-stop 文案反映循环已停', /已停止/.test(stopResult.text) === true, String(stopResult.text))
  } catch (error) {
    fatal('F1 响铃循环断言不抛异常', error)
  }

  // ---- 14b. F1 边界：repeat_interval=0 / repeat_max / 卸载 ----
  try {
    const onceCtx = createFakeCtx()
    await mod.apply(onceCtx.ctx, { ...RING_BASE, repeat_interval: 0, report_dir: './reports-once', log_file: './once.log' })
    const onceService = onceCtx.ctx.taskAlerts
    await onceService.recordProgramFinish({ label: '只响一次', ok: true })
    await sleep(200)
    const onceState = onceService.getState()
    check('F1 repeat_interval=0 → 不进循环（repeatActive === false）', onceState.repeatActive === false, String(onceState.repeatActive))
    check('F1 repeat_interval=0 → repeatCount === 0（只播一次）', onceState.repeatCount === 0, String(onceState.repeatCount))

    const maxCtx = createFakeCtx()
    await mod.apply(maxCtx.ctx, { ...RING_BASE, repeat_max: 2, report_dir: './reports-max', log_file: './max.log' })
    const maxService = maxCtx.ctx.taskAlerts
    await maxService.recordProgramFinish({ label: '响铃上限', ok: true })
    await sleep(700)
    const maxState = maxService.getState()
    check('F1 repeat_max=2 → 重复 2 次后停止（repeatCount === 2）', maxState.repeatCount === 2, `repeatCount=${maxState.repeatCount}`)
    check('F1 repeat_max=2 → 达上限后 repeatActive === false', maxState.repeatActive === false, String(maxState.repeatActive))
    const maxFrozen = maxState.repeatCount
    await sleep(200)
    check('F1 达上限后 repeatCount 不再增长', maxService.getState().repeatCount === maxFrozen, `before=${maxFrozen} after=${maxService.getState().repeatCount}`)

    await maxService.recordProgramFinish({ label: '卸载前', ok: true })
    check('F1 卸载前处于循环中', maxService.getState().repeatActive === true)
    for (const dispose of maxCtx.record.effectDisposers) dispose()
    check('F1 插件卸载后 repeatActive === false（定时器已随 disposer 清理）', maxService.getState().repeatActive === false, String(maxService.getState().repeatActive))
  } catch (error) {
    fatal('F1 边界断言不抛异常', error)
  }

  // ---- 15. F2 open-report（注入 runner，绝不真的弹窗）----
  try {
    const openCalls = []
    const openCtx = createFakeCtx()
    await mod.apply(openCtx.ctx, {
      audio_path: './alert.wav',
      report_dir: './reports-open',
      log_file: './open.log',
      repeat_interval: 0,
      report_auto_open: 'none',
      openRunner: recordingRunner(openCalls),
    })
    const openService = openCtx.ctx.taskAlerts
    const openControl = openCtx.record.routes.find((route) => route.path === '/task-alerts/control')

    const OPEN_PROBLEM = 'smoke-open/report'
    await openService.recordAttempt({ problemId: OPEN_PROBLEM, description: 'F2 报告', solved: false })
    const openSecond = await openService.recordAttempt({ problemId: OPEN_PROBLEM, description: 'F2 报告', solved: false })
    const openReportPath = openSecond.reportPath
    check('F2 第二次失败尝试已写盘报告', typeof openReportPath === 'string' && existsSync(openReportPath) === true, String(openReportPath))
    const openAlert = openService.getState().alerts.find((alert) => alert.reportPath !== undefined)
    check('F2 存在带 reportPath 的 alert', openAlert !== undefined, JSON.stringify(openService.getState().alerts.map((a) => `${a.id}:${a.reportPath ?? '-'}`)))
    check('F2 report_auto_open=none 时写报告不调用 runner', openCalls.length === 0, `calls=${openCalls.length}`)

    const opened = await runHandler(openControl, { body: JSON.stringify({ action: 'open-report', alertId: openAlert.id }) })
    const openedBody = opened.json()
    check('F2 open-report → 200', opened.status === 200, `statusCode=${opened.status} body=${opened.res.body.slice(0, 160)}`)
    check('F2 open-report → ok === true 且 opened === true', openedBody.ok === true && openedBody.opened === true, opened.res.body.slice(0, 160))
    check('F2 open-report → 返回 state', openedBody.state !== undefined && typeof openedBody.state.revision === 'number', JSON.stringify(openedBody.state?.stats))
    check('F2 runner 收到报告真实路径 + mode=file', openCalls.length === 1 && openCalls[0].path === openReportPath && openCalls[0].mode === 'file', JSON.stringify(openCalls))
    check('F2 runner 收到的命令行指向该路径', openCalls.length === 1 && typeof openCalls[0].command === 'string' && openCalls[0].args.join(' ').includes(openReportPath), JSON.stringify(openCalls[0]))

    const missingAlertId = await runHandler(openControl, { body: JSON.stringify({ action: 'open-report' }) })
    check('F2 open-report 缺 alertId → 400', missingAlertId.status === 400 && missingAlertId.json().ok === false, `statusCode=${missingAlertId.status} body=${missingAlertId.res.body}`)
    const emptyAlertId = await runHandler(openControl, { body: JSON.stringify({ action: 'open-report', alertId: '' }) })
    check('F2 open-report alertId 为空串 → 400', emptyAlertId.status === 400, `statusCode=${emptyAlertId.status} body=${emptyAlertId.res.body}`)
    const unknownAlertId = await runHandler(openControl, { body: JSON.stringify({ action: 'open-report', alertId: 'al_does_not_exist' }) })
    check('F2 open-report 未知 alertId → 400', unknownAlertId.status === 400, `statusCode=${unknownAlertId.status} body=${unknownAlertId.res.body}`)

    await openService.recordProgramFinish({ label: '没有报告的提醒', ok: true })
    const noReportAlert = openService.getState().alerts[0]
    const noReport = await runHandler(openControl, { body: JSON.stringify({ action: 'open-report', alertId: noReportAlert.id }) })
    check('F2 该 alert 无 reportPath → 400', noReport.status === 400, `statusCode=${noReport.status} body=${noReport.res.body}`)
    check('F2 400 路径一次都没有调用 runner', openCalls.length === 1, `calls=${openCalls.length}`)

    check('F2 服务方法 openReport(未知 id) === false', openService.openReport('al_nope') === false)
    check('F2 服务方法 openReport(真实 id) === true', openService.openReport(openAlert.id) === true)
  } catch (error) {
    fatal('F2 open-report 断言不抛异常', error)
  }

  // ---- 16. F3 生成报告后自动打开（report_auto_open）----
  try {
    const autoCalls = []
    const autoCtx = createFakeCtx()
    await mod.apply(autoCtx.ctx, {
      audio_path: './alert.wav',
      report_dir: './reports-auto',
      log_file: './auto.log',
      repeat_interval: 0,
      report_auto_open: 'file',
      openRunner: recordingRunner(autoCalls),
    })
    const autoService = autoCtx.ctx.taskAlerts
    const AUTO_PROBLEM = 'smoke-auto/report'
    await autoService.recordAttempt({ problemId: AUTO_PROBLEM, description: 'F3 报告', solved: false })
    const autoSecond = await autoService.recordAttempt({ problemId: AUTO_PROBLEM, description: 'F3 报告', solved: false })
    check('F3 report_auto_open=file → 报告写盘成功', typeof autoSecond.reportPath === 'string' && existsSync(autoSecond.reportPath) === true, String(autoSecond.reportPath))
    check('F3 runner 收到 (报告真实路径, "file")', autoCalls.length === 1 && autoCalls[0].path === autoSecond.reportPath && autoCalls[0].mode === 'file', JSON.stringify(autoCalls))
    check('F3 state.config.reportAutoOpen === "file"', autoService.getState().config.reportAutoOpen === 'file', String(autoService.getState().config.reportAutoOpen))

    // 未达上限的尝试绝不触发打开
    const autoThird = await autoService.recordAttempt({ problemId: 'smoke-auto/late', description: 'F3 报告（首次尝试）', solved: false })
    check('F3 未达 max_attempts 时不调用 runner', autoCalls.length === 1 && autoThird.reportPath === undefined, `calls=${autoCalls.length} reportPath=${String(autoThird.reportPath)}`)

    const noneCalls = []
    const noneCtx = createFakeCtx()
    await mod.apply(noneCtx.ctx, {
      report_dir: './reports-none',
      log_file: './none.log',
      repeat_interval: 0,
      report_auto_open: 'none',
      openRunner: recordingRunner(noneCalls),
    })
    const noneService = noneCtx.ctx.taskAlerts
    const NONE_PROBLEM = 'smoke-none/report'
    await noneService.recordAttempt({ problemId: NONE_PROBLEM, description: 'F3 报告', solved: false })
    const noneSecond = await noneService.recordAttempt({ problemId: NONE_PROBLEM, description: 'F3 报告', solved: false })
    check('F3 report_auto_open=none → 报告照常写盘', typeof noneSecond.reportPath === 'string' && existsSync(noneSecond.reportPath) === true, String(noneSecond.reportPath))
    check('F3 report_auto_open=none → runner 收到 0 次调用', noneCalls.length === 0, `calls=${noneCalls.length}`)

    // folder / browser 的命令行形态（同样是纯计划断言，不启动进程）
    const planCall = []
    const planCtx = createFakeCtx()
    await mod.apply(planCtx.ctx, { report_dir: './reports-folder', log_file: './folder.log', repeat_interval: 0, report_auto_open: 'folder', openRunner: recordingRunner(planCall) })
    const planService = planCtx.ctx.taskAlerts
    await planService.recordAttempt({ problemId: 'smoke-folder/report', description: 'F3 folder', solved: false })
    const planSecond = await planService.recordAttempt({ problemId: 'smoke-folder/report', description: 'F3 folder', solved: false })
    check('F3 folder 模式 runner 收到 (所在目录, "folder")', planCall.length === 1 && planCall[0].mode === 'folder' && planCall[0].path === dirname(planSecond.reportPath), JSON.stringify(planCall))
    check('F3 folder 模式命令行引用该报告文件', planCall.length === 1 && planCall[0].args.join(' ').includes(planSecond.reportPath), JSON.stringify(planCall[0]))
  } catch (error) {
    fatal('F3 report_auto_open 断言不抛异常', error)
  }

  // ---- 17. 配置：三个新键（标量 + 引号字符串）+ clamp + 默认值 ----
  try {
    const configMod = await import(new URL('../lib/config.js', import.meta.url).href)
    const parsedYaml = configMod.parseSimpleYaml('repeat_interval: 0.05\nrepeat_max: 7\nreport_auto_open: "folder"\n')
    check('配置 极简解析器读入 repeat_interval（小数标量）', parsedYaml.repeat_interval === 0.05, String(parsedYaml.repeat_interval))
    check('配置 极简解析器读入 repeat_max（整数标量）', parsedYaml.repeat_max === 7, String(parsedYaml.repeat_max))
    check('配置 极简解析器读入 report_auto_open（引号字符串）', parsedYaml.report_auto_open === 'folder', String(parsedYaml.report_auto_open))
    check('配置 极简解析器读入带注释的键', configMod.parseSimpleYaml('repeat_interval: 3  # 秒\n').repeat_interval === 3, String(configMod.parseSimpleYaml('repeat_interval: 3  # 秒\n').repeat_interval))

    const defaultConfig = service.getState().config
    check('配置 未显式设置时 repeat_interval 默认 10 秒', defaultConfig.repeatInterval === 10, String(defaultConfig.repeatInterval))
    check('配置 未显式设置时 repeat_max 默认 0（不限）', defaultConfig.repeatMax === 0, String(defaultConfig.repeatMax))
    check('配置 未显式设置时 report_auto_open 默认 none', defaultConfig.reportAutoOpen === 'none', String(defaultConfig.reportAutoOpen))

    const clampCtx = createFakeCtx()
    await mod.apply(clampCtx.ctx, { report_dir: './reports-clamp', log_file: './clamp.log', repeat_interval: -3, repeat_max: -5, report_auto_open: 'bogus-value' })
    const clampConfig = clampCtx.ctx.taskAlerts.getState().config
    check('配置 repeat_interval 负数 clamp 到 0', clampConfig.repeatInterval === 0, String(clampConfig.repeatInterval))
    check('配置 repeat_max 负数 clamp 到 0', clampConfig.repeatMax === 0, String(clampConfig.repeatMax))
    check('配置 report_auto_open 非法值归 none', clampConfig.reportAutoOpen === 'none', String(clampConfig.reportAutoOpen))

    const caseCtx = createFakeCtx()
    await mod.apply(caseCtx.ctx, { report_dir: './reports-case', log_file: './case.log', report_auto_open: '  BROWSER ', repeat_max: '2' })
    const caseConfig = caseCtx.ctx.taskAlerts.getState().config
    check('配置 report_auto_open 大小写/空白归一为 browser', caseConfig.reportAutoOpen === 'browser', String(caseConfig.reportAutoOpen))
    check('配置 repeat_max 字符串 "2" 归一为数字 2', caseConfig.repeatMax === 2, String(caseConfig.repeatMax))
  } catch (error) {
    fatal('配置新键断言不抛异常', error)
  }

  // =====================================================================
  // v1.2（CONTRACT §12）可写配置 HTTP API。以下全部为**追加**断言。
  // 三件事必须同时成立：严格校验（400）、运行时立即生效且可回滚（500）、自写自读闭环。
  // 用户配置文件 = <DSH_HOME>/dsh-task-alerts.config.yaml（DSH_HOME 已指向本脚本的临时目录）。
  // =====================================================================

  const USER_CONFIG = join(process.env.DSH_HOME, 'dsh-task-alerts.config.yaml')
  const PACKAGE_CONFIG_YAML = join(dirname(fileURLToPath(import.meta.url)), '..', 'config.yaml')
  const REPORT_CONFIG_DIR = join(TMP_ROOT, 'reports-config')
  const CONFIG_LOG = join(TMP_ROOT, 'config-api.log')
  const EDITABLE_KEYS = [
    'audioPath',
    'enabled',
    'hotkey',
    'panelHotkey',
    'programFinishAlert',
    'alertOnUnresolved',
    'reportDir',
    'reportAutoOpen',
    'repeatInterval',
    'repeatMax',
    'showPill',
    'ui',
  ]
  /** 除某个键以外的全部可写键值（断言「部分更新不动其它键」）。 */
  function othersOf(config, skip) {
    const out = {}
    for (const key of EDITABLE_KEYS) {
      if (key !== skip) out[key] = config[key]
    }
    return JSON.stringify(out)
  }

  try {
    const configMod = await import(new URL('../lib/config.js', import.meta.url).href)
    const packageConfigBefore = readFileSync(PACKAGE_CONFIG_YAML, 'utf8')
    // 基线：本段开始前用户配置文件不存在（冒烟绝不读写真实 <DSH_HOME>）。
    if (existsSync(USER_CONFIG)) rmSync(USER_CONFIG, { force: true })
    check('§12 基线：<DSH_HOME>/dsh-task-alerts.config.yaml 尚不存在', existsSync(USER_CONFIG) === false, USER_CONFIG)

    const autoOpenCalls = []
    const audioCalls = []
    const cfgCtx = createFakeCtx()
    await mod.apply(cfgCtx.ctx, {
      ...RING_BASE,
      report_dir: './reports-config',
      log_file: './config-api.log',
      audioProbe: (call) => audioCalls.push(call),
      openRunner: recordingRunner(autoOpenCalls),
    })
    const cfgService = cfgCtx.ctx.taskAlerts
    const cfgRoute = cfgCtx.record.routes.find((route) => route.path === '/task-alerts/config')
    const cfgControl = cfgCtx.record.routes.find((route) => route.path === '/task-alerts/control')
    const reportFilesIn = (dir) => (existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.txt')) : [])
    check(
      '§12 实例上 /task-alerts/config 路由存在',
      cfgRoute !== undefined && cfgRoute.kind === 'exact',
      JSON.stringify(cfgCtx.record.routes.map((r) => `${r.kind} ${r.path}`)),
    )
    if (cfgRoute === undefined || cfgControl === undefined) throw new Error('config/control route missing')

    // ---- 18.1 GET：契约形状 + 12 个可写键 + 默认值 ----
    const cfgGet = await runHandler(cfgRoute, { method: 'GET' })
    const cfgGetBody = cfgGet.json()
    check('§12 GET /task-alerts/config → 200 且 ok === true', cfgGet.status === 200 && cfgGetBody.ok === true, `statusCode=${cfgGet.status} body=${cfgGet.res.body.slice(0, 200)}`)
    check(
      // §13/§14 授权（与前两次「接口有意扩展」同一套处理）：契约**有意**新增可写键，
      // 所以这条「恰好 N 个键」的计数断言随之更新（10 → 12 → 13），并**立即**由下面
      // 针对新键的具体断言覆盖（只增不减，新键不是白加的）。
      '§12 GET config 恰含 §12.5 的 10 + §13.2 的 2 + §14 的 1 = 13 个键',
      EDITABLE_KEYS.every((key) => Object.prototype.hasOwnProperty.call(cfgGetBody.config ?? {}, key)) &&
        Object.keys(cfgGetBody.config ?? {}).length === 13,
      JSON.stringify(Object.keys(cfgGetBody.config ?? {})),
    )
    check(
      '§14 GET 默认值：maxAttempts = 2（判定「卡住」的尝试次数上限，设置页可填）',
      cfgGetBody.config.maxAttempts === 2,
      `maxAttempts=${String(cfgGetBody.config.maxAttempts)}`,
    )
    // §14 的快捷键规则：真值事故是用户配置里落成了 `stop_hotkey: "clear"`
    // （数字键盘 Clear 键被当成合法绑定），于是他的停止快捷键静默失效。
    check(
      '§14 快捷键规则：非法组合一律不合法（真值事故 "clear"、裸字母、只有修饰键、无修饰键的具名键）',
      configMod.isValidHotkeyText('clear') === false &&
        configMod.isValidHotkeyText('a') === false &&
        configMod.isValidHotkeyText('ctrl') === false &&
        configMod.isValidHotkeyText('ctrl+clear') === false &&
        configMod.isValidHotkeyText('delete') === false &&
        configMod.isValidHotkeyText('ctrl+alt+shift') === false &&
        configMod.isValidHotkeyText('f13+f14') === false &&
        configMod.isValidHotkeyText('ctrl+alt+') === false,
      `clear=${configMod.isValidHotkeyText('clear')} bare=${configMod.isValidHotkeyText('a')} named=${configMod.isValidHotkeyText('delete')}`,
    )
    check(
      '§14 快捷键规则：合法组合归一化（修饰键顺序固定；非法输入回落 fallback）',
      configMod.isValidHotkeyText('ctrl+alt+s') === true &&
        configMod.normalizeHotkeyText(' Shift+Control+p ') === 'ctrl+shift+p' &&
        configMod.normalizeHotkeyText('control+shift+F5') === 'ctrl+shift+f5' &&
        configMod.normalizeHotkeyText('meta+space') === 'meta+space' &&
        configMod.normalizeHotkeyText('clear') === 'ctrl+alt+s' &&
        configMod.normalizeHotkeyText('clear', 'FALLBACK') === 'FALLBACK',
      `norm=${configMod.normalizeHotkeyText(' Shift+Control+p ')} garbageOnLoad=${configMod.normalizeHotkeyText('clear')}`,
    )
    check('§12 GET 同时返回 state', cfgGetBody.state !== undefined && typeof cfgGetBody.state.revision === 'number', JSON.stringify(cfgGetBody.state?.stats))
    check(
      '§12 GET 默认值：enabled=true / hotkey 已归一 / reportAutoOpen=none / repeatInterval=0.05',
      cfgGetBody.config.enabled === true &&
        cfgGetBody.config.hotkey === 'ctrl+alt+s' &&
        cfgGetBody.config.reportAutoOpen === 'none' &&
        cfgGetBody.config.repeatInterval === 0.05,
      JSON.stringify({ enabled: cfgGetBody.config.enabled, hotkey: cfgGetBody.config.hotkey, reportAutoOpen: cfgGetBody.config.reportAutoOpen, repeatInterval: cfgGetBody.config.repeatInterval }),
    )
    check(
      '§12 GET 路径类字段已解析为绝对路径',
      cfgGetBody.config.reportDir === REPORT_CONFIG_DIR && cfgGetBody.config.audioPath === join(TMP_ROOT, 'alert.wav'),
      JSON.stringify({ reportDir: cfgGetBody.config.reportDir, audioPath: cfgGetBody.config.audioPath }),
    )
    check(
      '§12 GET config.ui 四个键齐全且为默认值',
      cfgGetBody.config.ui.blurStrength === 10 &&
        cfgGetBody.config.ui.primaryColor === '#87CEEB' &&
        cfgGetBody.config.ui.borderRadius === 20 &&
        cfgGetBody.config.ui.opacity === 0.7,
      JSON.stringify(cfgGetBody.config.ui),
    )
    check(
      '§13.2 GET 新键默认值：panelHotkey=ctrl+alt+a / showPill=true',
      cfgGetBody.config.panelHotkey === 'ctrl+alt+a' && cfgGetBody.config.showPill === true,
      JSON.stringify({ panelHotkey: cfgGetBody.config.panelHotkey, showPill: cfgGetBody.config.showPill }),
    )
    check(
      '§13.3 GET state 含 panelOpenSeq（初始 0，只增不减）',
      typeof cfgGetBody.state?.panelOpenSeq === 'number' && cfgGetBody.state.panelOpenSeq === 0,
      String(cfgGetBody.state?.panelOpenSeq),
    )
    check(
      '§13.2 state.config 也带 panelHotkey / showPill（浏览器半据此匹配面板快捷键与收起态）',
      cfgGetBody.state?.config?.panelHotkey === 'ctrl+alt+a' && cfgGetBody.state?.config?.showPill === true,
      JSON.stringify({ panelHotkey: cfgGetBody.state?.config?.panelHotkey, showPill: cfgGetBody.state?.config?.showPill }),
    )

    // ---- 18.2 PUT 局部更新（部分语义）+ POST 同义 ----
    const othersBefore = othersOf(cfgGetBody.config, 'repeatInterval')
    const putOne = await runHandler(cfgRoute, { method: 'PUT', body: JSON.stringify({ repeatInterval: 0.2 }) })
    const putOneBody = putOne.json()
    check(
      '§12 PUT 单键 → 200 且 ok/applied 均为 true',
      putOne.status === 200 && putOneBody.ok === true && putOneBody.applied === true,
      `statusCode=${putOne.status} body=${putOne.res.body.slice(0, 200)}`,
    )
    check('§12 PUT 单键 → 该键生效（repeatInterval 0.05 → 0.2）', putOneBody.config.repeatInterval === 0.2, String(putOneBody.config.repeatInterval))
    check('§12 PUT 部分更新：其余 9 个键一字未变', othersOf(putOneBody.config, 'repeatInterval') === othersBefore, `before=${othersBefore} after=${othersOf(putOneBody.config, 'repeatInterval')}`)
    check('§12 PUT 返回体里的 state 也立刻反映新值', putOneBody.state.config.repeatInterval === 0.2, String(putOneBody.state?.config?.repeatInterval))
    const postOne = await runHandler(cfgRoute, { method: 'POST', body: JSON.stringify({ repeatMax: 0 }) })
    check('§12 POST 与 PUT 等价（也接受）', postOne.status === 200 && postOne.json().ok === true && postOne.json().config.repeatMax === 0, `statusCode=${postOne.status} body=${postOne.res.body.slice(0, 200)}`)

    // ---- 18.3 校验失败 → 400 + errors（且不改值、不落盘）----
    const badType = await runHandler(cfgRoute, { method: 'PUT', body: JSON.stringify({ repeatInterval: 'abc' }) })
    const badTypeBody = badType.json()
    check('§12 PUT 非法类型 repeatInterval="abc" → 400 且 ok === false', badType.status === 400 && badTypeBody.ok === false, `statusCode=${badType.status} body=${badType.res.body}`)
    check(
      '§12 400 体带 errors.repeatInterval（键级理由）',
      badTypeBody.errors !== undefined && typeof badTypeBody.errors.repeatInterval === 'string' && badTypeBody.errors.repeatInterval.length > 0,
      JSON.stringify(badTypeBody.errors),
    )
    check('§12 校验失败不改变任何值', cfgService.getConfig().repeatInterval === 0.2, String(cfgService.getConfig().repeatInterval))
    const badLiteral = await runHandler(cfgRoute, { method: 'PUT', body: JSON.stringify({ reportAutoOpen: 'nope' }) })
    check(
      '§12 PUT 非法字面量 reportAutoOpen="nope" → 400 且 errors.reportAutoOpen 列出可选值',
      badLiteral.status === 400 && typeof badLiteral.json().errors?.reportAutoOpen === 'string' && badLiteral.json().errors.reportAutoOpen.includes('folder'),
      `statusCode=${badLiteral.status} body=${badLiteral.res.body}`,
    )
    const badBool = await runHandler(cfgRoute, { method: 'PUT', body: JSON.stringify({ enabled: 1 }) })
    check('§12 PUT 布尔键给数字 → 400 且 errors.enabled', badBool.status === 400 && typeof badBool.json().errors?.enabled === 'string', `statusCode=${badBool.status} body=${badBool.res.body}`)
    const badUi = await runHandler(cfgRoute, { method: 'PUT', body: JSON.stringify({ ui: { opacity: 'x' } }) })
    check('§12 PUT ui.opacity 非法类型 → 400 且 errors["ui.opacity"]', badUi.status === 400 && typeof badUi.json().errors?.['ui.opacity'] === 'string', `statusCode=${badUi.status} body=${badUi.res.body}`)
    const badBody = await runHandler(cfgRoute, { method: 'PUT', body: JSON.stringify([1, 2, 3]) })
    check('§12 PUT 请求体不是对象 → 400 且 errors.body', badBody.status === 400 && typeof badBody.json().errors?.body === 'string', `statusCode=${badBody.status} body=${badBody.res.body}`)
    const badJsonBody = await runHandler(cfgRoute, { method: 'PUT', body: '{not json' })
    check('§12 PUT 非法 JSON → 400（带 errors.body）', badJsonBody.status === 400 && badJsonBody.json().ok === false, `statusCode=${badJsonBody.status} body=${badJsonBody.res.body}`)
    const wrongMethod = await runHandler(cfgRoute, { method: 'DELETE' })
    check('§12 非 PUT/POST → 400（GET 仍 200，见上）', wrongMethod.status === 400 && wrongMethod.json().ok === false, `statusCode=${wrongMethod.status} body=${wrongMethod.res.body}`)
    check('§12 一串失败请求之后文件里的 repeat_interval 仍是 0.2', configMod.parseSimpleYaml(readFileSync(USER_CONFIG, 'utf8')).repeat_interval === 0.2, String(configMod.parseSimpleYaml(readFileSync(USER_CONFIG, 'utf8')).repeat_interval))

    // ---- 18.4 自写自读闭环（§12.2：必须能被 §6 的最小 YAML 子集解析器原样读回）----
    check('§12 PUT 之后用户配置文件真实存在（<DSH_HOME>/dsh-task-alerts.config.yaml）', existsSync(USER_CONFIG) === true, USER_CONFIG)
    const subset = configMod.parseSimpleYaml(readFileSync(USER_CONFIG, 'utf8'))
    const live = cfgService.getConfig()
    check(
      '§12 自写自读·标量：8 个非路径键原样读回',
      subset.enabled === live.enabled &&
        subset.stop_hotkey === live.hotkey &&
        subset.program_finish_alert === live.programFinishAlert &&
        subset.alert_on_unresolved === live.alertOnUnresolved &&
        subset.report_auto_open === live.reportAutoOpen &&
        subset.repeat_interval === live.repeatInterval &&
        subset.repeat_max === live.repeatMax,
      JSON.stringify({ file: { enabled: subset.enabled, stop_hotkey: subset.stop_hotkey, repeat_interval: subset.repeat_interval, repeat_max: subset.repeat_max, report_auto_open: subset.report_auto_open }, live }),
    )
    check(
      '§12 自写自读·路径：含反斜杠的绝对路径原样读回',
      subset.audio_path === live.audioPath && subset.report_dir === live.reportDir,
      JSON.stringify({ audio_path: subset.audio_path, report_dir: subset.report_dir }),
    )
    check(
      '§12 自写自读·ui：子映射 4 键原样读回（primary_color 的 # 未被当注释截断）',
      subset.ui !== undefined &&
        subset.ui.blur_strength === live.ui.blurStrength &&
        subset.ui.primary_color === live.ui.primaryColor &&
        subset.ui.border_radius === live.ui.borderRadius &&
        subset.ui.opacity === live.ui.opacity,
      JSON.stringify(subset.ui),
    )
    const reloaded = await configMod.loadConfig()
    check(
      '§12 真加载器重新读盘（§6 第 2 档）：布尔/字面量/数值一致',
      reloaded.enabled === live.enabled &&
        reloaded.programFinishAlert === live.programFinishAlert &&
        reloaded.alertOnUnresolved === live.alertOnUnresolved &&
        reloaded.reportAutoOpen === live.reportAutoOpen &&
        reloaded.repeatInterval === live.repeatInterval &&
        reloaded.repeatMax === live.repeatMax &&
        reloaded.maxAttempts === 2,
      JSON.stringify({ reloaded: { enabled: reloaded.enabled, repeatInterval: reloaded.repeatInterval, repeatMax: reloaded.repeatMax, maxAttempts: reloaded.maxAttempts }, live }),
    )
    check(
      '§12 真加载器重新读盘：路径 / ui / hotkey 一致',
      reloaded.audioPath === live.audioPath &&
        reloaded.reportDir === live.reportDir &&
        reloaded.hotkey === live.hotkey &&
        reloaded.ui.blurStrength === live.ui.blurStrength &&
        reloaded.ui.primaryColor === live.ui.primaryColor &&
        reloaded.ui.borderRadius === live.ui.borderRadius &&
        reloaded.ui.opacity === live.ui.opacity,
      JSON.stringify({ audioPath: reloaded.audioPath, reportDir: reloaded.reportDir, hotkey: reloaded.hotkey, ui: reloaded.ui }),
    )

    // ---- 18.5 enabled=false（§12.1 + §12.8.2：自动路径全停，含报告）----
    const offPut = await runHandler(cfgRoute, { method: 'PUT', body: JSON.stringify({ enabled: false }) })
    check('§12 PUT enabled:false → 200 且 config.enabled === false', offPut.status === 200 && offPut.json().config.enabled === false, `statusCode=${offPut.status} body=${offPut.res.body.slice(0, 200)}`)
    const reportsBeforeOff = reportFilesIn(REPORT_CONFIG_DIR)
    const callsBeforeOff = audioCalls.length
    const alertsBeforeOff = cfgService.getState().alerts.length
    const offAttempt1 = await cfgService.recordAttempt({ problemId: 'smoke-config/off', description: '§12 总开关', solved: false })
    const offAttempt2 = await cfgService.recordAttempt({ problemId: 'smoke-config/off', description: '§12 总开关', solved: false })
    const offFinish = await cfgService.recordProgramFinish({ label: '§12 关闭态', ok: true })
    const offState = cfgService.getState()
    check('§12 enabled=false：尝试仍被计数（第 1/2 次）', offAttempt1.attempts === 1 && offAttempt2.attempts === 2 && offAttempt2.unresolved === true, JSON.stringify({ offAttempt1, offAttempt2 }))
    check('§12 enabled=false：已达上限但不生成报告（无 reportPath）', offAttempt2.reportPath === undefined, JSON.stringify(offAttempt2))
    check(
      '§12 enabled=false：报告目录里没有新报告文件',
      reportFilesIn(REPORT_CONFIG_DIR).length === reportsBeforeOff.length,
      `before=${JSON.stringify(reportsBeforeOff)} after=${JSON.stringify(reportFilesIn(REPORT_CONFIG_DIR))}`,
    )
    check('§12 enabled=false：没有播放调用（音频边界 0 次 startRepeat）', audioCalls.length === callsBeforeOff, JSON.stringify(audioCalls.slice(callsBeforeOff)))
    check('§12 enabled=false：没有进入响铃循环', offState.repeatActive === false && offState.repeatCount === 0, JSON.stringify({ repeatActive: offState.repeatActive, repeatCount: offState.repeatCount }))
    check('§12 enabled=false：不因提醒新增面板/Toast', offState.alerts.length === alertsBeforeOff, `before=${alertsBeforeOff} after=${offState.alerts.length}`)
    check('§12 enabled=false：程序结束提醒也被短路（alerted === false）', offFinish.alerted === false, JSON.stringify(offFinish))

    // ---- 18.6 §12.8.1 test-alert 绕过总开关（设置页「试听」必须能诊断 audioPath）----
    const offTest = await runHandler(cfgControl, { body: JSON.stringify({ action: 'test-alert' }) })
    const offTestState = cfgService.getState()
    check('§12.8.1 enabled=false 时 control test-alert 仍 200 且 ok === true', offTest.status === 200 && offTest.json().ok === true, `statusCode=${offTest.status} body=${offTest.res.body.slice(0, 200)}`)
    check(
      '§12.8.1 enabled=false 时 test-alert 照常播声并进循环',
      audioCalls.slice(callsBeforeOff).some((call) => call.method === 'startRepeat') && offTestState.repeatActive === true,
      JSON.stringify(audioCalls.slice(callsBeforeOff)),
    )
    check('§12.8.1 enabled=false 时 test-alert 照常弹面板/Toast（alerts +1）', offTestState.alerts.length === alertsBeforeOff + 1, `before=${alertsBeforeOff} after=${offTestState.alerts.length}`)
    const offTestCommand = cfgCtx.record.commands.find((entry) => entry.name === 'alert-test')
    const offTestCommandResult = await offTestCommand.handler({ rawInput: '' })
    check('§12.8.1 enabled=false 时 /alert-test 命令仍 kind:success', offTestCommandResult.kind === 'success', JSON.stringify(offTestCommandResult))
    await runHandler(cfgControl, { body: JSON.stringify({ action: 'stop-audio' }) })
    check('§12.8.1 test-alert 的循环仍靠 stop-audio 终止', cfgService.getState().repeatActive === false, String(cfgService.getState().repeatActive))

    // ---- 18.7 §12.8.2 重新开启：历史计数不丢 + 提醒/报告恢复 ----
    const onPut = await runHandler(cfgRoute, { method: 'PUT', body: JSON.stringify({ enabled: true }) })
    check('§12.8.2 PUT enabled:true → 200 且恢复', onPut.status === 200 && onPut.json().config.enabled === true, `statusCode=${onPut.status} body=${onPut.res.body.slice(0, 200)}`)
    const callsBeforeOn = audioCalls.length
    const alertsBeforeOn = cfgService.getState().alerts.length
    const onAttempt3 = await cfgService.recordAttempt({ problemId: 'smoke-config/off', description: '§12 总开关', solved: false })
    const onState = cfgService.getState()
    check('§12.8.2 重新开启后计数延续（同一个 problemId 的第 3 次尝试）', onAttempt3.attempts === 3, JSON.stringify(onAttempt3))
    check('§12.8.2 重新开启后补上报告并写盘', typeof onAttempt3.reportPath === 'string' && existsSync(onAttempt3.reportPath) === true, String(onAttempt3.reportPath))
    check('§12.8.2 重新开启后报告落在报告目录里', reportFilesIn(REPORT_CONFIG_DIR).length === reportsBeforeOff.length + 1, JSON.stringify(reportFilesIn(REPORT_CONFIG_DIR)))
    check(
      '§12 重新开启后提醒重新播声并进循环',
      audioCalls.slice(callsBeforeOn).some((call) => call.method === 'startRepeat') && onState.repeatActive === true,
      JSON.stringify(audioCalls.slice(callsBeforeOn)),
    )
    check('§12 重新开启后提醒进入 alerts', onState.alerts.length === alertsBeforeOn + 1, `before=${alertsBeforeOn} after=${onState.alerts.length}`)
    check(
      '§12 响铃用的是 PUT 之后的 repeatInterval（0.2s → 200ms）',
      audioCalls.slice(callsBeforeOn).length > 0 && audioCalls.slice(callsBeforeOn)[0].intervalMs === 200,
      JSON.stringify(audioCalls.slice(callsBeforeOn)),
    )
    await runHandler(cfgControl, { body: JSON.stringify({ action: 'stop-audio' }) })

    // ---- 18.8 ui.* 热改（state 透传，浏览器半据此套 CSS 变量）----
    const uiPut = await runHandler(cfgRoute, { method: 'PUT', body: JSON.stringify({ ui: { blurStrength: 24 } }) })
    const uiBody = uiPut.json()
    check('§12 PUT ui.blurStrength=24 → 200 且 config.ui.blurStrength === 24', uiPut.status === 200 && uiBody.config.ui.blurStrength === 24, `statusCode=${uiPut.status} body=${uiPut.res.body.slice(0, 200)}`)
    check('§12 ui.* 立即生效：state.config.ui.blurStrength === 24', uiBody.state.config.ui.blurStrength === 24, String(uiBody.state?.config?.ui?.blurStrength))
    check(
      '§12 ui 部分更新不动其它 ui 键',
      uiBody.config.ui.primaryColor === '#87CEEB' && uiBody.config.ui.borderRadius === 20 && uiBody.config.ui.opacity === 0.7,
      JSON.stringify(uiBody.config.ui),
    )
    const uiClamp = await runHandler(cfgRoute, { method: 'PUT', body: JSON.stringify({ ui: { blurStrength: 99, opacity: 5 } }) })
    check(
      '§12 ui 越界只 clamp 不报错（blurStrength 99→40，opacity 5→1）',
      uiClamp.status === 200 && uiClamp.json().config.ui.blurStrength === 40 && uiClamp.json().config.ui.opacity === 1,
      JSON.stringify(uiClamp.json().config.ui),
    )

    // ---- 18.9 audioPath 热改：换掉 AudioPlayer 的目标文件 ----
    const swappedAudio = join(TMP_ROOT, 'custom-alert.wav')
    const audioPut = await runHandler(cfgRoute, { method: 'PUT', body: JSON.stringify({ audioPath: swappedAudio }) })
    check('§12 PUT audioPath → 200 且 config.audioPath 为新绝对路径', audioPut.status === 200 && audioPut.json().config.audioPath === swappedAudio, `statusCode=${audioPut.status} body=${audioPut.res.body.slice(0, 200)}`)
    const callsBeforeSwap = audioCalls.length
    await cfgService.recordProgramFinish({ label: '§12 新音频文件', ok: true })
    const swapCalls = audioCalls.slice(callsBeforeSwap)
    check(
      '§12 audioPath 立即生效：下一次提醒打的就是新文件',
      swapCalls.some((call) => call.method === 'startRepeat' && call.file === swappedAudio),
      JSON.stringify(swapCalls),
    )
    await runHandler(cfgControl, { body: JSON.stringify({ action: 'stop-audio' }) })

    // ---- 18.10 hotkey 热改：停旧监听、按新组合重启 ----
    const hkPut = await runHandler(cfgRoute, { method: 'PUT', body: JSON.stringify({ hotkey: 'Ctrl + Alt + K' }) })
    const hkBody = hkPut.json()
    check('§12 PUT hotkey → 200 且归一化为 ctrl+alt+k', hkPut.status === 200 && hkBody.config.hotkey === 'ctrl+alt+k', `statusCode=${hkPut.status} body=${hkPut.res.body.slice(0, 200)}`)
    check('§12 hotkey 变化同步到 state.config.hotkey（浏览器半据此更新 in-app 监听）', hkBody.state.config.hotkey === 'ctrl+alt+k', String(hkBody.state?.config?.hotkey))
    const logAfterHotkey = existsSync(CONFIG_LOG) ? readFileSync(CONFIG_LOG, 'utf8') : ''
    check(
      '§12 hotkey 热改：旧监听已停 + 按新组合重启（插件日志证据）',
      logAfterHotkey.includes('快捷键变更，重启全局监听：ctrl+alt+k'),
      CONFIG_LOG,
    )

    // ---- 18.11 两个布尔开关热改（含 AlertAdapter 重建）----
    const pfaOff = await runHandler(cfgRoute, { method: 'PUT', body: JSON.stringify({ programFinishAlert: false }) })
    check('§12 PUT programFinishAlert:false → 200', pfaOff.status === 200 && pfaOff.json().config.programFinishAlert === false, `statusCode=${pfaOff.status} body=${pfaOff.res.body.slice(0, 200)}`)
    const skippedFinish = await cfgService.recordProgramFinish({ label: '§12 关掉回合结束提醒', ok: true })
    check('§12 programFinishAlert=false 立即生效（alerted === false）', skippedFinish.alerted === false, JSON.stringify(skippedFinish))
    const aouOff = await runHandler(cfgRoute, { method: 'PUT', body: JSON.stringify({ alertOnUnresolved: false }) })
    check('§12 PUT alertOnUnresolved:false → 200', aouOff.status === 200 && aouOff.json().config.alertOnUnresolved === false, `statusCode=${aouOff.status} body=${aouOff.res.body.slice(0, 200)}`)
    await cfgService.recordAttempt({ problemId: 'smoke-config/quiet', description: '§12 只报告不提醒', solved: false })
    const aouAttempt2 = await cfgService.recordAttempt({ problemId: 'smoke-config/quiet', description: '§12 只报告不提醒', solved: false })
    const aouState = cfgService.getState()
    check(
      '§12 alertOnUnresolved=false 立即生效：只写报告不提醒',
      typeof aouAttempt2.reportPath === 'string' && aouState.alerts.every((alert) => alert.problemId !== 'smoke-config/quiet'),
      JSON.stringify({ reportPath: aouAttempt2.reportPath, alerts: aouState.alerts.map((a) => a.problemId ?? a.kind) }),
    )
    check(
      '§12 开关变化后事件适配层被重建（否则陈旧标志会静默丢弃事件）',
      readFileSync(CONFIG_LOG, 'utf8').includes('事件监听已按新配置重建'),
      CONFIG_LOG,
    )
    const flagsBack = await runHandler(cfgRoute, { method: 'PUT', body: JSON.stringify({ programFinishAlert: true, alertOnUnresolved: true }) })
    check(
      '§12 一次 PUT 里可以同时改多个键（两个开关一起恢复）',
      flagsBack.status === 200 && flagsBack.json().config.programFinishAlert === true && flagsBack.json().config.alertOnUnresolved === true,
      `statusCode=${flagsBack.status} body=${flagsBack.res.body.slice(0, 200)}`,
    )

    // ---- 18.12 reportDir / reportAutoOpen 热改 ----
    const movedReportDir = join(TMP_ROOT, 'reports-config-moved')
    const dirPut = await runHandler(cfgRoute, { method: 'PUT', body: JSON.stringify({ reportDir: movedReportDir }) })
    check('§12 PUT reportDir → 200 且为新绝对路径', dirPut.status === 200 && dirPut.json().config.reportDir === movedReportDir, `statusCode=${dirPut.status} body=${dirPut.res.body.slice(0, 200)}`)
    check('§12 reportDir 立即生效：state.config.reportDir 同步', dirPut.json().state.config.reportDir === movedReportDir, String(dirPut.json().state?.config?.reportDir))
    await cfgService.recordAttempt({ problemId: 'smoke-config/moved', description: '§12 换目录后写报告', solved: false })
    const movedAttempt2 = await cfgService.recordAttempt({ problemId: 'smoke-config/moved', description: '§12 换目录后写报告', solved: false })
    check(
      '§12 换目录后新报告写进新目录',
      typeof movedAttempt2.reportPath === 'string' && dirname(movedAttempt2.reportPath) === movedReportDir && existsSync(movedAttempt2.reportPath) === true,
      String(movedAttempt2.reportPath),
    )
    const autoPut = await runHandler(cfgRoute, { method: 'PUT', body: JSON.stringify({ reportAutoOpen: 'file' }) })
    check(
      '§12 PUT reportAutoOpen:file → 200 且 config/state 同步',
      autoPut.status === 200 && autoPut.json().config.reportAutoOpen === 'file' && autoPut.json().state.config.reportAutoOpen === 'file',
      `statusCode=${autoPut.status} body=${autoPut.res.body.slice(0, 200)}`,
    )
    const autoCallsBefore = autoOpenCalls.length
    await cfgService.recordAttempt({ problemId: 'smoke-config/auto', description: '§12 自动打开', solved: false })
    const autoAttempt2 = await cfgService.recordAttempt({ problemId: 'smoke-config/auto', description: '§12 自动打开', solved: false })
    await runHandler(cfgControl, { body: JSON.stringify({ action: 'stop-audio' }) })
    check(
      '§12 reportAutoOpen 热改后报告写盘即自动打开（runner 收到 (新报告路径, "file")）',
      autoOpenCalls.length === autoCallsBefore + 1 &&
        autoOpenCalls[autoCallsBefore].mode === 'file' &&
        autoOpenCalls[autoCallsBefore].path === autoAttempt2.reportPath,
      JSON.stringify(autoOpenCalls.slice(autoCallsBefore)),
    )

    // ---- 18.13 §12.6 响铃不自动停 ----
    const ringSetup = await runHandler(cfgRoute, { method: 'PUT', body: JSON.stringify({ repeatInterval: 0.05, repeatMax: 0 }) })
    check(
      '§12.6 PUT repeatInterval/repeatMax → 200（0.05s / 不限）',
      ringSetup.status === 200 && ringSetup.json().config.repeatInterval === 0.05 && ringSetup.json().config.repeatMax === 0,
      `statusCode=${ringSetup.status} body=${ringSetup.res.body.slice(0, 200)}`,
    )
    await cfgService.recordProgramFinish({ label: '§12 响铃不停', ok: true })
    const ring1 = cfgService.getState()
    check('§12.6 提醒后立刻进入循环', ring1.repeatActive === true, JSON.stringify({ repeatActive: ring1.repeatActive, repeatCount: ring1.repeatCount }))
    await sleep(320)
    const ring2 = cfgService.getState()
    await sleep(320)
    const ring3 = cfgService.getState()
    check(
      '§12.6 数轮之后仍在响：finish（会自动隐藏的 Toast）也不因时间而停',
      ring2.repeatActive === true && ring3.repeatActive === true,
      JSON.stringify({ ring2: ring2.repeatActive, ring3: ring3.repeatActive }),
    )
    check('§12.6 repeatCount 持续增长', ring2.repeatCount >= 1 && ring3.repeatCount > ring2.repeatCount, JSON.stringify({ ring2: ring2.repeatCount, ring3: ring3.repeatCount }))
    const midRing = await runHandler(cfgRoute, { method: 'PUT', body: JSON.stringify({ ui: { opacity: 0.8 } }) })
    check(
      '§12.6 配置热改不会误停正在响的铃',
      midRing.status === 200 && cfgService.getState().repeatActive === true,
      JSON.stringify({ status: midRing.status, repeatActive: cfgService.getState().repeatActive }),
    )
    await sleep(320)
    const ring4 = cfgService.getState()
    check('§12.6 而且仍在继续响（repeatCount 继续增长）', ring4.repeatActive === true && ring4.repeatCount > ring3.repeatCount, JSON.stringify({ ring3: ring3.repeatCount, ring4: ring4.repeatCount }))
    const ringStop = await runHandler(cfgControl, { body: JSON.stringify({ action: 'stop-audio' }) })
    const ring5 = cfgService.getState()
    check('§12.6 只有用户动作才停（stop-audio）', ringStop.status === 200 && ring5.repeatActive === false, JSON.stringify({ status: ringStop.status, repeatActive: ring5.repeatActive }))
    const frozenCount = ring5.repeatCount
    await sleep(320)
    check('§12.6 停后不再增长', cfgService.getState().repeatCount === frozenCount, `before=${frozenCount} after=${cfgService.getState().repeatCount}`)
    await cfgService.recordProgramFinish({ label: '§12 命令停铃', ok: true })
    const stopCmd = cfgCtx.record.commands.find((entry) => entry.name === 'alert-stop')
    const stopCmdResult = await stopCmd.handler({ rawInput: '' })
    check('§12.6 /alert-stop 停铃（与总开关无关）', stopCmdResult.kind === 'success' && cfgService.getState().repeatActive === false, JSON.stringify(stopCmdResult))

    // ---- 18.14 失败回滚：运行时生效失败 / 持久化失败 ----
    const beforeRuntimeFail = cfgService.getConfig()
    const runtimeFail = await runHandler(cfgRoute, { method: 'PUT', body: JSON.stringify({ reportDir: join(CONFIG_LOG, 'nope') }) })
    const afterRuntimeFail = cfgService.getConfig()
    check(
      '§12 运行时生效失败（报告目录不可创建）→ 500 且 ok === false',
      runtimeFail.status === 500 && runtimeFail.json().ok === false,
      `statusCode=${runtimeFail.status} body=${runtimeFail.res.body.slice(0, 240)}`,
    )
    check('§12 运行时生效失败 → 报告目录回滚到旧值', afterRuntimeFail.reportDir === beforeRuntimeFail.reportDir, `${afterRuntimeFail.reportDir} !== ${beforeRuntimeFail.reportDir}`)
    check('§12 运行时生效失败 → state 也反映旧值', cfgService.getState().config.reportDir === beforeRuntimeFail.reportDir, String(cfgService.getState().config.reportDir))

    // 持久化失败：把用户配置指到「父路径是文件」的位置 → mkdir 必然失败 → 500 + 回滚
    process.env.DSH_TASK_ALERTS_USER_CONFIG = join(CONFIG_LOG, 'nope.yaml')
    const badAudioCalls = []
    const badCtx = createFakeCtx()
    await mod.apply(badCtx.ctx, {
      report_dir: './reports-badpath',
      log_file: './badpath.log',
      repeat_interval: 0.05,
      audioProbe: (call) => badAudioCalls.push(call),
      openRunner: recordingRunner([]),
    })
    const badService = badCtx.ctx.taskAlerts
    const badRoute = badCtx.record.routes.find((route) => route.path === '/task-alerts/config')
    const badBefore = badService.getConfig()
    check('§12 坏用户配置路径的实例同样注册了 /task-alerts/config', badRoute !== undefined, JSON.stringify(badCtx.record.routes.map((r) => r.path)))
    const badPut = await runHandler(badRoute, { method: 'PUT', body: JSON.stringify({ repeatInterval: 5, enabled: false, ui: { blurStrength: 33 } }) })
    const badAfter = badService.getConfig()
    check(
      '§12 持久化失败 → 500 且 ok === false',
      badPut.status === 500 && badPut.json().ok === false,
      `statusCode=${badPut.status} body=${badPut.res.body.slice(0, 240)}`,
    )
    check('§12 持久化失败 → 回滚：全部键一字未变', JSON.stringify(badAfter) === JSON.stringify(badBefore), `${JSON.stringify(badBefore)} → ${JSON.stringify(badAfter)}`)
    check('§12 持久化失败 → 回滚后总开关仍为 true（自动路径照常工作）', badAfter.enabled === true, String(badAfter.enabled))
    const badFinish = await badService.recordProgramFinish({ label: '§12 回滚后仍提醒', ok: true })
    check(
      '§12 持久化失败回滚后提醒路径仍可用（播声 + 进入 alerts）',
      badFinish.alerted === true && badAudioCalls.some((call) => call.method === 'startRepeat') && badService.getState().alerts.length === 1,
      JSON.stringify({ badFinish, badAudioCalls, alerts: badService.getState().alerts.length }),
    )
    for (const dispose of badCtx.record.effectDisposers) dispose()
    delete process.env.DSH_TASK_ALERTS_USER_CONFIG

    // ---- 18.15 可注入的用户配置路径（便于测试，不碰真实 <DSH_HOME>）----
    const overridePath = join(TMP_ROOT, 'override-config.yaml')
    // 先清掉默认路径上的产物，才能证明「注入路径生效且默认路径没被碰」。
    if (existsSync(USER_CONFIG)) rmSync(USER_CONFIG, { force: true })
    process.env.DSH_TASK_ALERTS_USER_CONFIG = overridePath
    const overrideCtx = createFakeCtx()
    await mod.apply(overrideCtx.ctx, { report_dir: './reports-override', log_file: './override.log', openRunner: recordingRunner([]) })
    const overrideRoute = overrideCtx.record.routes.find((route) => route.path === '/task-alerts/config')
    const overridePut = await runHandler(overrideRoute, { method: 'PUT', body: JSON.stringify({ repeatMax: 4 }) })
    check(
      '§12 DSH_TASK_ALERTS_USER_CONFIG 生效：PUT 写到注入的路径',
      overridePut.status === 200 && existsSync(overridePath) === true && existsSync(USER_CONFIG) === false,
      `override=${overridePath} exists=${existsSync(overridePath)} defaultExists=${existsSync(USER_CONFIG)}`,
    )
    for (const dispose of overrideCtx.record.effectDisposers) dispose()
    delete process.env.DSH_TASK_ALERTS_USER_CONFIG
    if (existsSync(overridePath)) rmSync(overridePath, { force: true })

    // ---- 18.16 只写用户配置文件，绝不改写包根 config.yaml ----
    check('§12 全程未改写包根 config.yaml', readFileSync(PACKAGE_CONFIG_YAML, 'utf8') === packageConfigBefore, PACKAGE_CONFIG_YAML)

    // ---- 18.17 清理：测试写出的用户配置文件必须删除 ----
    if (existsSync(USER_CONFIG)) rmSync(USER_CONFIG, { force: true })
    check('§12 清理：<DSH_HOME>/dsh-task-alerts.config.yaml 已删除（不污染用户环境）', existsSync(USER_CONFIG) === false, USER_CONFIG)

    // =====================================================================
    // §13.6 多绑定快捷键：两个快捷键 = 两个绑定 = **一个** OS 监听器。
    // `hotkeyServerFactory` 是与 openRunner / audioProbe 同源的注入缝，所以这一节
    // 既真实驱动宿主那两个绑定，又绝不派生第二个 WinKeyServer.exe。
    // =====================================================================
    const HOTKEY_LOG = join(TMP_ROOT, 'hotkey.log')
    const fakeServers = []
    const fakeServerFactory = () => {
      const server = {
        listeners: [],
        killed: false,
        addListener(listener) {
          server.listeners.push(listener)
        },
        removeListener(listener) {
          server.listeners = server.listeners.filter((entry) => entry !== listener)
        },
        kill() {
          server.killed = true
        },
      }
      fakeServers.push(server)
      return Promise.resolve(server)
    }
    /** OS 侧事件是「一次一个键」的：修饰键靠累积集合推导，所以先按修饰键再按主键。 */
    const pressChord = (keyName) => {
      const server = fakeServers[fakeServers.length - 1]
      if (server === undefined) throw new Error('no fake hotkey server')
      server.listeners.slice().forEach((listener) => {
        for (const name of ['LEFT CTRL', 'LEFT ALT', keyName]) {
          listener({ name, state: 'DOWN' }, {})
        }
        for (const name of [keyName, 'LEFT ALT', 'LEFT CTRL']) {
          listener({ name, state: 'UP' }, {})
        }
      })
    }
    const liveServers = () => fakeServers.filter((server) => server.killed === false).length

    const hotkeyCtx = createFakeCtx()
    await mod.apply(hotkeyCtx.ctx, {
      ...RING_BASE,
      report_dir: './reports-hotkey',
      log_file: './hotkey.log',
      hotkeyServerFactory: fakeServerFactory,
    })
    const hotkeyService = hotkeyCtx.ctx.taskAlerts
    const hotkeyRoute = hotkeyCtx.record.routes.find((route) => route.path === '/task-alerts/config')
    check(
      '§13.6 两个快捷键只创建 1 个 OS 监听器实例（绑定共用一个服务）',
      fakeServers.length === 1 && liveServers() === 1 && fakeServers[0].listeners.length === 1,
      `servers=${fakeServers.length} live=${liveServers()} listeners=${fakeServers.map((s) => s.listeners.length).join(',')}`,
    )

    const seqBefore = hotkeyService.getState().panelOpenSeq
    pressChord('A')
    const seqAfterPanel = hotkeyService.getState().panelOpenSeq
    check(
      '§13.3 panel_hotkey 命中 → panelOpenSeq +1',
      seqAfterPanel === seqBefore + 1,
      `before=${seqBefore} after=${seqAfterPanel}`,
    )
    pressChord('B')
    check(
      '§13.6 未绑定的组合不触发任何回调',
      hotkeyService.getState().panelOpenSeq === seqAfterPanel && liveServers() === 1,
      `seq=${hotkeyService.getState().panelOpenSeq} live=${liveServers()}`,
    )
    pressChord('S')
    const hotkeyLogText = existsSync(HOTKEY_LOG) ? readFileSync(HOTKEY_LOG, 'utf8') : ''
    check(
      '§13.6 stop_hotkey 命中 → 走「停止音效」这一个回调（日志证据），且不动 panelOpenSeq',
      (hotkeyLogText.includes('快捷键已停止音效') || hotkeyLogText.includes('快捷键触发，但当前没有在播放的音效')) &&
        hotkeyService.getState().panelOpenSeq === seqAfterPanel,
      `seq=${hotkeyService.getState().panelOpenSeq}`,
    )
    check(
      '§13.6 panel_hotkey 命中写进了插件日志（含新的 panelOpenSeq）',
      hotkeyLogText.includes(`全局快捷键：打开/收起提醒面板（panelOpenSeq=${seqAfterPanel}）`),
      HOTKEY_LOG,
    )

    // ---- 18.19 §13.2 panel_hotkey / showPill 热改：无需重启 + 仍然只有一个监听器 ----
    const panelPut = await runHandler(hotkeyRoute, { method: 'PUT', body: JSON.stringify({ panelHotkey: 'Ctrl + Alt + P' }) })
    const panelPutBody = panelPut.json()
    check(
      '§13.2 PUT panelHotkey → 200 且归一化为 ctrl+alt+p',
      panelPut.status === 200 && panelPutBody.config.panelHotkey === 'ctrl+alt+p',
      `statusCode=${panelPut.status} body=${panelPut.res.body.slice(0, 200)}`,
    )
    check(
      '§13.2 panelHotkey 立即生效：state.config 同步（浏览器半无需重启即按新组合匹配）',
      panelPutBody.state.config.panelHotkey === 'ctrl+alt+p',
      String(panelPutBody.state?.config?.panelHotkey),
    )
    check(
      '§13.6 热改后旧监听器被杀、新的只有一个（活跃实例仍是 1）',
      fakeServers.length === 2 && fakeServers[0].killed === true && liveServers() === 1,
      `servers=${fakeServers.length} killed=${fakeServers.map((s) => s.killed).join(',')} live=${liveServers()}`,
    )
    const seqBeforeNewCombo = hotkeyService.getState().panelOpenSeq
    pressChord('P')
    check(
      '§13.6 新组合命中 → panelOpenSeq 再 +1',
      hotkeyService.getState().panelOpenSeq === seqBeforeNewCombo + 1,
      `before=${seqBeforeNewCombo} after=${hotkeyService.getState().panelOpenSeq}`,
    )
    pressChord('A')
    check(
      '§13.6 旧组合已失效（换绑定后不再命中）',
      hotkeyService.getState().panelOpenSeq === seqBeforeNewCombo + 1,
      String(hotkeyService.getState().panelOpenSeq),
    )
    const hotkeyLogAfterPut = existsSync(HOTKEY_LOG) ? readFileSync(HOTKEY_LOG, 'utf8') : ''
    check(
      '§13.6 热改走既有的「快捷键变更，重启全局监听」路径（日志锚点仍在）',
      hotkeyLogAfterPut.includes('快捷键变更，重启全局监听：ctrl+alt+s') &&
        hotkeyLogAfterPut.includes('面板快捷键同步：ctrl+alt+p'),
      HOTKEY_LOG,
    )

    const pillPut = await runHandler(hotkeyRoute, { method: 'PUT', body: JSON.stringify({ showPill: false }) })
    const pillPutBody = pillPut.json()
    check(
      '§13.2 PUT showPill:false → 200 且立即生效（state 同步）',
      pillPut.status === 200 && pillPutBody.config.showPill === false && pillPutBody.state.config.showPill === false,
      `statusCode=${pillPut.status} body=${pillPut.res.body.slice(0, 200)}`,
    )
    check(
      '§13.2 两个新键都真的落盘（panel_hotkey / show_pill）',
      (() => {
        if (!existsSync(USER_CONFIG)) return false
        const written = configMod.parseSimpleYaml(readFileSync(USER_CONFIG, 'utf8'))
        return written.panel_hotkey === 'ctrl+alt+p' && written.show_pill === false
      })(),
      USER_CONFIG,
    )
    for (const dispose of hotkeyCtx.record.effectDisposers) dispose()
    check('§13 清理：用户配置文件已删除', (() => { if (existsSync(USER_CONFIG)) rmSync(USER_CONFIG, { force: true }); return existsSync(USER_CONFIG) === false })(), USER_CONFIG)
  } catch (error) {
    if (existsSync(USER_CONFIG)) rmSync(USER_CONFIG, { force: true })
    delete process.env.DSH_TASK_ALERTS_USER_CONFIG
    fatal('§12 配置 API 断言不抛异常', error)
  }
}

main()
  .catch((error) => {
    fatal('冒烟脚本自身异常', error)
  })
  .finally(() => {
    const passed = results.filter((line) => line.startsWith('PASS')).length
    const lines = [
      '===== dsh-task-alerts host smoke =====',
      `临时根目录 : ${TMP_ROOT}`,
      ...results,
      '-------------------------------------',
      `断言总计 ${results.length}：通过 ${passed}，失败 ${failures}`,
      failures === 0 ? '结果：全部通过' : `结果：${failures} 条失败`,
    ]
    process.stdout.write(`${lines.join('\n')}\n`)
    if (process.env.DSH_TASK_ALERTS_SMOKE_KEEP === '1') {
      process.stdout.write(`临时目录保留：${TMP_ROOT}\n`)
    } else {
      try {
        rmSync(TMP_ROOT, { recursive: true, force: true })
      } catch {
        /* 清理失败不影响结论 */
      }
    }
    process.exitCode = failures === 0 ? 0 : 1
    // OS 级快捷键后端会留下子进程句柄；断言已定，显式退出避免脚本悬挂。
    process.exit(process.exitCode)
  })
