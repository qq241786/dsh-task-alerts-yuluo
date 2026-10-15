/* =============================================================================
 * dsh-task-alerts — browser half: cordis client plugin.
 *
 * Concatenated as a plain script (contract §7): no import/export. `React` comes
 * from the factory scope (`require('react')`), the DOM globals from the block
 * below, and everything this file shares with `AlertPanel.tsx` travels through
 * `window.__DSA__`.
 *
 * Responsibilities:
 *   * idempotent `<style data-dsa-style>` injection (text taken from
 *     `window.__DSA__.css`, inlined by scripts/build-client.mjs)
 *   * `GET /task-alerts/state?since=<revision>` polling — 1000ms, 1500ms while
 *     the panel has something to show, 5000ms after 3 consecutive failures
 *   * `POST /task-alerts/control` for stop-audio / test-alert / dismiss /
 *     open-report (contract §11.4)
 *   * in-app `keydown` match against the configured `stop_hotkey` **and**
 *     `panel_hotkey` (the latter toggles the panel, contract §13.5)
 *   * panel visibility store (contract §13.4): `manualOpen || (pending
 *     unresolved alert && not locally hidden)` — `manualOpen` lives here, is
 *     module-scoped and survives the alert being dismissed, which is exactly
 *     what makes "closed" reopenable. `panelOpenSeq` growth from the host's
 *     global panel hotkey also sets `manualOpen = true`.
 *   * theme colour-scheme -> `data-dsa-scheme` on the `.dsa-root` host container
 *   * optional theme token enhancement (primary/accent), never load-bearing
 *   * four slot registrations: two `shell.overlay` seats plus the optional
 *     `settings.section` page and `sidebar.footer.action` button (contract
 *     §12.7 — the two optional slots are injected and fully isolated from the
 *     overlay seats)
 *
 * Contract §9: every listener, timer and request path is individually guarded;
 * a failure is logged and degraded, never rethrown into the host.
 * ========================================================================== */

/*
 * Contract §7 asks for the four-global block (`React`/`window`/`require`/
 * `document`). Under tsconfig.client.json the program includes `lib.dom`, which
 * already declares `window` and `document`; re-declaring either as `any` is a
 * hard TS2451/TS2403 in a global script file, so only the two names the DOM
 * library does not own are declared. `window` is reached through
 * `window as any`, and `document` is used with its DOM types.
 */
declare var React: any
declare function require(mod: string): any

;(function () {
  var root: any = ((window as any).__DSA__ = (window as any).__DSA__ || {})

  /* --------------------------------------------------------------------- *
   * Contract types (contract §3, duplicated locally on purpose)
   * --------------------------------------------------------------------- */

  interface AlertRecord {
    id: string
    kind: string
    level?: string
    title?: string
    message?: string
    problemId?: string
    attempts?: number
    maxAttempts?: number
    reportPath?: string
    createdAt?: string
    audio?: boolean
    dismissed?: boolean
  }

  interface UiConfig {
    blurStrength?: number
    primaryColor?: string
    borderRadius?: number
    opacity?: number
  }

  interface AlertState {
    revision?: number
    generatedAt?: string
    config?: {
      hotkey?: string
      ui?: UiConfig
      programFinishAlert?: boolean
      alertOnUnresolved?: boolean
      maxAttempts?: number
      reportDir?: string
      /* contract §11.1 */
      repeatInterval?: number
      repeatMax?: number
      reportAutoOpen?: string
      /* contract §13.2 */
      panelHotkey?: string
      showPill?: boolean
    }
    stats?: { problems?: number; unresolved?: number; alerts?: number }
    audioPlaying?: boolean
    /* contract §11.2 */
    repeatActive?: boolean
    repeatCount?: number
    /* contract §13.3 — host-side counter, +1 per global "open panel" hotkey */
    panelOpenSeq?: number
    alerts?: AlertRecord[]
  }

  interface Snapshot {
    state: AlertState | null
    scheme: 'light' | 'dark'
  }

  /* --------------------------------------------------------------------- *
   * State / logging plumbing
   * --------------------------------------------------------------------- */

  var STATE_URL = '/task-alerts/state'
  var CONTROL_URL = '/task-alerts/control'
  var TOKEN_SOURCE = 'dsh-task-alerts'
  var POLL_MS = 1000
  var POLL_MS_PANEL = 1500
  var POLL_MS_DEGRADED = 5000
  var FAIL_THRESHOLD = 3
  var FALLBACK_PRIMARY = '#87CEEB'
  var FALLBACK_TINT_SOFT = '#E0F7FA'

  var currentCtx: any = null
  var snapshot: Snapshot = { state: null, scheme: 'light' }
  var listeners: any[] = []
  var revision = -1
  var consecutiveFailures = 0
  var disposed = false
  var pollTimer: any = null
  var hotkeyRaw = 'ctrl+alt+s'
  var panelHotkeyRaw = 'ctrl+alt+a'
  var detachKeydown: any = null
  var detachThemeChange: any = null
  var detachMedia: any = null
  var styleNode: any = null
  var styleOwned = false
  var slotDisposers: any[] = []
  var extraDisposers: any[] = []

  function log(level: string, message: string, detail?: any): void {
    try {
      if (typeof console === 'undefined' || !console) return
      var sink = (console as any)[level] || (console as any).log
      if (typeof sink === 'function') {
        if (detail === undefined) sink.call(console, '[task-alerts] ' + message)
        else sink.call(console, '[task-alerts] ' + message, detail)
      }
    } catch (err) {
      /* logging must never be the thing that throws */
    }
  }

  function note(message: string, detail?: any): void {
    log('warn', message, detail)
  }

  function notify(): void {
    var current = listeners.slice()
    for (var i = 0; i < current.length; i++) {
      try {
        current[i](snapshot)
      } catch (err) {
        note('listener failed', err)
      }
    }
  }

  /* --------------------------------------------------------------------- *
   * Style injection (contract §8)
   * --------------------------------------------------------------------- */

  function findStyleNode(): any {
    try {
      if (typeof document === 'undefined' || !document) return null
      if (typeof document.querySelector !== 'function') return null
      return document.querySelector('style[data-dsa-style]')
    } catch (err) {
      return null
    }
  }

  function injectStyle(): void {
    try {
      if (typeof document === 'undefined' || !document) return
      var existing = findStyleNode()
      if (existing) {
        styleNode = existing
        styleOwned = false
        return
      }
      var css = root.css
      if (typeof css !== 'string' || css.length === 0) {
        note('styles.css missing from the bundle; running unstyled')
        return
      }
      if (typeof document.createElement !== 'function') return
      var node = document.createElement('style')
      if (!node) return
      if (typeof node.setAttribute === 'function') node.setAttribute('data-dsa-style', '')
      try {
        node.textContent = css
      } catch (err) {
        node.appendChild(document.createTextNode(css))
      }
      var parent = document.head || document.body || document.documentElement
      if (!parent || typeof parent.appendChild !== 'function') return
      parent.appendChild(node)
      styleNode = node
      styleOwned = true
    } catch (err) {
      note('style injection failed', err)
    }
  }

  function removeStyle(): void {
    try {
      if (!styleOwned || !styleNode) return
      var parent = styleNode.parentNode
      if (parent && typeof parent.removeChild === 'function') parent.removeChild(styleNode)
    } catch (err) {
      note('style removal failed', err)
    } finally {
      styleNode = null
      styleOwned = false
    }
  }

  /* --------------------------------------------------------------------- *
   * HTTP (contract §4)
   * --------------------------------------------------------------------- */

  function hasFetch(): boolean {
    return typeof fetch === 'function'
  }

  function fetchState(): any {
    if (!hasFetch()) return Promise.reject(new Error('fetch unavailable'))
    var url = STATE_URL + '?since=' + String(revision)
    return fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    }).then(function (res: any) {
      if (!res) throw new Error('empty response')
      if (res.ok === false) throw new Error('http ' + String(res.status))
      if (typeof res.status === 'number' && res.status >= 400) {
        throw new Error('http ' + String(res.status))
      }
      if (typeof res.json !== 'function') throw new Error('non-json response')
      return res.json()
    })
  }

  /* Control calls are fire-and-forget: the next poll reconciles the UI. */
  function postControl(action: string, alertId?: string): void {
    try {
      if (!hasFetch()) {
        note('fetch unavailable; control "' + action + '" dropped')
        return
      }
      var body: any = { action: action }
      if (alertId) body.alertId = alertId
      var pending = fetch(CONTROL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'same-origin',
      })
      if (!pending || typeof pending.then !== 'function') return
      pending
        .then(function (res: any) {
          if (!res || typeof res.json !== 'function') return null
          return res.json()
        })
        .then(function (payload: any) {
          if (payload && payload.state) acceptState(payload.state)
        })
        .catch(function (err: any) {
          note('control "' + action + '" failed', err)
        })
    } catch (err) {
      note('control "' + action + '" threw', err)
    }
  }

  /* --------------------------------------------------------------------- *
   * State intake
   * --------------------------------------------------------------------- */

  function acceptState(next: any): void {
    if (!next || typeof next !== 'object' || !Array.isArray(next.alerts)) return
    snapshot = { state: next as AlertState, scheme: snapshot.scheme }
    if (typeof next.revision === 'number') revision = next.revision
    if (next.config) {
      if (typeof next.config.hotkey === 'string' && next.config.hotkey.length > 0) {
        hotkeyRaw = next.config.hotkey
      }
      if (typeof next.config.panelHotkey === 'string' && next.config.panelHotkey.length > 0) {
        panelHotkeyRaw = next.config.panelHotkey
      }
      applyTokenOverride(next.config.ui)
    }
    applyPanelOpenSeq(next.panelOpenSeq)
    notify()
  }

  /*
   * Contract §13.5 entry 4: the host bumps `panelOpenSeq` every time the OS-wide
   * panel hotkey fires; a GROWTH opens the panel.
   *
   * The first state a page sees only records the counter — otherwise a reload
   * would pop the panel open for whatever the host happened to be at, and a
   * `0 > -1` comparison would reopen it on every single page load.
   */
  function applyPanelOpenSeq(value: any): void {
    try {
      if (typeof value !== 'number' || !isFinite(value)) return
      if (panelSeqSeen !== null && value > panelSeqSeen) {
        manualOpen = true
        panelHiddenFor = null
      }
      panelSeqSeen = value
    } catch (err) {
      note('panelOpenSeq intake failed', err)
    }
  }

  function pollInterval(): number {
    if (consecutiveFailures >= FAIL_THRESHOLD) return POLL_MS_DEGRADED
    return panelExpanded() ? POLL_MS_PANEL : POLL_MS
  }

  /* --------------------------------------------------------------------- *
   * Panel visibility (contract §13.4)
   *
   *   visible = manualOpen || (a not-dismissed unresolved alert exists AND that
   *             alert was not locally hidden)
   *
   * `manualOpen` is module-scoped and does NOT derive from the alert list, so
   * dismissing the alert (what the panel's 关闭 button does) can no longer make
   * the panel unopenable — the collapsed pill / the sidebar action / either
   * hotkey can always open it again.
   * --------------------------------------------------------------------- */

  var PANEL_CLOSED_KEY = '__dsa_closed__'
  var manualOpen = false
  /** The alert key the panel was locally collapsed/closed for. */
  var panelHiddenFor: string | null = null
  /** Last `panelOpenSeq` seen; null = no state received yet. */
  var panelSeqSeen: number | null = null

  function problemKey(state: AlertState | null): string {
    if (!state || !state.alerts || typeof state.alerts.length !== 'number') return PANEL_CLOSED_KEY
    for (var i = 0; i < state.alerts.length; i++) {
      var alert = state.alerts[i]
      if (alert && alert.kind === 'unresolved' && !alert.dismissed) return String(alert.id)
    }
    return PANEL_CLOSED_KEY
  }

  function hasPendingProblem(state: AlertState | null): boolean {
    return problemKey(state) !== PANEL_CLOSED_KEY
  }

  function currentPanelKey(): string {
    return problemKey(snapshot.state)
  }

  function panelExpanded(): boolean {
    try {
      if (manualOpen) return true
      var state = snapshot.state
      if (!state || !hasPendingProblem(state)) return false
      return panelHiddenFor !== currentPanelKey()
    } catch (err) {
      note('panel visibility read failed', err)
      return false
    }
  }

  /* §13.2 `show_pill`: false → no collapsed handle either (the pre-1.3 rule
     "closed means gone" comes back). Before the first poll nothing renders at
     all — the same as v1.2 — so a `show_pill: false` user never sees the handle
     flash on boot. A state that predates this key keeps the handle: losing the
     entry point is the bug being fixed. */
  function panelPillAllowed(): boolean {
    try {
      var state = snapshot.state
      if (!state) return false
      if (!state.config) return true
      return state.config.showPill !== false
    } catch (err) {
      return true
    }
  }

  function panelHidden(): boolean {
    return !panelExpanded()
  }

  /* @returns the new manualOpen value (diagnostics / smoke assertions). */
  function setManualOpen(next: boolean): boolean {
    manualOpen = next === true
    if (manualOpen) panelHiddenFor = null
    notify()
    return manualOpen
  }

  /* 收起: visual only — no dismiss, no stop-audio (contract §13.4). */
  function collapsePanel(): void {
    manualOpen = false
    panelHiddenFor = currentPanelKey()
    notify()
  }

  /*
   * The sidebar button's toggle. It flips the panel's *visibility* and keeps
   * `manualOpen` consistent with it: flipping `manualOpen` alone would look
   * dead while an unresolved alert is on screen (the alert alone already makes
   * the panel visible). Return value keeps the v1.2 meaning (hidden after the
   * toggle).
   */
  function togglePanel(): boolean {
    var next = !panelExpanded()
    manualOpen = next
    panelHiddenFor = next ? null : currentPanelKey()
    notify()
    return !next
  }

  function schedulePoll(): void {
    if (disposed) return
    try {
      if (pollTimer !== null && typeof clearTimeout === 'function') clearTimeout(pollTimer)
      if (typeof setTimeout !== 'function') return
      pollTimer = setTimeout(tick, pollInterval())
    } catch (err) {
      note('poll scheduling failed', err)
    }
  }

  function tick(): void {
    if (disposed) return
    try {
      fetchState()
        .then(function (payload: any) {
          if (disposed) return
          consecutiveFailures = 0
          try {
            acceptState(payload)
          } catch (err) {
            note('state intake failed', err)
          }
          schedulePoll()
        })
        .catch(function () {
          /* Contract §4: transport failures are swallowed silently. */
          if (disposed) return
          consecutiveFailures = consecutiveFailures + 1
          if (consecutiveFailures === FAIL_THRESHOLD) {
            note('polling degraded to ' + String(POLL_MS_DEGRADED) + 'ms after 3 failures')
          }
          schedulePoll()
        })
    } catch (err) {
      note('poll tick threw', err)
      schedulePoll()
    }
  }

  /* --------------------------------------------------------------------- *
   * Hotkey (in-app layer; the OS-wide layer belongs to the host half)
   * --------------------------------------------------------------------- */

  interface KeySpec { mods: string[]; key: string }

  function normalizeHotkey(raw: any): KeySpec | null {
    if (typeof raw !== 'string') return null
    var parts = raw.toLowerCase().split('+')
    var mods: string[] = []
    var key = ''
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i].replace(/^\s+|\s+$/g, '')
      if (!part) continue
      if (part === 'ctrl' || part === 'control') mods.push('ctrl')
      else if (part === 'alt' || part === 'option') mods.push('alt')
      else if (part === 'shift') mods.push('shift')
      else if (part === 'meta' || part === 'cmd' || part === 'command' || part === 'super' || part === 'win') mods.push('meta')
      else key = part === 'space' ? ' ' : part
    }
    if (!key) return null
    mods.sort()
    return { mods: mods, key: key }
  }

  function eventSpec(event: any): KeySpec {
    var mods: string[] = []
    if (event && event.ctrlKey) mods.push('ctrl')
    if (event && event.altKey) mods.push('alt')
    if (event && event.shiftKey) mods.push('shift')
    if (event && event.metaKey) mods.push('meta')
    var key = event && typeof event.key === 'string' ? event.key.toLowerCase() : ''
    mods.sort()
    return { mods: mods, key: key }
  }

  function sameSpec(a: KeySpec | null, b: KeySpec): boolean {
    if (!a) return false
    if (a.key !== b.key) return false
    if (a.mods.length !== b.mods.length) return false
    for (var i = 0; i < a.mods.length; i++) {
      if (a.mods[i] !== b.mods[i]) return false
    }
    return true
  }

  function onKeydown(event: any): void {
    try {
      var actual = eventSpec(event)
      if (sameSpec(normalizeHotkey(hotkeyRaw), actual)) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault()
        postControl('stop-audio')
        return
      }
      /* Contract §13.5 entry 3: the same listener also matches `panel_hotkey`
         (same normalisation rules: lowercase, `+` separated, ctrl == control)
         and toggles the panel. stop_hotkey wins if both are configured alike. */
      if (sameSpec(normalizeHotkey(panelHotkeyRaw), actual)) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault()
        togglePanel()
      }
    } catch (err) {
      note('keydown handler failed', err)
    }
  }

  function attachKeydown(): void {
    try {
      if (typeof window === 'undefined' || !window) return
      if (typeof window.addEventListener !== 'function') return
      window.addEventListener('keydown', onKeydown)
      detachKeydown = function () {
        try {
          if (typeof window.removeEventListener === 'function') window.removeEventListener('keydown', onKeydown)
        } catch (err) {
          note('keydown detach failed', err)
        }
      }
    } catch (err) {
      note('keydown attach failed', err)
    }
  }

  /* --------------------------------------------------------------------- *
   * Theme (contract §8) — colour scheme + optional token layer
   * --------------------------------------------------------------------- */

  function mediaScheme(): 'light' | 'dark' {
    try {
      if (typeof window === 'undefined' || !window) return 'light'
      if (typeof window.matchMedia !== 'function') return 'light'
      var query = window.matchMedia('(prefers-color-scheme: dark)')
      return query && query.matches ? 'dark' : 'light'
    } catch (err) {
      return 'light'
    }
  }

  function readScheme(): 'light' | 'dark' {
    try {
      var theme = currentCtx && currentCtx.theme
      if (theme && typeof theme.getTheme === 'function') {
        var current = theme.getTheme()
        var active = current && current.active
        if (active && active.colorScheme === 'dark') return 'dark'
        if (active && active.colorScheme === 'light') return 'light'
      }
    } catch (err) {
      note('theme read failed; falling back to prefers-color-scheme', err)
    }
    return mediaScheme()
  }

  function setScheme(next: 'light' | 'dark'): void {
    if (snapshot.scheme === next) return
    snapshot = { state: snapshot.state, scheme: next }
    notify()
  }

  function refreshScheme(): void {
    try {
      setScheme(readScheme())
    } catch (err) {
      note('scheme refresh failed', err)
    }
  }

  function attachTheme(ctx: any): void {
    try {
      if (ctx && typeof ctx.on === 'function') {
        var handle = ctx.on('theme/change', function () { refreshScheme() })
        if (typeof handle === 'function') {
          detachThemeChange = function () {
            try {
              handle()
            } catch (err) {
              note('theme/change detach failed', err)
            }
          }
        }
      }
    } catch (err) {
      note('theme/change subscription failed', err)
    }

    try {
      if (typeof window === 'undefined' || !window || typeof window.matchMedia !== 'function') return
      var query = window.matchMedia('(prefers-color-scheme: dark)')
      if (!query || typeof query.addEventListener !== 'function') return
      var listener = function () { refreshScheme() }
      query.addEventListener('change', listener)
      detachMedia = function () {
        try {
          if (typeof query.removeEventListener === 'function') query.removeEventListener('change', listener)
        } catch (err) {
          note('media query detach failed', err)
        }
      }
    } catch (err) {
      note('media query subscription failed', err)
    }
  }

  function shadeHex(hex: any, factor: number): string {
    try {
      if (typeof hex !== 'string') return FALLBACK_PRIMARY
      var match = /^#?([0-9a-fA-F]{6})$/.exec(hex.replace(/^\s+|\s+$/g, ''))
      if (!match) return FALLBACK_PRIMARY
      var value = parseInt(match[1], 16)
      var r = Math.round(((value >> 16) & 255) * factor)
      var g = Math.round(((value >> 8) & 255) * factor)
      var b = Math.round((value & 255) * factor)
      r = r < 0 ? 0 : r > 255 ? 255 : r
      g = g < 0 ? 0 : g > 255 ? 255 : g
      b = b < 0 ? 0 : b > 255 ? 255 : b
      var out = ((r << 16) | (g << 8) | b).toString(16)
      while (out.length < 6) out = '0' + out
      return '#' + out
    } catch (err) {
      return FALLBACK_PRIMARY
    }
  }

  /*
   * Optional enhancement (never load-bearing): alias the active theme's
   * primary/accent tokens onto this plugin's sky-blue accent. Every failure is
   * logged and leaves the rest of the plugin untouched.
   */
  function applyTokenOverride(ui: UiConfig | undefined): void {
    try {
      var theme = currentCtx && currentCtx.theme
      if (!theme || typeof theme.overrideTokens !== 'function') return
      if (typeof theme.exportInspectTokens !== 'function') return
      var directory = theme.exportInspectTokens()
      if (!Array.isArray(directory)) return

      var primary = ui && typeof ui.primaryColor === 'string' && ui.primaryColor ? ui.primaryColor : FALLBACK_PRIMARY
      var tokens: any = {}
      var count = 0
      for (var i = 0; i < directory.length && count < 16; i++) {
        var entry = directory[i]
        var name = entry && typeof entry.name === 'string' ? entry.name : ''
        if (!name) continue
        var lowered = name.toLowerCase()
        if (lowered.indexOf('primary') < 0 && lowered.indexOf('accent') < 0) continue
        tokens[name] = { light: shadeHex(primary, 1), dark: shadeHex(primary, 0.72) }
        count = count + 1
      }
      if (count === 0) return

      var disposer = theme.overrideTokens(TOKEN_SOURCE, tokens)
      if (typeof disposer === 'function') {
        extraDisposers.push(function () {
          try {
            disposer()
          } catch (err) {
            note('token override dispose failed', err)
          }
        })
      }
    } catch (err) {
      note('theme token override skipped', err)
    }
  }

  /* --------------------------------------------------------------------- *
   * Presentation
   * --------------------------------------------------------------------- */

  function useSnapshot(): Snapshot {
    var pair = React.useState(snapshot)
    React.useEffect(function () {
      var alive = true
      var listener = function (next: Snapshot) {
        if (alive) pair[1](function () { return next })
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

  /*
   * `styles.css` ships with bare-number-ish defaults in px units, so the
   * runtime override keeps the same unit and the CSS never has to convert.
   */
  function styleVars(state: AlertState | null): any {
    var ui = state && state.config ? state.config.ui : null
    var vars: any = {}
    try {
      if (!ui) return vars
      if (typeof ui.blurStrength === 'number' && isFinite(ui.blurStrength)) {
        vars['--dsa-blur'] = String(ui.blurStrength) + 'px'
      }
      if (typeof ui.primaryColor === 'string' && ui.primaryColor) {
        vars['--dsa-primary'] = ui.primaryColor
        vars['--dsa-tint'] = ui.primaryColor
        /* Keep the contract default (#E0F7FA) untouched; only a custom accent
           needs a derived gradient end. */
        if (ui.primaryColor.toLowerCase() !== FALLBACK_PRIMARY.toLowerCase()) {
          vars['--dsa-tint-soft'] = shadeHex(ui.primaryColor, 1.35)
        }
      }
      if (typeof ui.borderRadius === 'number' && isFinite(ui.borderRadius)) {
        vars['--dsa-radius'] = String(ui.borderRadius) + 'px'
      }
      if (typeof ui.opacity === 'number' && isFinite(ui.opacity)) {
        vars['--dsa-opacity'] = String(ui.opacity)
      }
    } catch (err) {
      note('css variable mapping failed', err)
    }
    return vars
  }

  function stopAudio(): void {
    postControl('stop-audio')
  }

  function testAlert(): void {
    postControl('test-alert')
  }

  function dismissAlert(alertId: string): void {
    try {
      if (!alertId) return
      postControl('dismiss', alertId)
    } catch (err) {
      note('dismiss failed', err)
    }
  }

  /*
   * Contract §11.4: the host owns the path validation (400 on a missing /
   * unknown alertId or a report-less alert); the panel only renders the button
   * when it already has a reportPath, so a 400 here is a no-op.
   */
  function openReport(alertId: string): void {
    try {
      if (!alertId) return
      postControl('open-report', alertId)
    } catch (err) {
      note('open-report failed', err)
    }
  }

  /*
   * Public read/subscribe face for the settings page (SettingsForm.tsx), which
   * cannot share this module scope. All of it is optional to its callers.
   */
  function subscribeToSnapshot(listener: any): any {
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
          note('snapshot unsubscribe failed', err)
        }
      }
    } catch (err) {
      note('snapshot subscribe failed', err)
      return null
    }
  }

  function getSnapshot(): Snapshot {
    return snapshot
  }

  function getStatus(): any {
    return {
      ok: consecutiveFailures < FAIL_THRESHOLD,
      failures: consecutiveFailures,
      revision: revision,
      state: snapshot.state,
      scheme: snapshot.scheme,
    }
  }

  /* Let the settings page hand a fresh AlertState (from a config response)
     straight to the panel instead of waiting for the next poll. */
  function pushState(next: any): void {
    try {
      acceptState(next)
    } catch (err) {
      note('state push failed', err)
    }
  }

  function makeSeat(kind: string): any {
    return function DsaSeat(): any {
      var current = useSnapshot()
      var Component = kind === 'panel' ? root.AlertPanel : root.AlertToastStack
      if (typeof Component !== 'function') return null

      var props: any = { state: current.state }
      if (kind === 'panel') {
        props.onStop = stopAudio
        props.onTest = testAlert
        props.onDismiss = dismissAlert
        props.onOpenReport = openReport
      } else {
        props.onDismiss = dismissAlert
      }

      var body = React.createElement(Component, props)
      if (!body) return null

      /* Transparent, click-through host: it carries the scheme attribute and
         the six runtime CSS variables from contract §8. */
      return React.createElement(
        'div',
        {
          className: 'dsa-root',
          'data-dsa-scheme': current.scheme,
          'data-dsa-seat': kind,
          style: styleVars(current.state),
        },
        body,
      )
    }
  }

  /*
   * Seats for the two extension slots (contract §12.7). Neither slot carries
   * plugin state, so the component receives exactly what the shell passes
   * (`{close}` for `settings.section`, `{wide}` for `sidebar.footer.action`)
   * and must stand on its own — all data reaches it through `window.__DSA__`
   * and the `/task-alerts` routes. The wrapper re-declares the six §8 CSS
   * variables as a normal in-flow box (`.dsa-inline`) because `shell.overlay`'s
   * `.dsa-root` is `position: fixed` and must never be nested in the modal.
   */
  function makeExtensionSeat(kind: string): any {
    return function DsaExtensionSeat(props: any): any {
      var current = useSnapshot()
      try {
        var Component = kind === 'settings' ? root.SettingsSection : root.SidebarAction
        if (typeof Component !== 'function') return null
        var body = React.createElement(Component, props || {})
        if (!body) return null
        return React.createElement(
          'div',
          {
            className: 'dsa-inline',
            'data-dsa-scheme': current.scheme,
            'data-dsa-seat': kind,
            style: styleVars(current.state),
          },
          body,
        )
      } catch (err) {
        note(kind + ' seat render failed', err)
        return null
      }
    }
  }

  /*
   * Can a third-party plugin open the DSH settings panel? Researched against
   * the installed client before settling for the fallback:
   *   * `sidebar.footer.action` owners receive `{ wide }` only
   *     (dsh-client-ui-sidebar/lib/types/client/contract/slots.d.ts:127-131).
   *   * `openSettings()` exists only as an owner prop of `settings.launcher`
   *     (settings .../contract/slots.d.ts:169-184, computed by the settings
   *     shell) and `openSection(id)` only on `settings.onboarding` (:159-168);
   *     a footer action gets neither.
   *   * the dialog's open/selection state is a private client store
   *     (ui-settings-general .../client/shell-store.d.ts
   *     `createSettingsShellStore`) handed as `PropsStore` to the
   *     `sidebar.settings` occupant alone — not a `ctx` service.
   *   * `ctx.layout` (ui-layout .../client/service.d.ts) exposes selectPanel /
   *     toggleSidebar / openRightbar / closeRightbar — no settings route.
   *   * `ctx.shortcuts` (dsh-client-shortcuts .../client/index.d.ts) registers
   *     commands but has no invoke-by-id.
   * So this normally returns false, which is exactly what makes the sidebar
   * button degrade to toggling this plugin's own panel. The probe stays because
   * a future DSH that grows such a handle lights the preferred path up with no
   * code change. Every read is guarded: Cordis throws on services that are not
   * declared in `inject`.
   */
  function openSettingsPanel(): boolean {
    var candidates: any[] = []
    try {
      candidates.push(currentCtx && currentCtx.settings)
    } catch (err) { /* not declared in inject */ }
    try {
      candidates.push(currentCtx && currentCtx.settingsPanel)
    } catch (err) { /* not declared in inject */ }
    try {
      var scope: any = window as any
      candidates.push(scope && scope.__DSH_SETTINGS__)
      candidates.push(scope && scope.dsh && scope.dsh.settings)
    } catch (err) { /* no window */ }

    for (var i = 0; i < candidates.length; i++) {
      var candidate = candidates[i]
      if (!candidate || typeof candidate !== 'object') continue
      try {
        if (typeof candidate.openSettings === 'function') {
          candidate.openSettings('task-alerts')
          return true
        }
        if (typeof candidate.open === 'function') {
          candidate.open('task-alerts')
          return true
        }
      } catch (err) {
        note('settings open call failed', err)
      }
    }
    return false
  }

  /* §12.7: a settings save must land on the panel immediately, not one poll later. */
  function refreshStateNow(): void {
    try {
      if (!hasFetch()) return
      fetchState()
        .then(function (payload: any) {
          try {
            consecutiveFailures = 0
            acceptState(payload)
          } catch (err) {
            note('immediate refresh intake failed', err)
          }
        })
        .catch(function (err: any) {
          note('immediate state refresh failed', err)
        })
    } catch (err) {
      note('immediate state refresh threw', err)
    }
  }

  function registerSeat(slots: any, options: any, component: any, label: string): void {
    try {
      var dispose = slots.register(options, component)
      if (typeof dispose === 'function') slotDisposers.push(dispose)
    } catch (err) {
      note(label + ' registration failed', err)
    }
  }

  /*
   * The two optional slots may not be declared yet, so they must be awaited
   * through `slots.inject`; when `inject` itself is unavailable the slot is
   * skipped with a warning (contract §12.7) rather than guessed at. Both the
   * inject call and the callback are contained here, so a throw from an
   * optional slot can never disturb the registrations above it.
   */
  function registerOptionalSlot(slots: any, key: string, register: any): void {
    if (typeof slots.inject !== 'function') {
      note('slots.inject unavailable; slot "' + key + '" skipped (contract §12.7)')
      return
    }
    try {
      slots.inject(key, function () {
        try {
          register()
        } catch (err) {
          note('slot "' + key + '" callback failed', err)
        }
      })
    } catch (err) {
      note('slots.inject("' + key + '") failed; slot skipped', err)
    }
  }

  function registerSlots(): void {
    try {
      var slots = currentCtx && currentCtx.slots
      if (!slots || typeof slots.register !== 'function') {
        note('slots service unavailable; UI stays unmounted')
        return
      }

      /* `shell.overlay` first and unconditionally: contract §12.7 forbids the
         two optional slots from taking the panel and the toast down with them. */
      var overlayInjected = false
      var registerOverlaySeats = function () {
        try {
          registerSeat(slots, { name: 'shell.overlay', id: 'task-alerts.toast', order: 900 }, makeSeat('toast'), 'toast')
          registerSeat(slots, { name: 'shell.overlay', id: 'task-alerts.panel', order: 950 }, makeSeat('panel'), 'panel')
        } catch (err) {
          note('overlay seat registration failed', err)
        }
      }

      if (typeof slots.inject === 'function') {
        try {
          slots.inject('shell.overlay', registerOverlaySeats)
          overlayInjected = true
        } catch (err) {
          note('slots.inject failed; registering directly', err)
        }
      }
      if (!overlayInjected) registerOverlaySeats()

      registerOptionalSlot(slots, 'settings.section', function () {
        if (typeof root.SettingsSection !== 'function') {
          note('settings.section: SettingsSection missing from this bundle; section not registered')
          return
        }
        registerSeat(
          slots,
          { name: 'settings.section', id: 'task-alerts', order: 500, label: '任务提醒' },
          makeExtensionSeat('settings'),
          'settings.section',
        )
      })

      registerOptionalSlot(slots, 'sidebar.footer.action', function () {
        if (typeof root.SidebarAction !== 'function') {
          note('sidebar.footer.action: SidebarAction missing from this bundle; button not registered')
          return
        }
        registerSeat(
          slots,
          { name: 'sidebar.footer.action', id: 'task-alerts.settings', order: 400 },
          makeExtensionSeat('sidebar'),
          'sidebar.footer.action',
        )
      })
    } catch (err) {
      note('slots setup failed', err)
    }
  }

  /* --------------------------------------------------------------------- *
   * Lifecycle
   * --------------------------------------------------------------------- */

  function dispose(): void {
    if (disposed) return
    disposed = true

    try {
      if (pollTimer !== null && typeof clearTimeout === 'function') clearTimeout(pollTimer)
    } catch (err) { /* ignore */ }
    pollTimer = null

    var detachers = [detachKeydown, detachThemeChange, detachMedia]
    detachKeydown = null
    detachThemeChange = null
    detachMedia = null
    for (var i = 0; i < detachers.length; i++) {
      try {
        if (typeof detachers[i] === 'function') detachers[i]()
      } catch (err) {
        note('detach failed', err)
      }
    }

    var disposers = slotDisposers.concat(extraDisposers)
    slotDisposers = []
    extraDisposers = []
    for (var j = 0; j < disposers.length; j++) {
      try {
        if (typeof disposers[j] === 'function') disposers[j]()
      } catch (err) {
        note('disposer failed', err)
      }
    }

    listeners = []
    removeStyle()
  }

  var disposeRef: any = null

  root.dispose = dispose
  root.stopAudio = stopAudio
  root.testAlert = testAlert
  root.dismissAlert = dismissAlert
  root.openReport = openReport
  root.pollInterval = pollInterval
  /*
   * Panel visibility face (contract §13.4). AlertPanel.tsx renders from these
   * and SettingsForm.tsx's sidebar action toggles through `togglePanel`, so the
   * one authoritative copy of `manualOpen` lives here.
   */
  root.panelExpanded = panelExpanded
  root.panelHidden = panelHidden
  root.panelPillAllowed = panelPillAllowed
  root.togglePanel = togglePanel
  root.setManualOpen = setManualOpen
  root.collapsePanel = collapsePanel
  root.manualOpen = function (): boolean {
    return manualOpen
  }
  root.panelKeys = function (): any {
    /* Diagnostics only: which alert key the local hide is bound to. */
    return { hiddenFor: panelHiddenFor, current: currentPanelKey(), seqSeen: panelSeqSeen }
  }
  /* Read/subscribe face consumed by SettingsForm.tsx (contract §12.7). */
  root.subscribe = subscribeToSnapshot
  root.getSnapshot = getSnapshot
  root.getStatus = getStatus
  root.styleVars = styleVars
  root.pushState = pushState
  root.refreshState = refreshStateNow
  root.openSettingsPanel = openSettingsPanel

  function apply(ctx: any): void {
    try {
      if (disposeRef !== null) {
        try {
          disposeRef()
        } catch (err) {
          note('previous instance dispose failed', err)
        }
      }
      disposed = false
      disposeRef = dispose
      currentCtx = ctx

      injectStyle()
      snapshot = { state: snapshot.state, scheme: readScheme() }
      attachKeydown()
      attachTheme(ctx)
      registerSlots()
      schedulePoll()
    } catch (err) {
      note('apply failed', err)
      return
    }

    try {
      if (ctx && typeof ctx.effect === 'function') {
        ctx.effect(function () {
          return function () { dispose() }
        })
        return
      }
    } catch (err) {
      note('ctx.effect unavailable; using fallback teardown', err)
    }

    try {
      if (ctx && typeof ctx.on === 'function') {
        ctx.on('dispose', function () { dispose() })
        return
      }
    } catch (err) {
      note('ctx.on(dispose) unavailable', err)
    }
    note('no teardown hook available; resources are released on reload')
  }

  root.apply = apply
})()
