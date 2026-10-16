/**
 * dsh-task-alerts —— 未解决问题报告生成（CONTRACT §9 去重条款）。
 *
 * 职责：把一个 `problemId` 的逐次尝试写成一份固定格式的 TXT，并保证同一 id 只写一次。
 *
 * 关键决策：
 *  1. 去重是**双层**的：内存 `Set`（进程内快路径）+ `<report_dir>/.reported.json`
 *     落盘（重启后仍然去重）。落盘集合懒加载——首次真正要写报告时才读，避免给
 *     apply() 增加 IO；读取失败按「空集合」处理并记日志。
 *  2. 原子写：先写 `<name>.tmp-<pid>`，再 `rename`；`.reported.json` 同理。
 *     崩溃只会留下临时文件，不会留下半截报告。
 *  3. 目录递归创建；任何 IO 失败都返回 null + 日志，**绝不 throw**（CONTRACT §9）。
 *  4. 文件名 `<yyyyMMdd-HHmmss>-<sanitized problemId>.txt`，problemId 清洗为
 *     `[A-Za-z0-9._-]`；重名时追加 `-2`、`-3` 直到不冲突，确保旧报告不被覆盖。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { AttemptRecord, PluginLogger, ProblemReport } from './types.js'

const REPORTED_FILE = '.reported.json'
const MAX_REPORTED_ENTRIES = 5000

export interface ReporterOptions {
  reportDir: string
  log: PluginLogger
}

export interface PreparedAttempt {
  problemId: string
  description: string
  at: string
  thought?: string
  error?: string
  source?: string
}

export class Reporter {
  private readonly reportDir: string
  private readonly log: PluginLogger
  private readonly reported = new Set<string>()
  private loaded = false
  private loadedFrom: string | null = null

  constructor(options: ReporterOptions) {
    this.reportDir = resolve(options.reportDir)
    this.log = options.log
  }

  get directory(): string {
    return this.reportDir
  }

  /** 该 problemId 是否已经生成过报告（含落盘历史）。 */
  isReported(problemId: string): boolean {
    const key = sanitizeProblemId(problemId)
    if (key.length === 0) return false
    this.ensureLoaded()
    return this.reported.has(key)
  }

  /**
   * 校验并规范化一次尝试输入。完全不抛错：非法输入被替换成安全默认值。
   */
  prepareAttempt(input: {
    problemId?: unknown
    description?: unknown
    thought?: unknown
    error?: unknown
    source?: unknown
    at?: unknown
  }): PreparedAttempt {
    const problemId = typeof input.problemId === 'string' && input.problemId.trim().length > 0
      ? input.problemId.trim()
      : 'unknown-problem'
    const at = typeof input.at === 'string' && Number.isFinite(Date.parse(input.at))
      ? input.at
      : new Date().toISOString()
    const prepared: PreparedAttempt = {
      problemId,
      description: asOptionalText(input.description) ?? '(未提供问题描述)',
      at,
    }
    const thought = asOptionalText(input.thought)
    const errorText = asOptionalText(input.error)
    const source = asOptionalText(input.source)
    if (thought !== undefined) prepared.thought = thought
    if (errorText !== undefined) prepared.error = errorText
    if (source !== undefined) prepared.source = source
    return prepared
  }

  /**
   * 写报告。已报告过则返回 `{ path: null, alreadyReported: true }`。
   *
   * @param report - 完整报告载荷。
   * @returns 绝对路径；失败或已存在时为 null。
   */
  writeReport(report: ProblemReport): { path: string | null; alreadyReported: boolean } {
    const key = sanitizeProblemId(report.problemId)
    this.ensureLoaded()
    if (key.length > 0 && this.reported.has(key)) return { path: null, alreadyReported: true }

    try {
      mkdirSync(this.reportDir, { recursive: true })
    } catch (error) {
      this.log.error(`创建报告目录失败：${this.reportDir}`, error)
      return { path: null, alreadyReported: false }
    }

    const target = this.uniquePath(key)
    const temp = `${target}.tmp-${process.pid}`
    try {
      writeFileSync(temp, renderReport(report), 'utf8')
      renameSync(temp, target)
    } catch (error) {
      this.log.error(`写入报告失败：${target}`, error)
      try {
        if (existsSync(temp)) unlinkSync(temp)
      } catch {
        /* 清理临时文件失败无关紧要 */
      }
      return { path: null, alreadyReported: false }
    }

    this.markReported(key)
    this.log.info(`已生成问题报告：${target}`)
    return { path: target, alreadyReported: false }
  }

  /** 把 problemId 记入内存 + 落盘去重集合。 */
  markReported(problemId: string): void {
    const key = sanitizeProblemId(problemId)
    if (key.length === 0) return
    this.ensureLoaded()
    this.reported.add(key)
    this.persistReported()
  }

  // ---------- 去重集合落盘 ----------

  private get reportedFilePath(): string {
    return join(this.reportDir, REPORTED_FILE)
  }

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    const path = this.reportedFilePath
    let text: string | null = null
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      // 首次运行：文件不存在，属于正常路径，不记日志。
      return
    }
    try {
      const parsed: unknown = JSON.parse(text)
      const list = Array.isArray(parsed)
        ? parsed
        : parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { reported?: unknown }).reported)
          ? ((parsed as { reported: unknown[] }).reported)
          : []
      for (const entry of list) {
        if (typeof entry === 'string' && entry.length > 0) this.reported.add(entry)
      }
      this.loadedFrom = path
    } catch (error) {
      this.log.warn(`报告去重索引损坏（已按空集合处理）：${path} —— ${describe(error)}`)
    }
  }

  private persistReported(): void {
    const path = this.reportedFilePath
    const entries = [...this.reported].slice(-MAX_REPORTED_ENTRIES)
    const temp = `${path}.tmp-${process.pid}`
    try {
      mkdirSync(this.reportDir, { recursive: true })
      writeFileSync(temp, `${JSON.stringify({ reported: entries }, null, 2)}\n`, 'utf8')
      renameSync(temp, path)
      this.loadedFrom = path
    } catch (error) {
      // 落盘失败只影响「重启后去重」，进程内去重仍然有效。
      this.log.warn(`写报告去重索引失败（进程内去重仍然有效）：${path} —— ${describe(error)}`)
      this.appendFallback(entries)
      try {
        if (existsSync(temp)) unlinkSync(temp)
      } catch {
        /* ignore */
      }
    }
  }

  /** 索引文件不可写时的兜底：追加一行，至少留下痕迹。 */
  private appendFallback(entries: readonly string[]): void {
    try {
      appendFileSync(
        this.reportedFilePath.replace(/\.json$/, '.jsonl'),
        `${JSON.stringify({ at: new Date().toISOString(), reported: entries })}\n`,
        'utf8',
      )
    } catch {
      /* 兜底也失败就放弃，绝不抛错 */
    }
  }

  /** 生成不覆盖既有文件的路径。 */
  private uniquePath(key: string): string {
    const stamp = formatStamp(new Date())
    const base = `${stamp}-${key.length > 0 ? key : 'unknown'}`
    let candidate = join(this.reportDir, `${base}.txt`)
    let suffix = 2
    while (existsSync(candidate)) {
      if (suffix > 999) {
        // 极端情况：时间戳同秒且后缀打满，用毫秒再区分一次。
        candidate = join(this.reportDir, `${base}-${Date.now()}.txt`)
        return candidate
      }
      candidate = join(this.reportDir, `${base}-${suffix}.txt`)
      suffix += 1
    }
    return candidate
  }
}

// ---------- 文本渲染 ----------

/** 固定版式：标题 / 生成时间 / 问题 ID / 问题描述 / 最终状态 / 尝试次数 / 逐次尝试 / 结尾说明。 */
export function renderReport(report: ProblemReport): string {
  const lines: string[] = []
  lines.push('============================================================')
  lines.push('  DSH 任务提醒 —— 未解决问题报告')
  lines.push('============================================================')
  lines.push('')
  lines.push(`生成时间   : ${new Date().toISOString()}`)
  lines.push(`问题 ID    : ${report.problemId}`)
  lines.push(`问题描述   : ${singleLine(report.description)}`)
  lines.push(`最终状态   : ${singleLine(report.finalStatus)}`)
  lines.push(`尝试次数   : ${report.attempts.length} / 上限 ${report.maxAttempts}`)
  lines.push('')
  lines.push('---------------------- 逐次尝试 ----------------------')
  lines.push('')

  if (report.attempts.length === 0) {
    lines.push('（无尝试记录）')
    lines.push('')
  }
  report.attempts.forEach((attempt, index) => {
    lines.push(`【尝试 ${index + 1}】`)
    lines.push(`  时间     : ${attempt.at}`)
    lines.push(`  思考内容 : ${blockValue(attempt.thought)}`)
    lines.push(`  错误信息 : ${blockValue(attempt.error)}`)
    lines.push(`  来源     : ${blockValue(attempt.source)}`)
    lines.push('')
  })

  lines.push('------------------------------------------------------------')
  lines.push('说明：本报告由 dsh-task-alerts 自动生成，同一问题 ID 只会生成一次。')
  lines.push('      报告内容仅为当次尝试的思考与错误摘要，供人工复核，不代表最终结论。')
  lines.push('------------------------------------------------------------')
  return `${lines.join('\n')}\n`
}

/** 多行字段：首行跟在标签后，其余行缩进对齐。 */
function blockValue(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) return '(未记录)'
  const normalized = value.replace(/\r\n?/g, '\n').trim()
  const [first = '', ...rest] = normalized.split('\n')
  if (rest.length === 0) return singleLine(first)
  return [singleLine(first), ...rest.map((line) => `             ${line}`)].join('\n')
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function asOptionalText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value instanceof Error) return `${value.name}: ${value.message}`
  if (value === undefined || value === null) return undefined
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** problemId 清洗：只保留 `[A-Za-z0-9._-]`，其余替换为 `-`。 */
export function sanitizeProblemId(problemId: string): string {
  const cleaned = problemId
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/[-.]+$/, '')
  return cleaned.slice(0, 80)
}

/** `yyyyMMdd-HHmmss`（本地时间，便于人工按时间排序阅读）。 */
export function formatStamp(date: Date): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0')
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
  const clock = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  return `${day}-${clock}`
}

/** 供调用方构造 `ProblemReport` 的小工具（避免各处重复拼装）。 */
export function buildProblemReport(input: {
  problemId: string
  description: string
  finalStatus: string
  attempts: readonly AttemptRecord[]
  maxAttempts: number
}): ProblemReport {
  return {
    problemId: input.problemId,
    description: input.description,
    finalStatus: input.finalStatus,
    attempts: [...input.attempts],
    maxAttempts: input.maxAttempts,
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}
