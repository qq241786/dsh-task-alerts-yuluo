/**
 * dsh-task-alerts —— 「交给系统默认处理器打开」的打开器（CONTRACT §11.4 / §11.5）。
 *
 * 关键决策：
 *  1. **可注入**：真正的进程启动只发生在 `OpenRunner` 里，缺省 runner 是 detached
 *     spawn。冒烟测试注入一个只记录调用的 runner，因此**不会真的弹出窗口/浏览器**。
 *     注入点签名是 `(path, mode, command, args) => 是否成功发起`。
 *  2. `plan()` 是纯函数：平台 → (命令, 参数, 目标) 的映射集中在一处，测试可以只断言
 *     计划而不启动任何进程。
 *  3. 平台分支严格照契约：win32 `cmd /c start "" "<path>"`（folder 用
 *     `explorer /select,"<path>"`）、darwin `open`（folder 用 `open -R`）、
 *     其余按 linux 走 `xdg-open`。
 *  4. 任何失败（未知/不支持的平台、spawn 抛错、runner 抛错、返回非 true）都只记日志
 *     并返回 false，绝不 throw（CONTRACT §9）。
 */

import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { OpenPlan, OpenRunner, OpenerOptions, PluginLogger, ReportAutoOpen } from './types.js'

/** 缺省 runner：detached / stdio ignore / 不等待 / 不抛；失败只记日志。 */
export function spawnDetached(command: string, args: string[], log: PluginLogger): boolean {
  try {
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true, detached: true })
    child.on('error', (error) => {
      try {
        log.warn(`打开命令失败（${command}）：${error.message}`)
      } catch {
        /* 记日志都不行就放弃 */
      }
    })
    const unref = (child as { unref?: unknown }).unref
    if (typeof unref === 'function') (unref as () => void).call(child)
    return true
  } catch (error) {
    log.warn(`启动打开命令失败（${command}）：${describeError(error)}`)
    return false
  }
}

function describeError(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

export class Opener {
  private readonly log: PluginLogger
  private readonly runner: OpenRunner
  private readonly platform: string

  constructor(options: OpenerOptions) {
    this.log = options.log
    this.platform = options.platform ?? process.platform
    const log = this.log
    this.runner =
      options.runner ?? ((_path, _mode, command, args) => spawnDetached(command, args, log))
  }

  /**
   * 纯函数：把「模式 + 报告路径」翻译成一次打开计划。
   * `mode === 'none'` 或路径为空 → null（调用方据此什么都不做）。
   */
  plan(mode: ReportAutoOpen, filePath: string): OpenPlan | null {
    try {
      const target = typeof filePath === 'string' ? filePath.trim() : ''
      if (mode === 'none' || target.length === 0) return null

      if (mode === 'folder') {
        const dir = dirname(target)
        if (this.platform === 'win32') {
          return { mode: 'folder', path: dir, command: 'explorer', args: [`/select,"${target}"`] }
        }
        if (this.platform === 'darwin') {
          return { mode: 'folder', path: dir, command: 'open', args: ['-R', target] }
        }
        return { mode: 'folder', path: dir, command: 'xdg-open', args: [dir] }
      }

      if (mode === 'browser') {
        const url = pathToFileURL(target).href
        if (this.platform === 'win32') {
          return { mode: 'url', path: url, command: 'cmd', args: ['/c', 'start', '', url] }
        }
        if (this.platform === 'darwin') {
          return { mode: 'url', path: url, command: 'open', args: [url] }
        }
        return { mode: 'url', path: url, command: 'xdg-open', args: [url] }
      }

      if (this.platform === 'win32') {
        return { mode: 'file', path: target, command: 'cmd', args: ['/c', 'start', '', target] }
      }
      if (this.platform === 'darwin') {
        return { mode: 'file', path: target, command: 'open', args: [target] }
      }
      return { mode: 'file', path: target, command: 'xdg-open', args: [target] }
    } catch (error) {
      this.log.warn(`生成打开计划失败：${describeError(error)}`)
      return null
    }
  }

  /** 执行一个计划；runner 抛错或返回非 `true` 都算失败。 */
  run(plan: OpenPlan): boolean {
    try {
      const opened = this.runner(plan.path, plan.mode, plan.command, plan.args) === true
      if (!opened) this.log.warn(`打开失败（${plan.mode}）：${plan.path}`)
      return opened
    } catch (error) {
      this.log.warn(`打开 ${plan.mode} 时异常（${plan.path}）：${describeError(error)}`)
      return false
    }
  }

  /** CONTRACT §11.5 入口：按配置的 `report_auto_open` 打开报告。 */
  openAuto(mode: ReportAutoOpen, filePath: string): boolean {
    const plan = this.plan(mode, filePath)
    if (plan === null) return false
    return this.run(plan)
  }

  /** CONTRACT §11.4：用系统默认程序打开报告文件。 */
  openReportFile(filePath: string): boolean {
    return this.openAuto('file', filePath)
  }
}
