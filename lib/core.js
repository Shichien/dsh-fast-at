/**
 * `fast-mentions` core — make every part of the `@` menu answer from memory.
 *
 * The `@` source (`@deepseek-ai/dsh-client-ui-reference`) awaits two host calls
 * and renders one merged list, so the menu is as slow as the slower half:
 *
 * ```js
 * await Promise.all([
 *   ctx.remote.fileReferences.list(sessionId, query, signal),
 *   ctx.remote.sessionReferenceResolver.candidates(sessionId, query, signal),
 * ])
 * ```
 *
 * File half (measured on the live host, 37 agents, 487 real `@` calls):
 *  - the stock index is per *agent*: each new conversation re-walks the same
 *    workspace (seen: 226 / 393 / 763 ms on the first `@`);
 *  - every keystroke lowercases, scores and fully sorts all indexed paths
 *    (7–12 ms per keystroke at 8–14 k entries, p90 36 ms, p99 60 ms).
 * This plugin answers it from one shared index per working directory with
 * precomputed keys, top-k selection and prefix narrowing, and lets a cold
 * index answer from its partial breadth-first scan after `coldBudgetMs`.
 *
 * Session half: answered from an in-memory label table with precomputed
 * search keys instead of re-listing the corpus per keystroke.
 *
 * Both halves fall back to the stock code path on anything unexpected.
 *
 * @module dsh-fast-mentions/core
 */

/** Projection keys a discovery label is answered from (dsh-session-reference `LABEL_KEYS`). */
const LABEL_KEYS = ['title', 'subagent']
const DEFAULT_REFRESH_MS = 30_000
const LIFECYCLE_DEBOUNCE_MS = 2_000
const SEPARATOR = '\u0000'

/** Working-directory affinity rank, identical to the reference service. */
export function candidateRank(candidateCwd, targetCwd) {
  if (candidateCwd !== undefined && targetCwd !== undefined && candidateCwd === targetCwd) return 0
  if (candidateCwd === undefined) return 1
  return 2
}

/** Corpus order used by `sessionQuery.listSessions` (`compareSessions`). */
export function compareRows(left, right) {
  return right.createdAt - left.createdAt || left.sessionId.localeCompare(right.sessionId)
}

/** Lowercased search haystack for one row; fields joined by NUL. */
function haystackOf(sessionId, cwd, label, displayTitle) {
  return [sessionId, cwd ?? '', label, displayTitle].map((part) => part.toLocaleLowerCase()).join(SEPARATOR)
}

/** Exact stock matching: case-insensitive substring of id, cwd, label or display title. */
function matches(row, needle) {
  if (needle === '') return true
  if (!needle.includes(SEPARATOR)) {
    if (!row.hay.includes(needle)) return false
    // A hit inside one field is the stock rule; a hit spanning NUL is impossible without NUL.
    return true
  }
  return (
    row.sessionId.toLocaleLowerCase().includes(needle) ||
    (typeof row.cwd === 'string' && row.cwd.toLocaleLowerCase().includes(needle)) ||
    row.label.toLocaleLowerCase().includes(needle) ||
    row.displayTitle.toLocaleLowerCase().includes(needle)
  )
}

/**
 * Filter, rank and cap rows that are already in corpus order.
 * Stable bucketing by affinity rank equals the stock "sort by rank, then index".
 */
export function selectCandidates(orderedRows, { agentId, targetCwd, query, limit }) {
  const needle = typeof query === 'string' ? query.toLocaleLowerCase() : ''
  const buckets = [[], [], []]
  for (const row of orderedRows) {
    if (row.sessionId === agentId) continue
    const rank = candidateRank(row.cwd, targetCwd)
    // Only the first `limit` rows of a bucket can ever be returned.
    if (buckets[rank].length >= limit) continue
    if (!matches(row, needle)) continue
    buckets[rank].push(row)
    // Once the best bucket is full, nothing later can be returned.
    if (buckets[0].length >= limit) break
  }
  const picked = [...buckets[0], ...buckets[1], ...buckets[2]].slice(0, limit)
  return picked.map((row) => ({
    sessionId: row.sessionId,
    label: row.label,
    displayTitle: row.displayTitle,
    ...(row.cwd === undefined ? {} : { cwd: row.cwd }),
    sameWorkspace: row.cwd !== undefined && row.cwd === targetCwd,
    createdAt: row.createdAt,
  }))
}

function normalizeConfig(config) {
  const input = config ?? {}
  const integer = (value, fallback, floor) => (Number.isSafeInteger(value) && value >= floor ? value : fallback)
  return {
    enabled: input.enabled !== false,
    sessionIndex: input.sessionIndex !== false,
    fileIndex: input.fileIndex !== false && input.workspaceWarm !== false,
    prewarm: input.prewarm !== false,
    refreshMs: integer(input.refreshMs, DEFAULT_REFRESH_MS, 1_000),
    warmupDelayMs: integer(input.warmupDelayMs, 1_000, 0),
    sessionWarmDelayMs: integer(input.sessionWarmDelayMs, 500, 0),
    coldBudgetMs: integer(input.coldBudgetMs, 120, 0),
    rebuildMinMs: integer(input.rebuildMinMs, 3_000, 0),
    maxWorkspaces: integer(input.maxWorkspaces, 16, 1),
    releaseStockIndices: input.releaseStockIndices !== false,
    verbose: input.verbose === true,
    announce: input.announce !== false,
    // Test seam: `{readdir, lstat}` replacing node:fs/promises.
    fs: input.fs !== null && typeof input.fs === 'object' ? input.fs : undefined,
  }
}

function fallbackLabels(ctx, items) {
  const projections = ctx.get?.('sessionProjections')
  const sessions = ctx.get?.('sessions')
  const attached = new Map((sessions?.list?.() ?? []).map((session) => [session.id, session]))
  const cache = ctx.get?.('sessionProjectionCache')
  const cachedSnapshot = typeof cache?.cachedSnapshot === 'function' ? cache.cachedSnapshot.bind(cache) : undefined
  return items.map((item) => {
    const session = attached.get(item.record.header.id)
    const snapshot =
      session !== undefined && projections !== undefined
        ? projections.snapshot(session, LABEL_KEYS)
        : cachedSnapshot?.(item.record.header, LABEL_KEYS)
    const title = snapshot?.values?.title
    const label = title === undefined || title === null ? item.record.header.id : title
    const subagent = snapshot?.values?.subagent
    const displayTitle = subagent === undefined || subagent === null ? label : (subagent.label ?? label)
    return { ...item, label, displayTitle }
  })
}

function rowOf(item) {
  const header = item.record.header
  return {
    sessionId: header.id,
    label: item.label,
    displayTitle: item.displayTitle,
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
    createdAt: header.createdAt,
    hay: haystackOf(header.id, header.cwd, item.label, item.displayTitle),
  }
}

function resolveLogger(ctx, name) {
  try {
    const logger = typeof ctx.logger === 'function' ? ctx.logger(name) : ctx.logger
    return { info: logger?.info?.bind(logger), warn: logger?.warn?.bind(logger) }
  } catch {
    return {}
  }
}

/**
 * Install both halves.
 * @param {object} ctx - plugin context.
 * @param {object} [config] - plugin config.
 * @param {object} ws - the workspace-index module.
 */
export function apply(ctx, config, ws) {
  const options = normalizeConfig(config)
  if (!options.enabled) return
  const log = resolveLogger(ctx, 'fast-mentions')
  const timers = new Set()
  const disposers = []
  let disposed = false

  const later = (delay, task) => {
    if (disposed) return
    const timer = setTimeout(() => {
      timers.delete(timer)
      if (disposed) return
      try {
        task()
      } catch (error) {
        log.warn?.(`[fast-mentions] timer task threw: ${String(error)}`)
      }
    }, delay)
    timer.unref?.()
    timers.add(timer)
  }

  const announced = new Set()
  const announce = (channel, message) => {
    if (!options.announce || announced.has(channel)) return
    announced.add(channel)
    log.warn?.(`[fast-mentions] ${message}`)
  }

  if (options.sessionIndex) installSessionIndex(ctx, options, log, (m) => announce('session', m), disposers)
  if (options.fileIndex && ws !== undefined) {
    installFileIndex(ctx, options, log, (m) => announce('workspace', m), later, disposers, ws)
  }

  ctx.effect(() => () => {
    disposed = true
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        dispose()
      } catch {
        /* an unload must never throw */
      }
    }
  }, 'fast-mentions: indices')
}

/** Restore exactly what was on `target[key]` before a shadow was installed. */
function shadow(target, key, value) {
  const ownDescriptor = Object.getOwnPropertyDescriptor(target, key)
  Object.defineProperty(target, key, { configurable: true, enumerable: false, writable: true, value })
  return () => {
    if (ownDescriptor !== undefined) Object.defineProperty(target, key, ownDescriptor)
    else delete target[key]
  }
}

// ------------------------------------------------------------------ sessions

function installSessionIndex(ctx, options, log, announce, disposers) {
  const resolver = ctx.get?.('sessionReferenceResolver')
  const original = resolver?.listCandidates
  if (resolver === undefined || resolver === null || typeof original !== 'function') {
    if (options.verbose) log.warn?.('[fast-mentions] no sessionReferenceResolver.listCandidates; session index skipped')
    return
  }

  /** Persisted corpus rows in corpus order, and by id. */
  let ordered
  let byId
  let builtAt = 0
  let inflight
  let lifecycleTimer
  let buildCount = 0

  const labelOf = (items) => {
    if (typeof resolver.projectedLabels === 'function') {
      try {
        return resolver.projectedLabels(items)
      } catch {
        /* fall through */
      }
    }
    return fallbackLabels(ctx, items)
  }

  const build = () => {
    if (inflight !== undefined) return inflight
    const run = (async () => {
      const sessionQuery = ctx.get?.('sessionQuery')
      if (sessionQuery === undefined || typeof sessionQuery.listSessions !== 'function') return undefined
      const startedAt = performance.now()
      const records = await sessionQuery.listSessions()
      // The corpus is unique by id; keep the last (live) record if a source ever repeats one.
      const unique = [...new Map(records.map((record) => [record.header.id, record])).values()]
      const rows = labelOf(unique.map((record, index) => ({ record, index }))).map(rowOf)
      rows.sort(compareRows)
      ordered = rows
      byId = new Map(rows.map((row) => [row.sessionId, row]))
      builtAt = Date.now()
      buildCount += 1
      const elapsed = Math.round(performance.now() - startedAt)
      if (buildCount === 1) announce(`会话索引就绪: ${rows.length} 个会话, ${elapsed}ms`)
      else if (options.verbose) log.warn?.(`[fast-mentions] 会话索引重建: ${rows.length} 个会话, ${elapsed}ms`)
      return rows
    })()
    inflight = run
    run.catch((error) => log.warn?.(`[fast-mentions] 会话索引构建失败，退回原有路径: ${String(error)}`))
    run.catch(() => {}).finally(() => {
      if (inflight === run) inflight = undefined
    })
    return run
  }

  const maybeRefresh = () => {
    if (inflight === undefined && Date.now() - builtAt >= options.refreshMs) void build()
  }

  const scheduleRebuild = () => {
    if (lifecycleTimer !== undefined) return
    lifecycleTimer = setTimeout(() => {
      lifecycleTimer = undefined
      void build()
    }, LIFECYCLE_DEBOUNCE_MS)
    lifecycleTimer.unref?.()
  }

  /**
   * Labels of live sessions, re-read only when a session event (title
   * change, rename, new turn) or the live set changed since the last read.
   */
  let liveCache
  let liveDirty = true
  const liveRowsOf = (live) => {
    const key = live.map((session) => session.id).join(SEPARATOR)
    const fresh = liveCache !== undefined && Date.now() - liveCache.at < 1_000
    if (!liveDirty && fresh && liveCache.key === key && liveCache.ordered === ordered) return liveCache.rows
    liveDirty = false
    const rows = labelOf(live.map((session) => ({ record: { header: session.header }, index: 0 }))).map(rowOf)
    liveCache = { key, ordered, rows, at: Date.now() }
    return rows
  }

  /** Persisted rows with live sessions overlaid, in corpus order. */
  const currentRows = () => {
    const sessions = ctx.get?.('sessions')
    const live = typeof sessions?.list === 'function' ? (sessions.list() ?? []) : []
    if (live.length === 0) return ordered
    const liveRows = liveRowsOf(live)
    if (liveCache.merged !== undefined) return liveCache.merged
    const overlay = new Map(liveRows.map((row) => [row.sessionId, row]))
    const merged = ordered.map((row) => overlay.get(row.sessionId) ?? row)
    let extra = false
    for (const row of liveRows) {
      if (!byId.has(row.sessionId)) {
        merged.push(row)
        extra = true
      }
    }
    // A live header may carry a different createdAt than the stored one only in theory; resort when anything moved.
    if (extra || liveRows.some((row) => byId.get(row.sessionId)?.createdAt !== row.createdAt)) merged.sort(compareRows)
    liveCache.merged = merged
    return merged
  }

  const serve = (agent, query, limit) =>
    selectCandidates(currentRows(), {
      agentId: agent?.id,
      targetCwd: agent?.session?.header?.cwd,
      query: typeof query === 'string' ? query : '',
      limit,
    })

  const patched = async (agent, query = '', limit, signal) => {
    if (signal?.aborted === true) return []
    const cap = Number.isSafeInteger(limit) && limit > 0 ? limit : (resolver.config?.candidateLimit ?? 50)
    if (ordered === undefined) {
      const ready = await build().catch(() => undefined)
      if (ready === undefined) return original.call(resolver, agent, query, cap, signal)
    } else {
      maybeRefresh()
    }
    return serve(agent, query, cap)
  }

  try {
    disposers.push(shadow(resolver, 'listCandidates', patched))
  } catch (error) {
    log.warn?.(`[fast-mentions] 无法安装会话索引: ${String(error)}`)
    return
  }
  disposers.push(() => {
    if (lifecycleTimer !== undefined) clearTimeout(lifecycleTimer)
    lifecycleTimer = undefined
  })
  ctx.on?.('session/created', scheduleRebuild)
  ctx.on?.('session/disposed', scheduleRebuild)
  // Any committed event may change a live title or subagent label; just mark dirty (O(1)).
  const markLive = () => {
    liveDirty = true
  }
  ctx.on?.('session/event', markLive)
  ctx.on?.('session/created', markLive)
  ctx.on?.('session/disposed', markLive)
  const warmTimer = setTimeout(() => void build().catch(() => {}), options.sessionWarmDelayMs)
  warmTimer.unref?.()
  disposers.push(() => clearTimeout(warmTimer))
}

// --------------------------------------------------------------------- files

function installFileIndex(ctx, options, log, announce, later, disposers, ws) {
  const fileRef = ctx.get?.('fileReferences')
  const wd = ctx.get?.('workingDirectory')
  const agents = ctx.get?.('agents')
  const original = fileRef?.list
  if (fileRef === undefined || fileRef === null || typeof original !== 'function' || typeof wd?.get !== 'function') {
    if (options.verbose) log.warn?.('[fast-mentions] no fileReferences/workingDirectory; file index skipped')
    return
  }

  // Honor the deployment's own file-reference settings.
  const stock = fileRef.config ?? {}
  const positive = (value, fallback) => (Number.isSafeInteger(value) && value > 0 ? value : fallback)
  const maxResults = positive(stock.maxResults, ws.STOCK_MAX_RESULTS)
  const maxEntries = positive(stock.maxEntries, ws.STOCK_MAX_ENTRIES)
  const excluded = Array.isArray(stock.excludedDirectories) ? [...stock.excludedDirectories] : [...ws.STOCK_EXCLUDED_DIRECTORIES]
  const pool = new ws.WorkspacePool({
    maxEntries,
    excludedDirectories: excluded,
    rebuildMinMs: options.rebuildMinMs,
    maxWorkspaces: options.maxWorkspaces,
    fs: options.fs,
  })
  const directoryOptions = { excludedSet: new Set(excluded), maxResults, fs: options.fs }

  const cwdOf = (session) => {
    try {
      const value = wd.get(session)
      return typeof value === 'string' && value !== '' ? value : undefined
    } catch {
      return undefined
    }
  }

  // The stock path validates (and pins) the working directory on each call.
  // Do that once per agent, off the keystroke path.
  const validated = new WeakSet()
  const validate = (agent) => {
    if (validated.has(agent) || typeof wd.ensure !== 'function') return
    validated.add(agent)
    Promise.resolve()
      .then(() => wd.ensure(agent))
      .catch(() => {})
  }

  let firstServe = true
  const patched = async function patchedList(agent, rawQuery, signal) {
    signal?.throwIfAborted?.()
    const cwd = agent?.session === undefined ? undefined : cwdOf(agent.session)
    if (cwd === undefined || typeof rawQuery !== 'string') return original.call(fileRef, agent, rawQuery, signal)
    validate(agent)
    const query = rawQuery.replaceAll('\\', '/')
    try {
      if (query === '' || query.includes('/')) return await ws.listDirectory(cwd, query, directoryOptions, signal)
      const startedAt = performance.now()
      const { rows, partial } = await pool.get(cwd).query(query, maxResults, options.coldBudgetMs, signal)
      if (firstServe) {
        firstServe = false
        if (options.verbose) log.warn?.(`[fast-mentions] 首次文件查询 ${Math.round(performance.now() - startedAt)}ms partial=${partial}`)
      }
      return rows
    } catch (error) {
      if (signal?.aborted === true) throw error
      if (options.verbose) log.warn?.(`[fast-mentions] 文件索引退回原有路径: ${String(error).slice(0, 160)}`)
      return original.call(fileRef, agent, rawQuery, signal)
    }
  }

  try {
    disposers.push(shadow(fileRef, 'list', patched))
  } catch (error) {
    log.warn?.(`[fast-mentions] 无法安装文件索引: ${String(error)}`)
    return
  }
  disposers.push(() => pool.dispose())

  // The stock per-agent indices are no longer read; release them.
  if (options.releaseStockIndices && fileRef.searches instanceof Map) {
    let released = 0
    for (const entry of fileRef.searches.values()) {
      try {
        entry?.search?.dispose?.()
        released += 1
      } catch {
        /* ignore */
      }
    }
    fileRef.searches.clear()
    if (options.verbose) log.warn?.(`[fast-mentions] 释放 ${released} 个按对话重复的旧索引`)
  }

  const warmCwd = (cwd) => {
    if (cwd === undefined || !options.prewarm) return
    const index = pool.get(cwd)
    if (index.settled !== undefined || index.building !== undefined) return
    const startedAt = performance.now()
    index.ensureBuild().then(
      (entries) => announce(`工作区索引预热完成: ${cwd} ${entries.length} 项, ${Math.round(performance.now() - startedAt)}ms`),
      (error) => {
        if (options.verbose) log.warn?.(`[fast-mentions] 预热跳过 ${cwd}: ${String(error).slice(0, 160)}`)
      },
    )
  }

  ctx.on?.('agent/created', ({ agent }) => {
    // Serial listener: never await here.
    later(options.warmupDelayMs, () => warmCwd(agent?.session === undefined ? undefined : cwdOf(agent.session)))
  })

  ctx.on?.('session/event', (session, event) => {
    if (event?.type === 'tool/result') {
      const cwd = cwdOf(session)
      if (cwd !== undefined) pool.invalidate(cwd)
    } else if (event?.type === 'working-directory/change') {
      later(0, () => warmCwd(cwdOf(session)))
    }
  })

  // Directories already in use when the plugin mounted: warm them one after another.
  let live = []
  try {
    live = agents?.list?.() ?? []
  } catch {
    live = []
  }
  const seen = new Set()
  const roots = []
  for (const agent of live) {
    const cwd = agent?.session === undefined ? undefined : cwdOf(agent.session)
    if (cwd === undefined) continue
    const key = pool.keyOf(cwd)
    if (seen.has(key)) continue
    seen.add(key)
    roots.push(cwd)
  }
  roots.forEach((cwd, order) => later(options.warmupDelayMs + order * 400, () => warmCwd(cwd)))
}
