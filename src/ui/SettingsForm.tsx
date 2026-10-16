/* =============================================================================
 * dsh-task-alerts — browser half: the DSH settings page + the sidebar-foot action.
 *
 * Concatenated as a plain script (contract §7, explicit ordered whitelist in
 * scripts/build-client.mjs): no import/export. Everything shared with
 * `client.ts` travels through `window.__DSA__`; the two components are
 * published there as `SettingsSection` and `SidebarAction`.
 *
 * Wire contract (§12): `GET /task-alerts/config` fills the form,
 * `PUT /task-alerts/config` sends ONLY the top-level keys the user actually
 * changed (partial update, §12.4 — an unmodified key is never resent, so a
 * concurrent change elsewhere cannot be clobbered), a 400 shows its `errors`
 * under the offending field, and a successful save re-pulls
 * `/task-alerts/state` so `ui.*` reaches the panel immediately (§12.7).
 *
 * `enabled: false` NEVER disables this form (§12.1): it is the only path back.
 *
 * Contract §9: every request, listener and event handler is individually
 * guarded; failures are logged and degraded, never rethrown into the settings
 * panel or into DSH's boot path.
 * ========================================================================== */

/*
 * Contract §7's four-global block: `window`/`document` are already declared by
 * lib.dom under tsconfig.client.json (re-declaring them as `any` is a hard
 * TS2451/TS2403 in a global script program), so only the two names the DOM
 * library does not own are declared here. `React` arrives from the factory
 * scope (`require('react')`).
 */
declare var React: any
declare function require(mod: string): any

/*
 * Contract §7: every .tsx source declares the JSX global namespace. The
 * `IntrinsicElements` index signature is deliberately NOT re-declared here:
 * this file and AlertPanel.tsx are both global scripts in ONE tsc program, and
 * two identical index signatures on the merged `JSX.IntrinsicElements` is a
 * hard TS2374 ("Duplicate index signature for type 'string'") — verified with
 * `tsc -p tsconfig.client.json --noEmit`. AlertPanel.tsx declares it once and
 * declaration merging makes it visible here, so `strict` still sees
 * `JSX.Element` and every intrinsic tag this file uses.
 */
declare namespace JSX {
  interface Element { }
  interface ElementClass { }
}

;(function () {
  var root: any = ((window as any).__DSA__ = (window as any).__DSA__ || {})

  /* --------------------------------------------------------------------- *
   * Contract types (§12.5 EditableConfig — local declaration on purpose, the
   * two halves never import each other)
   * --------------------------------------------------------------------- */

  interface UiDraft {
    blurStrength: any
    primaryColor: any
    borderRadius: any
    opacity: any
  }

  interface Draft {
    enabled: any
    audioPath: any
    repeatInterval: any
    repeatMax: any
    maxAttempts: any
    hotkey: any
    panelHotkey: any
    showPill: any
    programFinishAlert: any
    alertOnUnresolved: any
    reportDir: any
    reportAutoOpen: any
    ui: UiDraft
  }

  interface FieldSpec {
    key: string
    kind: string
    label: string
    hint: string
    min?: number
    max?: number
    step?: number
    options?: any[]
  }

  var CONFIG_URL = '/task-alerts/config'
  var AUTO_OPEN_VALUES = ['none', 'file', 'folder', 'browser']
  var AUTO_OPEN_LABELS: any = {
    none: '不打开',
    file: '用默认程序打开文件',
    folder: '打开所在文件夹',
    browser: '用浏览器打开 file://',
  }

  /* Values the form shows before (or without) a successful GET — the contract
     defaults from §6/§12.5. */
  var DEFAULTS: Draft = {
    enabled: true,
    audioPath: '',
    repeatInterval: 0,
    repeatMax: 0,
    maxAttempts: 2,
    hotkey: 'ctrl+alt+s',
    panelHotkey: 'ctrl+alt+a',
    showPill: true,
    programFinishAlert: true,
    alertOnUnresolved: true,
    reportDir: '',
    reportAutoOpen: 'none',
    ui: { blurStrength: 10, primaryColor: '#87CEEB', borderRadius: 20, opacity: 0.7 },
  }

  var FIELDS: FieldSpec[] = [
    {
      key: 'enabled',
      kind: 'switch',
      label: '启用提醒',
      hint: '关闭后不响铃、不弹面板/Toast；本设置页与「试听」仍然完全可用。',
    },
    {
      key: 'audioPath',
      kind: 'text',
      label: '音效文件',
      hint: '提醒音效的路径，例如 ./alert.wav 或绝对路径。',
    },
    {
      key: 'repeatInterval',
      kind: 'number',
      label: '重复间隔（秒）',
      hint: '两次响铃之间等待多久；0 = 只响一次（可填小数）。',
      min: 0,
      step: 0.5,
    },
    {
      key: 'repeatMax',
      kind: 'number',
      label: '重复上限',
      hint: '0 = 一直响到手动关闭（默认）；大于 0 时等于「额外重复的次数」。',
      min: 0,
      step: 1,
    },
    {
      key: 'maxAttempts',
      kind: 'number',
      label: '卡住上限（尝试次数）',
      hint: '同一问题连续失败多少次就判定为「无法解决」并弹出面板 / 写出报告；最小 1，默认 2。',
      min: 1,
      step: 1,
    },
    {
      key: 'hotkey',
      kind: 'hotkey',
      label: '停止快捷键',
      hint: '聚焦下面的输入框后直接按下组合键即可捕获，例如 ctrl+alt+s。',
    },
    {
      key: 'panelHotkey',
      kind: 'hotkey',
      label: '面板快捷键',
      hint: '聚焦输入框后直接按下组合键即可捕获（例如 ctrl+alt+a）：在窗口内打开/收起提醒面板。同一组合在系统范围内也由宿主监听。',
    },
    {
      key: 'showPill',
      kind: 'switch',
      label: '保留收起把手',
      hint: '没有待处理提醒时，右下角仍保留一个「收起态」把手——关掉面板后靠它（或快捷键）再打开。关掉本项 = 回到「关了就没」的旧行为。',
    },
    {
      key: 'programFinishAlert',
      kind: 'switch',
      label: '程序结束时提醒',
      hint: '程序完成时弹一条完成 Toast（只有完成 Toast 才自动隐藏）。',
    },
    {
      key: 'alertOnUnresolved',
      kind: 'switch',
      label: '未解决时提醒',
      hint: '问题多次尝试仍未解决时弹面板并响铃；这类提醒不会自动消失。',
    },
    {
      key: 'reportDir',
      kind: 'text',
      label: '报告目录',
      hint: '未解决问题生成的 TXT 报告写入该目录。',
    },
    {
      key: 'reportAutoOpen',
      kind: 'select',
      label: '报告自动打开',
      hint: '报告写盘成功后如何处理这份报告。',
      options: AUTO_OPEN_VALUES,
    },
    {
      key: 'ui.blurStrength',
      kind: 'number',
      label: '毛玻璃模糊（px）',
      hint: '面板背景模糊强度，0–40（默认 10）。',
      min: 0,
      max: 40,
      step: 1,
    },
    {
      key: 'ui.primaryColor',
      kind: 'text',
      label: '主色',
      hint: '十六进制颜色，例如 #87CEEB（默认）。',
    },
    {
      key: 'ui.borderRadius',
      kind: 'number',
      label: '圆角（px）',
      hint: '面板圆角，0–48（默认 20）。',
      min: 0,
      max: 48,
      step: 1,
    },
    {
      key: 'ui.opacity',
      kind: 'number',
      label: '不透明度',
      hint: '面板底色不透明度，0.05–1（默认 0.7）。',
      min: 0.05,
      max: 1,
      step: 0.05,
    },
  ]

  /* --------------------------------------------------------------------- *
   * Logging (a failure here must never be the failure that surfaces)
   * --------------------------------------------------------------------- */

  function log(level: string, message: string, detail?: any): void {
    try {
      if (typeof console === 'undefined' || !console) return
      var sink = (console as any)[level] || (console as any).log
      if (typeof sink === 'function') {
        if (detail === undefined) sink.call(console, '[task-alerts] ' + message)
        else sink.call(console, '[task-alerts] ' + message, detail)
      }
    } catch (err) {
      /* ignore */
    }
  }

  function note(message: string, detail?: any): void {
    log('warn', message, detail)
  }

  function describe(error: any): string {
    try {
      if (error === null || error === undefined) return '未知错误'
      if (typeof error === 'string') return error
      if (typeof error.message === 'string' && error.message.length > 0) return error.message
      return String(error)
    } catch (err) {
      return '未知错误'
    }
  }

  /* --------------------------------------------------------------------- *
   * Store: one module-scoped draft plus a version counter.
   *
   * The draft deliberately lives OUTSIDE React state. The form is mounted
   * inside DSH's settings modal, which can be closed and reopened at any time;
   * a module-scoped draft keeps half-typed edits while staying trivially
   * testable without a reconciler.
   * --------------------------------------------------------------------- */

  var store: any = {
    draft: null as Draft | null,
    server: null as Draft | null,
    dirty: {} as any,
    errors: {} as any,
    message: '',
    saving: false,
    epoch: 0,
  }
  var listeners: any[] = []

  function notify(): void {
    var current = listeners.slice()
    for (var i = 0; i < current.length; i++) {
      try {
        current[i](store.epoch)
      } catch (err) {
        note('settings listener failed', err)
      }
    }
  }

  function bump(): void {
    store.epoch = store.epoch + 1
    notify()
  }

  function subscribe(listener: any): any {
    try {
      if (typeof listener !== 'function') return null
      listeners.push(listener)
      return function () {
        try {
          for (var i = 0; i < listeners.length; i++) {
            if (listeners[i] === listener) {
              listeners.splice(i, 1)
              break
            }
          }
        } catch (err) {
          note('settings unsubscribe failed', err)
        }
      }
    } catch (err) {
      note('settings subscribe failed', err)
      return null
    }
  }

  /* --------------------------------------------------------------------- *
   * Draft normalisation — every host value is untrusted (§12.5)
   * --------------------------------------------------------------------- */

  function asNumber(value: any): number | null {
    if (typeof value === 'number' && isFinite(value)) return value
    if (typeof value === 'string' && value.replace(/^\s+|\s+$/g, '').length > 0) {
      var parsed = Number(value)
      if (isFinite(parsed)) return parsed
    }
    return null
  }

  function asUi(source: any, fallback: UiDraft): UiDraft {
    var out: UiDraft = {
      blurStrength: fallback.blurStrength,
      primaryColor: fallback.primaryColor,
      borderRadius: fallback.borderRadius,
      opacity: fallback.opacity,
    }
    if (!source || typeof source !== 'object') return out
    var blur = asNumber(source.blurStrength)
    if (blur !== null) out.blurStrength = blur
    var radius = asNumber(source.borderRadius)
    if (radius !== null) out.borderRadius = radius
    var opacity = asNumber(source.opacity)
    if (opacity !== null) out.opacity = opacity
    if (typeof source.primaryColor === 'string' && source.primaryColor.length > 0) {
      out.primaryColor = source.primaryColor
    }
    return out
  }

  function normalize(source: any): Draft {
    var out: Draft = {
      enabled: DEFAULTS.enabled,
      audioPath: DEFAULTS.audioPath,
      repeatInterval: DEFAULTS.repeatInterval,
      repeatMax: DEFAULTS.repeatMax,
      maxAttempts: DEFAULTS.maxAttempts,
      hotkey: DEFAULTS.hotkey,
      panelHotkey: DEFAULTS.panelHotkey,
      showPill: DEFAULTS.showPill,
      programFinishAlert: DEFAULTS.programFinishAlert,
      alertOnUnresolved: DEFAULTS.alertOnUnresolved,
      reportDir: DEFAULTS.reportDir,
      reportAutoOpen: DEFAULTS.reportAutoOpen,
      ui: { blurStrength: DEFAULTS.ui.blurStrength, primaryColor: DEFAULTS.ui.primaryColor, borderRadius: DEFAULTS.ui.borderRadius, opacity: DEFAULTS.ui.opacity },
    }
    if (!source || typeof source !== 'object') return out

    if (typeof source.enabled === 'boolean') out.enabled = source.enabled
    if (typeof source.programFinishAlert === 'boolean') out.programFinishAlert = source.programFinishAlert
    if (typeof source.alertOnUnresolved === 'boolean') out.alertOnUnresolved = source.alertOnUnresolved
    if (typeof source.audioPath === 'string') out.audioPath = source.audioPath
    if (typeof source.reportDir === 'string') out.reportDir = source.reportDir
    if (typeof source.hotkey === 'string' && source.hotkey.length > 0) out.hotkey = source.hotkey
    if (typeof source.panelHotkey === 'string' && source.panelHotkey.length > 0) {
      out.panelHotkey = source.panelHotkey
    }
    if (typeof source.showPill === 'boolean') out.showPill = source.showPill
    if (typeof source.reportAutoOpen === 'string' && AUTO_OPEN_VALUES.indexOf(source.reportAutoOpen) >= 0) {
      out.reportAutoOpen = source.reportAutoOpen
    }
    var interval = asNumber(source.repeatInterval)
    if (interval !== null && interval >= 0) out.repeatInterval = interval
    var max = asNumber(source.repeatMax)
    if (max !== null && max >= 0) out.repeatMax = max
    var attempts = asNumber(source.maxAttempts)
    if (attempts !== null && attempts >= 1) out.maxAttempts = Math.floor(attempts)
    out.ui = asUi(source.ui, DEFAULTS.ui)
    return out
  }

  function cloneDraft(source: any): Draft {
    return normalize(source === null || source === undefined ? DEFAULTS : source)
  }

  function currentDraft(): Draft {
    if (!store.draft) store.draft = cloneDraft(store.server === null ? DEFAULTS : store.server)
    return store.draft as Draft
  }

  function topKey(key: string): string {
    var at = key.indexOf('.')
    return at < 0 ? key : key.slice(0, at)
  }

  function draftValue(draft: Draft, key: string): any {
    try {
      var parts = key.split('.')
      var cursor: any = draft
      for (var i = 0; i < parts.length; i++) {
        if (cursor === null || cursor === undefined) return undefined
        cursor = cursor[parts[i]]
      }
      return cursor
    } catch (err) {
      return undefined
    }
  }

  /* --------------------------------------------------------------------- *
   * Mutations
   * --------------------------------------------------------------------- */

  function setField(key: string, value: any): void {
    try {
      var draft: any = currentDraft()
      var parts = key.split('.')
      var cursor: any = draft
      for (var i = 0; i < parts.length - 1; i++) {
        if (!cursor[parts[i]] || typeof cursor[parts[i]] !== 'object') cursor[parts[i]] = {}
        cursor = cursor[parts[i]]
      }
      cursor[parts[parts.length - 1]] = value

      var top = topKey(key)
      /* Dirty granularity is the FIELD, not the EditableConfig key: a `ui.*`
         edit travels as `ui: { <sub>: value }` (the host's EditablePatch allows
         a partial `ui`), so a stale sibling value can never clobber a
         concurrent change to another sub-key. */
      store.dirty[key] = true
      /* The host reports errors under EditableConfig keys (§12.4), so editing a
         field clears the error of its own key and of its group. */
      delete store.errors[key]
      delete store.errors[top]
      store.message = ''
      bump()
    } catch (err) {
      note('field update failed', err)
    }
  }

  function numberOrRaw(raw: any): any {
    var text = raw === null || raw === undefined ? '' : String(raw)
    var trimmed = text.replace(/^\s+|\s+$/g, '')
    if (trimmed.length === 0) return ''
    var value = Number(trimmed)
    /* A non-numeric entry is passed through verbatim: the host validates and
       answers with a field-scoped 400 error, which is the honest UX. */
    return isFinite(value) ? value : text
  }

  /* --------------------------------------------------------------------- *
   * HTTP (§12.3 / §12.4)
   * --------------------------------------------------------------------- */

  function readJson(res: any): any {
    return new Promise(function (resolve: any) {
      try {
        if (!res || typeof res.json !== 'function') {
          resolve(null)
          return
        }
        var pending = res.json()
        if (pending && typeof pending.then === 'function') {
          pending.then(
            function (payload: any) { resolve(payload) },
            function () { resolve(null) },
          )
        } else {
          resolve(pending)
        }
      } catch (err) {
        resolve(null)
      }
    })
  }

  function isFailed(res: any): boolean {
    if (!res) return true
    if (res.ok === false) return true
    if (typeof res.status === 'number' && res.status >= 400) return true
    return false
  }

  /**
   * 版本偏斜自解释。
   *
   * DSH 的宿主半**只在应用启动时加载**，而浏览器半是**通过 HTTP 现取**的 ——
   * 所以「刚刷新过网页、宿主产物却还是旧的」是一种很容易出现的状态：
   * 界面看起来是新的，配置接口却返回 404/405。干巴巴一句 "http 405"
   * 会让人以为插件坏了，于是这里把真实原因和可执行的下一步直接讲出来。
   */
  function skewHint(status: number): string {
    if (status !== 404 && status !== 405) return ''
    return '（宿主半还是旧版本，缺少 /task-alerts/config 路由 —— DSH 的宿主半只在应用启动时加载，请从托盘完整退出 DSH 后重新打开；只刷新网页不够）'
  }

  /** 从 describe() 产出的 "http <code>" 里取回状态码；取不到返回 0。 */
  function statusFromError(error: any): number {
    var m = /http\s+(\d{3})\b/.exec(describe(error))
    return m ? Number(m[1]) : 0
  }

  function load(): any {
    var pending: any = null
    try {
      if (typeof fetch !== 'function') {
        store.message = '当前环境没有 fetch，表单显示默认值（无法读取/保存配置）'
        bump()
        return null
      }
      pending = fetch(CONFIG_URL, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
      })
    } catch (err) {
      store.message = '读取配置失败：' + describe(err) + skewHint(statusFromError(err))
      bump()
      return null
    }

    try {
      if (!pending || typeof pending.then !== 'function') return null
      return pending
        .then(function (res: any) {
          if (isFailed(res)) throw new Error('http ' + String(res && res.status))
          return readJson(res)
        })
        .then(function (payload: any) {
          try {
            var config = payload && typeof payload === 'object' ? payload.config : null
            if (!config) {
              store.message = '配置响应缺少 config 字段'
              bump()
              return null
            }
            store.server = normalize(config)
            store.draft = cloneDraft(store.server)
            store.dirty = {}
            store.errors = {}
            store.message = ''
            pushState(payload.state)
            bump()
          } catch (err) {
            note('configuration intake failed', err)
          }
          return null
        })
        .catch(function (err: any) {
          store.message = '读取配置失败：' + describe(err) + skewHint(statusFromError(err))
          bump()
        })
    } catch (err) {
      note('configuration load failed', err)
      return null
    }
  }

  /* Feed a server-side state into the running panel (never load-bearing). */
  function pushState(state: any): void {
    try {
      if (!state || typeof root.pushState !== 'function') return
      root.pushState(state)
    } catch (err) {
      note('state push failed', err)
    }
  }

  /* §12.7: the panel must show new `ui.*` values immediately after a save. */
  function refreshState(): void {
    try {
      if (typeof root.refreshState === 'function') root.refreshState()
    } catch (err) {
      note('immediate state refresh failed', err)
    }
  }

  /* Only what the user actually touched (§12.4 partial update). A top-level
     field travels as itself; a `ui.*` field travels as `ui: { <sub>: value }`
     because the host's EditablePatch explicitly allows a partial `ui`
     (src/types.ts:129-130), which keeps concurrent edits to other sub-keys
     safe. */
  function buildPatch(): any {
    var body: any = {}
    var draft: any = currentDraft()
    var keys = Object.keys(store.dirty)
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i]
      var at = key.indexOf('.')
      if (at < 0) {
        if (!Object.prototype.hasOwnProperty.call(draft, key)) continue
        body[key] = draft[key]
        continue
      }
      var top = key.slice(0, at)
      var sub = key.slice(at + 1)
      var group = body[top]
      if (!group || typeof group !== 'object') group = body[top] = {}
      if (draft[top] && Object.prototype.hasOwnProperty.call(draft[top], sub)) {
        group[sub] = draft[top][sub]
      }
    }
    return body
  }

  function save(): any {
    var body: any = null
    try {
      body = buildPatch()
      if (Object.keys(body).length === 0) {
        store.message = '没有需要保存的改动'
        bump()
        return null
      }
      if (typeof fetch !== 'function') {
        store.message = '当前环境没有 fetch，无法保存'
        bump()
        return null
      }
      store.saving = true
      store.errors = {}
      store.message = ''
      bump()
    } catch (err) {
      note('save preparation failed', err)
      return null
    }

    var pending: any = null
    try {
      pending = fetch(CONFIG_URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'same-origin',
      })
    } catch (err) {
      store.saving = false
      store.message = '保存失败：' + describe(err)
      bump()
      return null
    }

    try {
      if (!pending || typeof pending.then !== 'function') {
        store.saving = false
        store.message = '保存失败：请求无法发出'
        bump()
        return null
      }
      var finish = function (message: string, errors: any): void {
        store.saving = false
        store.errors = errors || {}
        store.message = message
        bump()
      }
      return pending
        .then(function (res: any) {
          return readJson(res).then(function (payload: any) {
            return { res: res, payload: payload }
          })
        })
        .then(function (outcome: any) {
          try {
            var res = outcome ? outcome.res : null
            var payload = outcome ? outcome.payload : null
            var status = res && typeof res.status === 'number' ? res.status : 0
            if (status === 400) {
              /* §12.4: field-scoped validation failure. */
              finish(
                (payload && payload.error) || '保存被拒绝，请检查下面标出的字段',
                payload && typeof payload.errors === 'object' ? payload.errors : {},
              )
              return null
            }
            if (isFailed(res)) {
              finish('保存失败：' + ((payload && payload.error) || ('http ' + String(status))) + skewHint(status), {})
              return null
            }
            var config = payload && typeof payload === 'object' ? payload.config : null
            if (config) {
              store.server = normalize(config)
              store.draft = cloneDraft(store.server)
            }
            store.dirty = {}
            pushState(payload ? payload.state : null)
            finish('已保存', {})
            refreshState()
          } catch (err) {
            note('save response handling failed', err)
          }
          return null
        })
        .catch(function (err: any) {
          finish('保存失败：' + describe(err), {})
        })
    } catch (err) {
      note('save request failed', err)
      return null
    }
  }

  function reset(): void {
    try {
      store.errors = {}
      store.message = ''
      store.dirty = {}
      if (store.server) {
        store.draft = cloneDraft(store.server)
        bump()
        return
      }
      load()
    } catch (err) {
      note('reset failed', err)
    }
  }

  function testAlert(): void {
    try {
      if (typeof root.testAlert === 'function') root.testAlert()
    } catch (err) {
      note('test alert failed', err)
    }
  }

  /* --------------------------------------------------------------------- *
   * Hotkey capture (focus the input, press the combination)
   * --------------------------------------------------------------------- */

  /* Mirror of the host's hotkey rule (src/config.ts). The two halves cannot share
     code, so keep this list in sync with `HOTKEY_NAMED_KEYS` / `isAllowedHotkeyKey`.

     Why it exists: the capture used to accept ANY key name plus zero modifiers, so
     the numpad Clear key (event.key === 'Clear') was saved as `stop_hotkey: "clear"`
     and silently broke the user's stop hotkey; a bare letter was equally accepted,
     and a globally bound bare 'a' would swallow that key everywhere. */
  var HOTKEY_NAMED_KEYS: any = {
    space: 1, enter: 1, escape: 1, tab: 1, backspace: 1, delete: 1, insert: 1, home: 1, end: 1,
    pageup: 1, pagedown: 1, arrowup: 1, arrowdown: 1, arrowleft: 1, arrowright: 1,
    up: 1, down: 1, left: 1, right: 1, comma: 1, period: 1, slash: 1, semicolon: 1, quote: 1,
    bracketleft: 1, bracketright: 1, backslash: 1, minus: 1, equal: 1, backquote: 1,
  }
  function isAllowedHotkeyKey(key: string): boolean {
    if (/^[a-z0-9]$/.test(key)) return true
    if (/^f([1-9]|1[0-9]|2[0-4])$/.test(key)) return true
    return HOTKEY_NAMED_KEYS[key] === 1
  }

  function comboFromEvent(event: any): string | null {
    try {
      var mods: string[] = []
      if (event && event.ctrlKey) mods.push('ctrl')
      if (event && event.altKey) mods.push('alt')
      if (event && event.shiftKey) mods.push('shift')
      if (event && event.metaKey) mods.push('meta')
      var key = event && typeof event.key === 'string' ? event.key.toLowerCase() : ''
      if (!key) return null
      /* A bare modifier press is not a binding — keep waiting. */
      if (key === 'control' || key === 'alt' || key === 'shift' || key === 'meta' || key === 'os') return null
      if (key === ' ') key = 'space'
      /* A key outside the allowlist (e.g. 'clear', 'escape' is fine, 'f13' is fine)
         is not a binding either — keep waiting instead of saving garbage. */
      if (!isAllowedHotkeyKey(key)) return null
      /* And require at least one modifier: a globally bound bare key would swallow
         that key everywhere. */
      if (mods.length === 0) return null
      mods.push(key)
      return mods.join('+')
    } catch (err) {
      return null
    }
  }

  /* Both hotkey fields (stop_hotkey / panel_hotkey) share this capture logic:
     only the field key differs, so it is a factory instead of two copies. */
  function captureHotkeyFor(key: string): any {
    return function (event: any): void {
      try {
        if (event && typeof event.preventDefault === 'function') event.preventDefault()
        if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
        var combo = comboFromEvent(event)
        if (!combo) return
        setField(key, combo)
      } catch (err) {
        note('hotkey capture failed', err)
      }
    }
  }

  /* --------------------------------------------------------------------- *
   * Live status (poll health, ringing, audio, report dir)
   * --------------------------------------------------------------------- */

  function readStatus(): any {
    var out: any = { state: null, scheme: 'light', vars: {}, polling: true, failures: 0 }
    try {
      if (typeof root.getStatus === 'function') {
        var status = root.getStatus()
        if (status && typeof status === 'object') {
          if (status.state) out.state = status.state
          if (status.ok === false) out.polling = false
          if (typeof status.failures === 'number') out.failures = status.failures
        }
      }
      if (typeof root.getSnapshot === 'function') {
        var snap = root.getSnapshot()
        if (snap && typeof snap === 'object') {
          if (!out.state && snap.state) out.state = snap.state
          if (snap.scheme === 'dark') out.scheme = 'dark'
        }
      }
      if (typeof root.styleVars === 'function') out.vars = root.styleVars(out.state) || {}
    } catch (err) {
      note('settings status read failed', err)
    }
    return out
  }

  function useStore(): number {
    var pair = React.useState(store.epoch)
    React.useEffect(function () {
      var alive = true
      var listener = function () {
        if (alive) pair[1](store.epoch)
      }
      listeners.push(listener)
      return function () {
        alive = false
        for (var i = 0; i < listeners.length; i++) {
          if (listeners[i] === listener) {
            listeners.splice(i, 1)
            break
          }
        }
      }
    }, [])
    return pair[0]
  }

  function useSnapshotTick(): number {
    var pair = React.useState(0)
    React.useEffect(function () {
      var alive = true
      var unsubscribe: any = null
      try {
        if (typeof root.subscribe === 'function') {
          unsubscribe = root.subscribe(function () {
            if (alive) pair[1](function (n: number) { return n + 1 })
          })
        }
      } catch (err) {
        note('snapshot subscription failed', err)
      }
      return function () {
        alive = false
        try {
          if (typeof unsubscribe === 'function') unsubscribe()
        } catch (err) {
          /* ignore */
        }
      }
    }, [])
    return pair[0]
  }

  /* --------------------------------------------------------------------- *
   * Field rendering
   * --------------------------------------------------------------------- */

  function renderHint(hint: string, className?: string): any {
    return React.createElement('div', { className: className || 'dsa-hint' }, hint)
  }

  function messageText(value: any): string {
    try {
      if (value === null || value === undefined) return ''
      if (typeof value === 'string') return value
      if (typeof value === 'object') return JSON.stringify(value)
      return String(value)
    } catch (err) {
      return ''
    }
  }

  function renderError(message: any): any {
    var text = messageText(message)
    if (text.length === 0) return null
    return React.createElement('div', { className: 'dsa-error', role: 'alert' }, text)
  }

  function renderField(field: FieldSpec, draft: Draft): any {
    var key = field.key
    var raw = draftValue(draft, key)
    var id = 'dsa-field-' + key.replace(/\./g, '-')
    var error = store.errors[key]
    var control: any = null
    var children: any[] = []

    if (field.kind === 'switch') {
      control = React.createElement('input', {
        id: id,
        className: 'dsa-switch',
        type: 'checkbox',
        checked: raw === true,
        'data-dsa-field': key,
        onChange: function (event: any) {
          try {
            setField(key, !!(event && event.target && event.target.checked))
          } catch (err) {
            note('switch change failed', err)
          }
        },
      })
    } else if (field.kind === 'select') {
      // 这里**故意不用原生 <select>**。
      //
      // 原生下拉的弹层在 Electron 里受系统主题与祖辈裁切共同影响，实测症状是
      // 「选项看不见 / 要浮在别的元素上才看得见」：`.dsa-input` 是半透明背景，
      // 而 `<option>` 完全继承 UA 默认配色，深色方案下就会文字与底色同色；设置弹窗
      // 的内容列又是滚动容器，弹层还可能被裁。分段控件没有弹层，两个病因同时消失，
      // 4 个短选项也放得下，并且 `role=radiogroup` 的键盘/读屏语义与下拉等价。
      //
      // 每个选项用 IIFE 包一层，是为了拿到**逐项独立**的 onChange 闭包
      // （`var value` 在循环里共享，直接闭包会全部捕获最后一项）。
      var optionNodes: any[] = []
      var options: any[] = field.options || []
      var currentValue = raw === undefined || raw === null ? 'none' : String(raw)
      for (var i = 0; i < options.length; i++) {
        optionNodes.push(
          (function (optionValue: string) {
            var selected = currentValue === optionValue
            return React.createElement(
              'label',
              {
                key: optionValue,
                className: 'dsa-choice' + (selected ? ' dsa-choice--on' : ''),
                'data-dsa-choice': optionValue,
                'data-dsa-selected': selected ? 'true' : 'false',
              },
              React.createElement('input', {
                type: 'radio',
                className: 'dsa-choice-input',
                name: 'dsa-choice-' + key,
                value: optionValue,
                checked: selected,
                onChange: function () {
                  try {
                    setField(key, optionValue)
                  } catch (err) {
                    note('choice change failed', err)
                  }
                },
              }),
              React.createElement('span', { className: 'dsa-choice-text' }, AUTO_OPEN_LABELS[optionValue] || optionValue),
            )
          })(String(options[i])),
        )
      }
      control = React.createElement(
        'div',
        {
          id: id,
          className: 'dsa-choices',
          role: 'radiogroup',
          'data-dsa-field': key,
          'data-dsa-control': 'choices',
        },
        optionNodes,
      )
    } else {
      control = React.createElement('input', {
        id: id,
        className: 'dsa-input',
        type: field.kind === 'number' ? 'number' : 'text',
        value: raw === undefined || raw === null ? '' : String(raw),
        'data-dsa-field': key,
        min: field.min === undefined ? undefined : field.min,
        max: field.max === undefined ? undefined : field.max,
        step: field.step === undefined ? undefined : field.step,
        spellCheck: false,
        onKeyDown: field.kind === 'hotkey' ? captureHotkeyFor(key) : undefined,
        onChange: function (event: any) {
          try {
            var next = event && event.target ? event.target.value : ''
            setField(key, field.kind === 'number' ? numberOrRaw(next) : next)
          } catch (err) {
            note('input change failed', err)
          }
        },
      })
    }

    var attributes: any = {
      className: 'dsa-field',
      key: key,
      'data-dsa-field-row': key,
      'data-dsa-invalid': error ? 'true' : undefined,
    }
    children.push(React.createElement('label', { className: 'dsa-label', htmlFor: id }, field.label))
    children.push(control)
    children.push(renderHint(field.hint))
    if (error) children.push(renderError(error))
    return React.createElement('div', attributes, children)
  }

  /* Error keys the host reported that no rendered field claimed (for example a
     group-level `ui` error) still have to be visible somewhere. */
  function leftoverErrors(claimed: any): string {
    var parts: string[] = []
    try {
      var keys = Object.keys(store.errors)
      for (var i = 0; i < keys.length; i++) {
        if (claimed[keys[i]]) continue
        var message = messageText(store.errors[keys[i]])
        if (message.length === 0) continue
        parts.push(String(keys[i]) + '：' + message)
      }
    } catch (err) {
      return ''
    }
    return parts.join('；')
  }

  /* --------------------------------------------------------------------- *
   * SettingsSection — one page in the DSH settings panel (`settings.section`)
   * --------------------------------------------------------------------- */

  function SettingsSection(props: any): any {
    useStore()
    useSnapshotTick()

    React.useEffect(function () {
      load()
    }, [])

    var status = readStatus()
    var draft = currentDraft()
    var state = status.state
    var enabled = draft.enabled !== false
    var claimed: any = {}
    var fields: any[] = []
    var uiFields: any[] = []
    var i = 0

    for (i = 0; i < FIELDS.length; i++) {
      var spec = FIELDS[i]
      var node = renderField(spec, draft)
      if (spec.key === 'ui') continue
      if (spec.key.indexOf('ui.') === 0) uiFields.push(node)
      else fields.push(node)
      claimed[spec.key] = true
    }

    var badges: any[] = []
    badges.push(
      React.createElement(
        'span',
        { className: 'dsa-badge', key: 'poll' },
        status.polling === false ? '轮询异常 · 已降级 5s' : '轮询正常',
      ),
    )
    badges.push(
      React.createElement(
        'span',
        { className: 'dsa-badge' + (state && state.audioPlaying ? ' dsa-badge--live' : ''), key: 'audio' },
        state && state.audioPlaying ? '音效播放中' : '音效未播放',
      ),
    )
    badges.push(
      React.createElement(
        'span',
        {
          className: 'dsa-badge' + (state && state.repeatActive ? ' dsa-badge--live' : ''),
          key: 'repeat',
          'data-dsa-repeat': state && state.repeatActive ? 'active' : 'idle',
        },
        state && state.repeatActive
          ? '重复提醒中 · 第 ' + String(state.repeatCount === undefined ? 0 : state.repeatCount) + ' 次'
          : '未在重复',
      ),
    )
    badges.push(
      React.createElement(
        'span',
        {
          className: 'dsa-badge',
          key: 'panel-hotkey',
          'data-dsa-panel-hotkey': draft.panelHotkey ? String(draft.panelHotkey) : '',
          title: '打开/收起提醒面板的快捷键（窗口内 + 系统范围）',
        },
        '面板快捷键 ' + (draft.panelHotkey ? String(draft.panelHotkey) : '（未配置）'),
      ),
    )
    badges.push(
      React.createElement(
        'span',
        { className: 'dsa-badge', key: 'dir', title: draft.reportDir ? String(draft.reportDir) : '' },
        '报告目录 ' + (draft.reportDir ? String(draft.reportDir) : '（未配置）'),
      ),
    )
    badges.push(
      React.createElement(
        'span',
        { className: 'dsa-badge' + (enabled ? '' : ' dsa-badge--off'), key: 'enabled' },
        enabled ? '提醒已开启' : '提醒已关闭',
      ),
    )

    var actions = React.createElement(
      'div',
      { className: 'dsa-actions', key: 'actions' },
      React.createElement(
        'button',
        {
          type: 'button',
          className: 'dsa-btn',
          'data-dsa-action': 'test',
          title: '播放一次提醒音效（不受「启用提醒」影响）',
          onClick: function () { testAlert() },
        },
        '试听',
      ),
      React.createElement(
        'button',
        {
          type: 'button',
          className: 'dsa-btn dsa-btn--primary dsa-save',
          'data-dsa-action': 'save',
          disabled: store.saving === true,
          onClick: function () { save() },
        },
        store.saving === true ? '保存中…' : '保存',
      ),
      React.createElement(
        'button',
        {
          type: 'button',
          className: 'dsa-btn',
          'data-dsa-action': 'reset',
          onClick: function () { reset() },
        },
        '重置',
      ),
      typeof props.close === 'function'
        ? React.createElement(
            'button',
            {
              type: 'button',
              className: 'dsa-btn',
              'data-dsa-action': 'close',
              onClick: function () {
                try {
                  props.close()
                } catch (err) {
                  note('close failed', err)
                }
              },
            },
            '完成',
          )
        : null,
    )

    var leftover = leftoverErrors(claimed)
    var messageNode = null
    if (store.message) {
      var failed = !!(store.message.indexOf('失败') >= 0 || store.message.indexOf('拒绝') >= 0 || store.message.indexOf('缺少') >= 0)
      messageNode = React.createElement(
        'div',
        { className: failed ? 'dsa-hint dsa-hint--error' : 'dsa-hint dsa-hint--ok', 'data-dsa-message': failed ? 'error' : 'ok' },
        store.message,
      )
    }

    var children: any[] = []
    children.push(
      React.createElement(
        'div',
        { className: 'dsa-header', key: 'header' },
        React.createElement('h2', { className: 'dsa-title' }, '任务提醒'),
        React.createElement('div', { className: 'dsa-status', 'data-dsa-status': 'true' }, badges),
      ),
    )

    if (!enabled) {
      children.push(
        React.createElement(
          'div',
          { className: 'dsa-hint dsa-hint--warn', key: 'disabled', 'data-dsa-disabled': 'true' },
          '提醒当前已关闭。本设置页与「试听」仍然完全可用——改完直接保存即可重新开启。',
        ),
      )
    }

    children.push(React.createElement('div', { className: 'dsa-fields', key: 'fields' }, fields))
    children.push(
      React.createElement(
        'div',
        { className: 'dsa-group', key: 'ui' },
        React.createElement('div', { className: 'dsa-group-title' }, '界面外观'),
        React.createElement('div', { className: 'dsa-fields' }, uiFields),
      ),
    )
    if (leftover) children.push(renderError(leftover))
    if (messageNode) children.push(messageNode)
    children.push(actions)

    return React.createElement(
      'div',
      {
        className: 'dsa-settings',
        'data-dsa-settings': 'true',
        'data-dsa-enabled': enabled ? 'true' : 'false',
        style: status.vars,
        'data-dsa-scheme': status.scheme,
      },
      children,
    )
  }

  /* --------------------------------------------------------------------- *
   * SidebarAction — the small glass button at the sidebar foot
   * (`sidebar.footer.action`; the slot supplies `wide` only)
   * --------------------------------------------------------------------- */

  function SidebarAction(props: any): any {
    var flash = React.useState(0)
    var hidden = false
    try {
      if (typeof root.panelHidden === 'function') hidden = root.panelHidden() === true
    } catch (err) {
      hidden = false
    }
    var wide = !props || props.wide !== false

    var onClick = function (): void {
      /* Preferred path: DSH's own settings panel. There is no supported API for
         a footer action to open it (see client.ts `openSettingsPanel` for the
         evidence trail), so this normally returns false and the panel toggle
         below runs — the button always answers with something visible. */
      var opened = false
      try {
        if (typeof root.openSettingsPanel === 'function') opened = root.openSettingsPanel() === true
      } catch (err) {
        note('settings probe failed', err)
        opened = false
      }

      if (!opened) {
        try {
          if (typeof root.togglePanel === 'function') root.togglePanel()
        } catch (err) {
          note('panel toggle failed', err)
        }
      }

      try {
        flash[1](function (n: number) { return n + 1 })
      } catch (err) {
        /* ignore: the re-render is cosmetic */
      }
    }

    var className = 'dsa-sidebar-action' + (hidden ? ' dsa-sidebar-action--collapsed' : '')
    var children: any[] = [
      React.createElement('span', { className: 'dsa-sidebar-action-icon', 'aria-hidden': 'true', key: 'icon' }, '🔔'),
    ]
    if (wide) {
      children.push(React.createElement('span', { className: 'dsa-sidebar-action-label', key: 'label' }, '任务提醒'))
    }
    if (hidden) {
      children.push(
        React.createElement('span', { className: 'dsa-sidebar-action-hint', key: 'hint' }, '面板已收起'),
      )
    }

    return React.createElement(
      'button',
      {
        type: 'button',
        className: className,
        'data-dsa-sidebar-action': 'task-alerts.settings',
        title: hidden ? '展开任务提醒面板' : '任务提醒设置（不可用时收起/展开提醒面板）',
        'aria-label': '任务提醒',
        'aria-pressed': hidden ? 'true' : 'false',
        onClick: onClick,
      },
      children,
    )
  }

  root.SettingsSection = SettingsSection
  root.SidebarAction = SidebarAction
  root.settings = {
    load: load,
    save: save,
    reset: reset,
    subscribe: subscribe,
    describe: function () {
      return {
        draft: store.draft,
        server: store.server,
        dirty: Object.keys(store.dirty),
        errors: store.errors,
        message: store.message,
        saving: store.saving,
      }
    },
  }
})()
