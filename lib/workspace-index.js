/**
 * Shared, rank-fast workspace index for `@` file completion.
 *
 * This is a faithful re-implementation of `WorkspaceFileSearch` from
 * `@deepseek-ai/dsh-file-reference-local` (same traversal order, same entry
 * budget, same exclusions, same score function, same tie-breaks), with three
 * differences that only change *when* work happens, never *what* is returned:
 *
 *  1. One index per working directory, shared by every conversation in it.
 *     The stock service keys its index per agent, so the first `@` of every new
 *     conversation re-walks the same tree.
 *  2. Lowercased paths and basenames are computed once at index time, and the
 *     top `limit` rows are selected in one pass instead of scoring, lowercasing
 *     and fully sorting every entry on every keystroke.
 *  3. A cold index answers from what it has scanned so far once a small budget
 *     elapses, instead of holding the menu until the whole tree is walked. The
 *     traversal is breadth-first, so the partial answer is the shallow, most
 *     relevant part of the tree; the next keystroke sees more.
 *
 * @module dsh-fast-mentions/workspace-index
 */
import { lstat as fsLstat, readdir as fsReaddir } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Stock defaults, mirrored from dsh-file-reference-local. */
export const STOCK_EXCLUDED_DIRECTORIES = [
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  '.next',
  '.nuxt',
  '.turbo',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.gradle',
]
export const STOCK_MAX_RESULTS = 20
export const STOCK_MAX_ENTRIES = 50_000

/** Code-unit comparison, exactly the stock `compareText`. */
export function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

const byName = (left, right) => compareText(left.name, right.name)

/** Stock subsequence score. */
function subsequenceScore(target, query) {
  let targetIndex = 0
  let gap = 0
  for (const character of query) {
    const found = target.indexOf(character, targetIndex)
    if (found < 0) return undefined
    gap += found - targetIndex
    targetIndex = found + 1
  }
  return Math.max(0, 100 - gap)
}

/**
 * Stock score over precomputed lowercase strings.
 * @param {string} lowerPath - candidate path, lowercased.
 * @param {string} lowerName - candidate basename, lowercased.
 * @param {string} kind - `file` or `directory`.
 * @param {string} needle - query, lowercased; non-empty.
 * @returns {number | undefined} score, or undefined when it does not match.
 */
function scoreLower(lowerPath, lowerName, kind, needle) {
  const directoryBonus = kind === 'directory' ? 25 : 0
  if (lowerName === needle) return 1000 + directoryBonus
  if (lowerName.startsWith(needle)) return 900 + directoryBonus
  if (lowerName.includes(needle)) return 700 + directoryBonus
  if (lowerPath.includes(needle)) return 500 + directoryBonus
  const subsequence = subsequenceScore(lowerPath, needle)
  return subsequence === undefined ? undefined : 300 + subsequence + directoryBonus
}

/** One indexed entry with its precomputed comparison keys. */
function makeEntry(path, kind) {
  const lower = path.toLowerCase()
  return {
    path,
    kind,
    lower,
    lowerName: lower.slice(lower.lastIndexOf('/') + 1),
    hidden: path.startsWith('.') || path.includes('/.'),
  }
}

/**
 * Select the best `limit` entries in stock order: score desc, directories
 * first, shorter path first (non-empty query), then code-unit path order.
 * Equivalent to the stock "score all, full sort, slice" because the order is a
 * strict total order over unique paths.
 * @param {Iterable<object>} entries - entries with precomputed keys.
 * @param {string} query - the raw (slash-normalized) query.
 * @param {number} limit - result cap.
 * @param {(entry: object) => boolean} [admit] - extra visibility filter.
 * @returns {{path: string, kind: string}[]} ranked candidates.
 */
export function rankEntries(entries, query, limit, admit) {
  return selectTop(entries, query, limit, admit, undefined)
}

/**
 * {@link rankEntries}, optionally collecting every matching entry so the next,
 * longer query can rank only those: every score tier implies a subsequence
 * match on the path, and a subsequence of an extended needle is also a
 * subsequence of its prefix, so the match set only ever shrinks while typing.
 */
function selectTop(entries, query, limit, admit, matches) {
  const needle = query.toLowerCase()
  const lengthMatters = query !== ''
  const top = []
  const better = (a, b) =>
    b.score - a.score ||
    (a.entry.kind === 'directory' ? 0 : 1) - (b.entry.kind === 'directory' ? 0 : 1) ||
    (lengthMatters ? a.entry.path.length - b.entry.path.length : 0) ||
    compareText(a.entry.path, b.entry.path)
  for (const entry of entries) {
    if (admit !== undefined && !admit(entry)) continue
    const score = needle === '' ? 0 : scoreLower(entry.lower, entry.lowerName, entry.kind, needle)
    if (score === undefined) continue
    if (matches !== undefined) matches.push(entry)
    const item = { entry, score }
    if (top.length === limit && better(item, top[limit - 1]) >= 0) continue
    let at = top.length
    while (at > 0 && better(item, top[at - 1]) < 0) at -= 1
    top.splice(at, 0, item)
    if (top.length > limit) top.pop()
  }
  return top.map(({ entry }) => ({ path: entry.path, kind: entry.kind }))
}

const sleep = (ms) =>
  new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, ms)
    timer.unref?.()
  })

function abortError(signal) {
  const reason = signal?.reason
  return reason instanceof Error ? reason : new Error('file search aborted', { cause: reason })
}

/** Resolve `promise`, or reject when `signal` aborts first. */
function untilAborted(promise, signal) {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(abortError(signal))
  return new Promise((resolvePromise, rejectPromise) => {
    const onAbort = () => rejectPromise(abortError(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolvePromise(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        rejectPromise(error)
      },
    )
  })
}

/**
 * One working directory's index. Never thrown away on invalidation: the stale
 * entries keep answering while a replacement is built behind the caret.
 */
export class WorkspaceIndex {
  /**
   * @param {string} root - absolute working directory.
   * @param {object} options - `{maxEntries, excludedDirectories, rebuildMinMs, fs}`.
   */
  constructor(root, options) {
    this.root = root
    this.maxEntries = options.maxEntries
    this.excluded = new Set(options.excludedDirectories)
    this.rebuildMinMs = options.rebuildMinMs ?? 0
    this.readdir = options.fs?.readdir ?? fsReaddir
    this.controller = new AbortController()
    /** Entries of the last finished traversal. */
    this.settled = undefined
    /** The traversal in flight: `{partial, promise}`. */
    this.building = undefined
    this.stale = false
    this.lastBuildStartedAt = -Infinity
    this.lastUsedAt = Date.now()
    this.disposed = false
    this.builds = 0
  }

  /** Start a traversal unless one is running; returns its promise. */
  ensureBuild() {
    if (this.building !== undefined) return this.building.promise
    const partial = []
    this.lastBuildStartedAt = Date.now()
    this.stale = false
    const building = { partial, promise: undefined }
    building.promise = this.scan(partial, this.controller.signal).then(
      (entries) => {
        if (this.building === building) this.building = undefined
        if (!this.disposed) {
          this.settled = entries
          this.builds += 1
        }
        return entries
      },
      (error) => {
        if (this.building === building) this.building = undefined
        throw error
      },
    )
    building.promise.catch(() => {})
    this.building = building
    return building.promise
  }

  /** Stock breadth-first traversal, filling `indexed` as it goes. */
  async scan(indexed, signal) {
    const directories = [{ absolute: this.root, relative: '' }]
    for (let cursor = 0; cursor < directories.length && indexed.length < this.maxEntries; cursor += 1) {
      signal.throwIfAborted()
      const directory = directories[cursor]
      let names
      if (cursor === 0) {
        names = await this.readdir(directory.absolute, { withFileTypes: true })
      } else {
        try {
          names = await this.readdir(directory.absolute, { withFileTypes: true })
        } catch {
          signal.throwIfAborted()
          names = []
        }
      }
      signal.throwIfAborted()
      names.sort(byName)
      for (const entry of names) {
        const path = directory.relative === '' ? entry.name : `${directory.relative}/${entry.name}`
        if (entry.isDirectory()) {
          if (this.excluded.has(entry.name)) continue
          indexed.push(makeEntry(path, 'directory'))
          directories.push({ absolute: join(directory.absolute, entry.name), relative: path })
        } else if (entry.isFile()) {
          indexed.push(makeEntry(path, 'file'))
        }
        if (indexed.length >= this.maxEntries) break
      }
    }
    return indexed
  }

  /** Mark stale; the next query keeps the old entries and refreshes in the background. */
  invalidate() {
    this.stale = true
  }

  /**
   * Entries to rank right now.
   * @param {number} coldBudgetMs - how long a never-built index may hold the caller.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<{entries: object[], partial: boolean}>}
   */
  async entriesFor(coldBudgetMs, signal) {
    this.lastUsedAt = Date.now()
    if (this.settled !== undefined) {
      if (this.stale && this.building === undefined && Date.now() - this.lastBuildStartedAt >= this.rebuildMinMs) {
        void this.ensureBuild()
      }
      return { entries: this.settled, partial: false }
    }
    const promise = this.ensureBuild()
    const building = this.building
    const finished = await untilAborted(
      Promise.race([promise.then(() => true), sleep(coldBudgetMs).then(() => false)]),
      signal,
    )
    if (finished || this.settled !== undefined) return { entries: this.settled ?? [], partial: false }
    return { entries: building?.partial ?? [], partial: true }
  }

  /**
   * Answer one bare (slash-free) query.
   * @returns {Promise<{rows: object[], partial: boolean}>}
   */
  async query(query, limit, coldBudgetMs, signal) {
    const { entries, partial } = await this.entriesFor(coldBudgetMs, signal)
    signal?.throwIfAborted()
    const showHidden = query.startsWith('.') || query.includes('/.')
    const admit = showHidden ? undefined : (entry) => !entry.hidden
    const needle = query.toLowerCase()
    // Typing narrows: rank only what the previous, shorter query matched.
    const last = this.lastQuery
    const narrowable =
      !partial &&
      last !== undefined &&
      last.entries === entries &&
      last.showHidden === showHidden &&
      last.needle !== '' &&
      needle.startsWith(last.needle)
    const pool = narrowable ? last.matches : entries
    const matches = []
    const rows = selectTop(pool, query, limit, narrowable ? undefined : admit, matches)
    this.lastQuery = partial ? undefined : { entries, showHidden, needle, matches }
    return { rows, partial }
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.controller.abort(new Error('file search index disposed'))
    this.building = undefined
    this.settled = undefined
  }
}

/**
 * Stock directory-scoped listing (`@` alone, or a query containing `/`), read
 * live from disk exactly like `WorkspaceFileSearch.listDirectory`.
 */
export async function listDirectory(root, query, options, signal) {
  const slash = query.lastIndexOf('/')
  const displayDirectory = slash < 0 ? '' : query.slice(0, slash + 1)
  const fragment = slash < 0 ? '' : query.slice(slash + 1)
  const excluded = options.excludedSet
  const readdir = options.fs?.readdir ?? fsReaddir
  const lstat = options.fs?.lstat ?? fsLstat
  if (displayDirectory.split('/').some((segment) => excluded.has(segment))) return []

  const resolvedRoot = resolve(root)
  const absolute = resolve(resolvedRoot, displayDirectory === '' ? '.' : displayDirectory)
  const fromRoot = relative(resolvedRoot, absolute)
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) return []
  if (isAbsolute(fromRoot)) return []
  let current = resolvedRoot
  for (const segment of fromRoot.split(sep).filter(Boolean)) {
    signal?.throwIfAborted()
    current = join(current, segment)
    try {
      const status = await lstat(current)
      signal?.throwIfAborted()
      if (status.isSymbolicLink() || !status.isDirectory()) return []
    } catch {
      signal?.throwIfAborted()
      return []
    }
  }

  signal?.throwIfAborted()
  let names
  try {
    names = await readdir(absolute, { withFileTypes: true })
  } catch (error) {
    signal?.throwIfAborted()
    // The workspace root itself is unreadable: let the stock path recover it.
    if (displayDirectory === '') throw error
    return []
  }
  signal?.throwIfAborted()
  names.sort(byName)
  const candidates = []
  for (const entry of names) {
    if (entry.name.startsWith('.') && !fragment.startsWith('.')) continue
    if (entry.isDirectory()) {
      if (excluded.has(entry.name)) continue
      candidates.push(makeEntry(`${displayDirectory}${entry.name}`, 'directory'))
    } else if (entry.isFile()) {
      candidates.push(makeEntry(`${displayDirectory}${entry.name}`, 'file'))
    }
  }
  return rankEntries(candidates, fragment, options.maxResults)
}

/**
 * Pool of per-directory indices with LRU eviction.
 */
export class WorkspacePool {
  constructor(options) {
    this.options = options
    this.indices = new Map()
  }

  keyOf(root) {
    const absolute = resolve(root)
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute
  }

  get(root) {
    const key = this.keyOf(root)
    let index = this.indices.get(key)
    if (index === undefined || index.disposed) {
      index = new WorkspaceIndex(resolve(root), this.options)
      this.indices.set(key, index)
      this.evict()
    }
    return index
  }

  peek(root) {
    return this.indices.get(this.keyOf(root))
  }

  invalidate(root) {
    this.peek(root)?.invalidate()
  }

  evict() {
    const cap = this.options.maxWorkspaces ?? 16
    if (this.indices.size <= cap) return
    const ordered = [...this.indices.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)
    for (const [key, index] of ordered.slice(0, this.indices.size - cap)) {
      index.dispose()
      this.indices.delete(key)
    }
  }

  dispose() {
    for (const index of this.indices.values()) index.dispose()
    this.indices.clear()
  }
}
