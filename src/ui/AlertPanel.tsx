/* =============================================================================
 * dsh-task-alerts — browser half: glass panel + toast stack.
 *
 * Concatenated as a plain script (contract §7): no import/export, all globals
 * come from the declared block below, and the two components are published on
 * the `window.__DSA__` namespace so `client.ts` can reach them without the two
 * files sharing module scope.
 *
 * Every value coming from the host (state/alerts/config) is treated as
 * untrusted: the host half may be an older build, and a malformed payload must
 * degrade to an empty panel rather than throw inside the React tree.
 *
 * Contract §13.4: the panel seat renders TWO mutually exclusive forms — the
 * expanded glass card and a collapsed pill ("把手") that is always on screen
 * unless `show_pill: false`. The collapsed form is what makes a closed panel
 * reopenable; the visibility store itself lives in `client.ts`.
 * ========================================================================== */

/*
 * Contract §7 asks for the four-global block (`React`/`window`/`require`/
 * `document`). Under tsconfig.client.json the program includes `lib.dom`, which
 * already declares `window` and `document`; re-declaring them as `any` is a hard
 * TS2451/TS2403 in a global script file, so only the two names the DOM library
 * does not own are declared here. `window` is reached through `window as any`
 * and `document` is used with its DOM types (only `.head`/`.createElement`/
 * `.querySelector` are touched). See the delivery notes for the rationale.
 */
declare var React: any
declare function require(mod: string): any

declare namespace JSX {
  interface Element { }
  interface ElementClass { }
  interface IntrinsicElements { [elemName: string]: any }
}

;(function () {
  var root: any = ((window as any).__DSA__ = (window as any).__DSA__ || {})

  /* --------------------------------------------------------------------- *
   * Local contract types (contract §3 — duplicated on purpose; the two
   * halves never import each other).
   * --------------------------------------------------------------------- */

  interface UiConfig {
    blurStrength?: number
    primaryColor?: string
    borderRadius?: number
    opacity?: number
  }

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

  interface AlertState {
    revision?: number
    generatedAt?: string
    config?: {
      ui?: UiConfig
      maxAttempts?: number
      reportDir?: string
      /* contract §11.1 */
      repeatInterval?: number
      repeatMax?: number
      reportAutoOpen?: string
    }
    stats?: { problems?: number; unresolved?: number; alerts?: number }
    audioPlaying?: boolean
    /* contract §11.2 */
    repeatActive?: boolean
    repeatCount?: number
    alerts?: AlertRecord[]
  }

  interface PanelProps {
    state: AlertState | null
    onStop: () => void
    onDismiss: (alertId: string) => void
    onTest: () => void
    onOpenReport: (alertId: string) => void
  }

  interface ToastProps {
    state: AlertState | null
    onDismiss: (alertId: string) => void
  }

  /* --------------------------------------------------------------------- *
   * Helpers
   * --------------------------------------------------------------------- */

  var TOAST_MS = 6000

  function alertsOf(state: AlertState | null): AlertRecord[] {
    if (!state || !state.alerts || typeof state.alerts.length !== 'number') return []
    var out: AlertRecord[] = []
    for (var i = 0; i < state.alerts.length; i++) {
      var item = state.alerts[i]
      if (item && typeof item === 'object') out.push(item)
    }
    return out
  }

  function newestFinish(state: AlertState | null): AlertRecord | null {
    var list = alertsOf(state)
    for (var i = 0; i < list.length; i++) {
      if (list[i].kind === 'finish' && !list[i].dismissed) return list[i]
    }
    return null
  }

  function currentProblem(state: AlertState | null): AlertRecord | null {
    var list = alertsOf(state)
    for (var i = 0; i < list.length; i++) {
      if (list[i].kind === 'unresolved' && !list[i].dismissed) return list[i]
    }
    return null
  }

  function text(value: any, fallback: string): string {
    if (value === null || value === undefined) return fallback
    var s = String(value)
    return s.length > 0 ? s : fallback
  }

  function count(value: any): string {
    return value === null || value === undefined ? '0' : String(value)
  }

  function relativeTime(iso: any): string {
    if (typeof iso !== 'string' || iso.length === 0) return ''
    var t = Date.parse(iso)
    if (isNaN(t)) return ''
    var delta = Date.now() - t
    if (delta < 0) delta = 0
    var sec = Math.round(delta / 1000)
    if (sec < 60) return sec + 's'
    var min = Math.round(sec / 60)
    if (min < 60) return min + 'm'
    return Math.round(min / 60) + 'h'
  }

  function levelClass(level: any): string {
    if (level === 'error') return 'dsa-badge dsa-badge--error'
    if (level === 'success') return 'dsa-badge dsa-badge--success'
    return 'dsa-badge'
  }

  function kindLabel(kind: any): string {
    return kind === 'finish' ? '完成' : '未解决'
  }

  /* Clipboard access is optional and must never break the panel. */
  function copyText(value: string): void {
    try {
      if (typeof navigator === 'undefined' || !navigator) return
      var clip = (navigator as any).clipboard
      if (clip && typeof clip.writeText === 'function') clip.writeText(value)
    } catch (err) {
      /* swallow: no clipboard permission, no clipboard API, no problem */
    }
  }

  /* --------------------------------------------------------------------- *
   * Panel visibility — the authoritative store lives in `client.ts` (contract
   * §13.4), because `manualOpen` must survive the alert being dismissed and
   * three other surfaces (sidebar action, pill, both hotkeys) mutate it.
   *
   * `client.ts` is concatenated AFTER this file, but only its *definitions* run
   * at load time while these accessors are called during render, so
   * `window.__DSA__` always carries them by then. The fallback below keeps the
   * panel usable if this file were ever bundled alone.
   * --------------------------------------------------------------------- */

  function panelExpandedFallback(state: AlertState | null): boolean {
    return !!state && currentProblem(state) !== null
  }

  function panelExpanded(state: AlertState | null): boolean {
    try {
      if (typeof root.panelExpanded === 'function') return root.panelExpanded() === true
    } catch (err) {
      /* swallow: fall through to the local rule */
    }
    return panelExpandedFallback(state)
  }

  function pillAllowed(): boolean {
    try {
      if (typeof root.panelPillAllowed === 'function') return root.panelPillAllowed() !== false
    } catch (err) {
      /* swallow: keep the entry point */
    }
    return true
  }

  function expandPanel(): void {
    try {
      if (typeof root.setManualOpen === 'function') root.setManualOpen(true)
    } catch (err) {
      /* swallow: a failed expand must not break the tree */
    }
  }

  /* 收起 = visual only. It is also what "关闭" ends with, after the dismiss
     (§13.4: 关闭 = dismiss + manualOpen = false; 收起 = 只收起). */
  function collapsePanel(): void {
    try {
      if (typeof root.collapsePanel === 'function') root.collapsePanel()
    } catch (err) {
      /* swallow */
    }
  }

  /* --------------------------------------------------------------------- *
   * Toast stack — newest non-dismissed `finish` alert, auto-hidden after 6s.
   *
   * §12.6: only a `finish` toast may disappear on its own. An `unresolved`
   * alert never reaches this component (`newestFinish` skips it), so it can
   * neither auto-hide here nor be auto-dismissed anywhere in the browser half.
   * --------------------------------------------------------------------- */

  function AlertToastStack(props: ToastProps): any {
    var alert = newestFinish(props.state)
    var id = alert ? String(alert.id) : null

    var pair = React.useState(null)
    var dismissedId = pair[0]
    var setDismissedId = pair[1]

    var dismissRef = React.useRef(null)
    dismissRef.current = props.onDismiss

    // A different alert resets the local dismissal.
    React.useEffect(function () {
      setDismissedId(null)
    }, [id])

    // Auto-hide the current toast — VISUAL ONLY, and never while the ring is on.
    //
    // This timer used to also call onDismiss(), which POSTs `dismiss` and the host
    // stops the ring loop on ANY dismiss. That made a 6-second UI timer silently
    // kill the "ring until closed" loop: the sound played once and the loop died at
    // 6s with repeatCount still 0 — measured live (repeatActive=true at +5s,
    // false at +10s, count 0). A timer is not a user action, so per §12.6 it must
    // not stop the ring. The × button still dismisses: that IS a user action.
    //
    // Second half: while the ring is still going, this toast must STAY — it is the
    // only on-screen control that can stop the sound. Hiding it would leave an
    // unstoppable ring with nothing to click.
    var ringing = !!(props.state && props.state.repeatActive === true)
    React.useEffect(function () {
      if (!id) return undefined
      if (ringing) return undefined
      if (typeof setTimeout !== 'function') return undefined
      var handle = setTimeout(function () {
        try {
          setDismissedId(id)
        } catch (err) { /* swallow: a failed local hide must not break the tree */ }
      }, TOAST_MS)
      return function () {
        if (typeof clearTimeout === 'function') clearTimeout(handle)
      }
    }, [id, ringing])

    if (!alert || !id || dismissedId === id) return null
    var activeId: string = id

    var close = function () {
      setDismissedId(activeId)
      try {
        if (typeof props.onDismiss === 'function') props.onDismiss(activeId)
      } catch (err) { /* swallow */ }
    }

    return React.createElement(
      'div',
      { className: 'dsa-toast-stack', 'data-dsa-toast-stack': 'true' },
      React.createElement(
        'div',
        {
          className: 'dsa-toast',
          role: 'status',
          'aria-live': 'polite',
          'data-alert-id': activeId,
        },
        React.createElement(
          'div',
          { className: 'dsa-toast-body' },
          React.createElement('div', { className: 'dsa-toast-title' }, text(alert.title, '提醒')),
          alert.message
            ? React.createElement('div', { className: 'dsa-toast-msg' }, String(alert.message))
            : null,
        ),
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'dsa-icon-btn',
            'aria-label': '关闭',
            title: '关闭',
            onClick: close,
          },
          '×',
        ),
      ),
    )
  }

  /* --------------------------------------------------------------------- *
   * Panel — bottom-right glass card.
   * --------------------------------------------------------------------- */

  function AlertPanel(props: PanelProps): any {
    var state = props.state
    var alert = currentProblem(state)

    /* Contract §13.4: ONE seat, two mutually exclusive forms. The collapsed
       form is always available (unless `show_pill: false`), which is the
       mechanism that makes a closed panel reopenable. */
    if (!panelExpanded(state)) return pillAllowed() ? AlertPill(props) : null
    /* Reachable only through the bundled-alone fallback (a null state still
       renders the pill above); it exists so the body below can narrow `state`. */
    if (!state || typeof state !== 'object') return null

    var guard = function (fn: any) {
      return function () {
        try {
          if (typeof fn === 'function') fn()
        } catch (err) { /* swallow: control calls never escape the tree */ }
      }
    }

    var dismissOf = function (alertId: string) {
      return function () {
        try {
          if (typeof props.onDismiss === 'function') props.onDismiss(alertId)
        } catch (err) { /* swallow */ }
      }
    }

    var openReportOf = function (alertId: string) {
      return function () {
        try {
          if (typeof props.onOpenReport === 'function') props.onOpenReport(alertId)
        } catch (err) { /* swallow */ }
      }
    }

    /*
     * Contract §11.6 + §13.4: "关闭" dismisses (the host stops the ring on any
     * dismiss) AND clears `manualOpen`, so it is not the same gesture as "收起"
     * below — 收起 is visual only and never dismisses nor stops the sound.
     */
    var closePanel = function () {
      var id = alert ? String(alert.id) : ''
      if (id) {
        try {
          if (typeof props.onDismiss === 'function') props.onDismiss(id)
        } catch (err) { /* swallow: a failed dismiss still hides the panel */ }
      }
      collapsePanel()
    }

    var list = alertsOf(state).slice(0, 5)
    var stats = state.stats || {}
    var maxAttempts = alert && alert.maxAttempts !== undefined
      ? alert.maxAttempts
      : (state.config ? state.config.maxAttempts : undefined)
    var reportPath = alert && alert.reportPath ? String(alert.reportPath) : ''
    var reportAlertId = alert ? String(alert.id) : ''
    var playing = state.audioPlaying === true
    var ringing = state.repeatActive === true
    var repeatSeconds = state.config && typeof state.config.repeatInterval === 'number' && isFinite(state.config.repeatInterval)
      ? state.config.repeatInterval
      : 0
    var stopClass = ringing ? 'dsa-btn dsa-btn--primary dsa-btn--ring' : 'dsa-btn dsa-btn--primary'
    var children: any[] = []

    children.push(
      React.createElement(
        'div',
        { className: 'dsa-header', key: 'header' },
        React.createElement('h2', { className: 'dsa-title' }, '任务提醒'),
        playing
          ? React.createElement('span', { className: 'dsa-badge dsa-badge--live' }, '音效播放中')
          : null,
        ringing
          ? React.createElement(
              'span',
              { className: 'dsa-badge dsa-badge--live' },
              React.createElement('span', { className: 'dsa-ring', 'aria-hidden': 'true' }),
              '重复提醒中',
            )
          : null,
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'dsa-icon-btn',
            'aria-label': '关闭',
            title: '关闭',
            onClick: closePanel,
          },
          '×',
        ),
      ),
    )

    if (ringing) {
      children.push(
        React.createElement(
          'div',
          { className: 'dsa-ring-row', key: 'ring', 'data-dsa-ring': 'true', role: 'status' },
          React.createElement('span', { className: 'dsa-ring', 'aria-hidden': 'true' }),
          React.createElement(
            'span',
            null,
            '重复提醒中 · 第 ' + count(state.repeatCount) + ' 次 · 每 ' + count(repeatSeconds) + ' 秒',
          ),
        ),
      )
    }

    children.push(
      React.createElement(
        'div',
        { className: 'dsa-meta', key: 'stats' },
        React.createElement('span', null, '问题 ' + count(stats.problems)),
        React.createElement('span', null, '未解决 ' + count(stats.unresolved)),
        React.createElement('span', null, '提醒 ' + count(stats.alerts)),
        maxAttempts === undefined
          ? null
          : React.createElement('span', null, '上限 ' + String(maxAttempts) + ' 次'),
      ),
    )

    if (alert) {
      children.push(
        React.createElement(
          'div',
          { className: 'dsa-card', key: 'current', 'data-dsa-current': String(alert.id) },
          React.createElement('div', { className: 'dsa-card-title' }, text(alert.title, '未解决的问题')),
          React.createElement(
            'div',
            { className: 'dsa-meta' },
            alert.problemId
              ? React.createElement(
                  'span',
                  { className: 'dsa-badge' },
                  'problemId ' + String(alert.problemId),
                )
              : null,
            React.createElement(
              'span',
              { className: 'dsa-badge' },
              'attempts ' + count(alert.attempts) +
                (maxAttempts === undefined ? '' : '/' + String(maxAttempts)),
            ),
          ),
          alert.message
            ? React.createElement('div', { className: 'dsa-card-msg' }, String(alert.message))
            : null,
        ),
      )
    } else {
      /* Contract §13.4/§13.8: the expanded form still renders when there is
         nothing pending — that is the regression this release fixes ("关了之后
         还能再打开"), so the copy must be explicit about what is shown below. */
      children.push(
        React.createElement(
          'div',
          { className: 'dsa-sub dsa-empty', key: 'nominal' },
          list.length > 0 ? '当前没有待处理提醒，以下是最近提醒' : '当前没有待处理提醒。',
        ),
      )
    }

    if (reportPath) {
      children.push(
        React.createElement(
          'div',
          { className: 'dsa-path', key: 'report' },
          React.createElement('span', { className: 'dsa-sub' }, '报告'),
          React.createElement('code', { title: reportPath }, reportPath),
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'dsa-btn',
              onClick: function () { copyText(reportPath) },
            },
            '复制',
          ),
          /* Contract §11.6: only a state whose current alert carries a reportPath
             renders this button. */
          reportAlertId
            ? React.createElement(
                'button',
                {
                  type: 'button',
                  className: 'dsa-btn',
                  title: reportPath,
                  'data-dsa-open-report': reportAlertId,
                  onClick: openReportOf(reportAlertId),
                },
                '打开报告',
              )
            : null,
        ),
      )
    }

    if (list.length > 0) {
      var rows: any[] = []
      for (var i = 0; i < list.length; i++) {
        var item = list[i]
        var rowChildren: any[] = []
        rowChildren.push(
          React.createElement(
            'div',
            { className: 'dsa-row-main', key: 'main' },
            React.createElement('span', { className: levelClass(item.level) }, kindLabel(item.kind)),
            React.createElement('span', null, text(item.title, '(无标题)')),
            item.dismissed
              ? React.createElement('span', { className: 'dsa-badge' }, '已忽略')
              : null,
          ),
        )
        var sub = text(item.message, '')
        var when = relativeTime(item.createdAt)
        if (sub || when) {
          rowChildren.push(
            React.createElement(
              'div',
              { className: 'dsa-row-sub', key: 'sub' },
              sub + (when ? (sub ? ' · ' : '') + when : ''),
            ),
          )
        }
        if (!item.dismissed) {
          rowChildren.push(
            React.createElement(
              'button',
              {
                type: 'button',
                className: 'dsa-btn',
                key: 'dismiss',
                onClick: dismissOf(String(item.id)),
              },
              '忽略',
            ),
          )
        }
        rows.push(
          React.createElement(
            'li',
            { className: 'dsa-row', key: String(item.id), 'data-alert-id': String(item.id) },
            rowChildren,
          ),
        )
      }
      children.push(
        React.createElement('div', { className: 'dsa-sub', key: 'recent-label' }, '最近提醒'),
        React.createElement('ul', { className: 'dsa-list', key: 'recent' }, rows),
      )
    }

    children.push(
      React.createElement(
        'div',
        { className: 'dsa-actions', key: 'actions' },
        React.createElement(
          'button',
          {
            type: 'button',
            className: stopClass,
            'data-dsa-stop': ringing ? 'boost' : 'normal',
            onClick: guard(props.onStop),
          },
          ringing ? '停止重复提醒' : '停止音效',
        ),
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'dsa-btn',
            onClick: guard(props.onTest),
          },
          '测试提醒',
        ),
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'dsa-btn',
            'data-dsa-action': 'collapse',
            title: '只收起面板：不忽略提醒，也不停响',
            onClick: guard(collapsePanel),
          },
          '收起',
        ),
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'dsa-btn',
            onClick: closePanel,
          },
          '关闭',
        ),
      ),
    )

    return React.createElement(
      'div',
      { className: 'dsa-panel', role: 'complementary', 'data-dsa-panel': 'true' },
      children,
    )
  }

  /* --------------------------------------------------------------------- *
   * Collapsed form — the permanent entry point (contract §13.4).
   *
   * It occupies the same bottom-right corner as the expanded panel, but the two
   * forms come out of the SAME seat and are mutually exclusive, so they can
   * never overlap or fight over z-order. `pointer-events: auto` on the pill
   * itself is required because `shell.overlay` is click-through.
   * --------------------------------------------------------------------- */

  function AlertPill(props: PanelProps): any {
    var state = props.state
    var ringing = !!(state && state.repeatActive === true)
    var pending = currentProblem(state) !== null
    var mode = ringing ? 'ring' : pending ? 'pending' : 'idle'
    var status = ringing ? '响铃中' : pending ? '有待处理提醒' : '空闲'

    var onExpand = function () {
      try {
        expandPanel()
      } catch (err) { /* swallow: a failed expand must not break the tree */ }
    }

    /* role="button" is not enough on its own: Enter/Space must work too. */
    var onKeyDown = function (event: any) {
      try {
        var key = event && typeof event.key === 'string' ? event.key : ''
        if (key !== 'Enter' && key !== ' ' && key !== 'Spacebar') return
        if (typeof event.preventDefault === 'function') event.preventDefault()
        expandPanel()
      } catch (err) { /* swallow */ }
    }

    return React.createElement(
      'div',
      {
        className: 'dsa-pill dsa-pill--' + mode,
        'data-dsa-pill': mode,
        role: 'button',
        tabIndex: 0,
        'aria-label': '任务提醒（已收起 · ' + status + '），点击展开',
        title: '展开任务提醒面板',
        onClick: onExpand,
        onKeyDown: onKeyDown,
      },
      React.createElement('span', { className: 'dsa-pill-badge', 'aria-hidden': 'true' }),
      React.createElement('span', { className: 'dsa-pill-text' }, '任务提醒 · ' + status),
      React.createElement(
        'button',
        {
          type: 'button',
          className: 'dsa-pill-expand',
          'data-dsa-action': 'expand',
          onClick: onExpand,
        },
        '展开',
      ),
    )
  }

  root.AlertPanel = AlertPanel
  root.AlertToastStack = AlertToastStack
  root.AlertPill = AlertPill
})()
