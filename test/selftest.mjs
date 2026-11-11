/**
 * Self test for dsh-fast-mentions.
 *
 * Two fake hosts, because the plugin fixes two independent halves:
 *
 *  - a session host whose `sessionReferenceResolver.listCandidates` is a faithful
 *    copy of the reference implementation plus an artificial 300 ms corpus scan;
 *  - a workspace host whose `fileReferences.list` is per-agent (as the real
 *    service is) and costs 200 ms the first time an agent asks.
 *
 * Run: node test/selftest.mjs
 */
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

const SCAN_MS = 300
const TRAVERSAL_MS = 200

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Deterministic session corpus, newest first, like a long-lived profile. */
function makeCorpus(count) {
  const base = 1_700_000_000_000
  const records = []
  for (let index = 0; index < count; index++) {
    const id = `session-${String(index).padStart(4, '0')}`
    records.push({
      header: {
        id,
        createdAt: base - index * 60_000,
        cwd: index % 3 === 0 ? 'C:\\Work\\alpha' : index % 3 === 1 ? 'C:\\Work\\beta' : undefined,
        isSeeded: false,
      },
    })
  }
  return records
}

/** Same ordering rule the Session corpus uses. */
function compareSessions(left, right) {
  return right.header.createdAt - left.header.createdAt || left.header.id.localeCompare(right.header.id)
}

/** The reference affinity rank. */
function rank(candidateCwd, targetCwd) {
  if (candidateCwd !== undefined && targetCwd !== undefined && candidateCwd === targetCwd) return 0
  if (candidateCwd === undefined) return 1
  return 2
}

/** The reference `listCandidates` body, transcribed from dsh-session-reference. */
function referenceCandidates(records, labels, agent, query, limit) {
  const needle = query.toLocaleLowerCase()
  const targetCwd = agent.session.header.cwd
  const items = records
    .filter((record) => record.header.id !== agent.id)
    .map((record, index) => ({ record, index }))
  return items
    .map((item) => {
      const label = labels.get(item.record.header.id) ?? item.record.header.id
      return { ...item, label, displayTitle: label }
    })
    .filter(({ record, label, displayTitle }) => {
      if (needle === '') return true
      return (
        record.header.id.toLocaleLowerCase().includes(needle) ||
        record.header.cwd?.toLocaleLowerCase().includes(needle) === true ||
        label.toLocaleLowerCase().includes(needle) ||
        displayTitle.toLocaleLowerCase().includes(needle)
      )
    })
    .sort(
      (left, right) =>
        rank(left.record.header.cwd, targetCwd) - rank(right.record.header.cwd, targetCwd) ||
        left.index - right.index,
    )
    .slice(0, limit)
    .map(({ record, label, displayTitle }) => ({
      sessionId: record.header.id,
      label,
      displayTitle,
      ...(record.header.cwd === undefined ? {} : { cwd: record.header.cwd }),
      sameWorkspace: record.header.cwd !== undefined && record.header.cwd === targetCwd,
      createdAt: record.header.createdAt,
    }))
}

/** Shared fake-context scaffolding. */
function makeContext(services) {
  const listeners = new Map()
  const disposers = []
  const ctx = {
    get: (key) => services[key],
    on(event, listener) {
      const bucket = listeners.get(event) ?? []
      bucket.push(listener)
      listeners.set(event, bucket)
      return () => {}
    },
    effect(factory) {
      const dispose = factory()
      disposers.push(dispose)
      return dispose
    },
    logger: { info: () => {}, warn: () => {} },
  }
  return {
    ctx,
    emit(event, ...args) {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
    dispose() {
      for (const dispose of disposers) dispose?.()
    },
  }
}

/** Host for the session-index half. */
function makeSessionHost(count) {
  const records = makeCorpus(count).sort(compareSessions)
  const labels = new Map()
  for (const [index, record] of records.entries()) {
    if (index % 7 !== 0) labels.set(record.header.id, `对话标题 ${index} topic-${index % 11}`)
  }
  let live = []
  let listCalls = 0
  let candidateCalls = 0

  const resolver = {
    projectedLabels(items) {
      return items.map((item) => {
        const liveSession = live.find((session) => session.id === item.record.header.id)
        const label = liveSession?.title ?? labels.get(item.record.header.id) ?? item.record.header.id
        return { ...item, label, displayTitle: label }
      })
    },
    async listCandidates(agent, query, limit) {
      candidateCalls++
      await sleep(SCAN_MS)
      return referenceCandidates(records, labels, agent, query, limit)
    },
  }

  const services = {
    sessionReferenceResolver: resolver,
    sessionQuery: {
      async listSessions() {
        listCalls++
        await sleep(SCAN_MS)
        return [...records, ...live.map((session) => ({ header: session.header }))]
      },
    },
    sessions: { list: () => live },
  }

  const host = makeContext(services)
  return {
    ...host,
    resolver,
    labels,
    records,
    stats: () => ({ listCalls, candidateCalls }),
    addLive(id, title, cwd) {
      live = [...live, { id, title, header: { id, createdAt: Date.now(), cwd, isSeeded: false } }]
    },
    renameLive(id, title) {
      live = live.map((session) => (session.id === id ? { ...session, title } : session))
      // The real host commits a title event, which is what invalidates live labels.
      host.emit('session/event', live.find((session) => session.id === id), { type: 'title/change' })
    },
    removeLive(id) {
      live = live.filter((session) => session.id !== id)
    },
  }
}


const results = []
async function check(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
  } catch (error) {
    results.push({ name, ok: false, error })
  }
}

const AGENT = { id: 'session-0000', session: { header: { id: 'session-0000', cwd: 'C:\\Work\\alpha' } } }
const LIMIT = 50
const sessionOnly = { workspaceWarm: false, refreshMs: 60_000, warmupDelayMs: 60_000 }

// ---------------------------------------------------------------- session half

await check('candidates are identical to the reference implementation', async () => {
  const host = makeSessionHost(613)
  const queries = ['', 'topic', '对话', 'beta', 'session-01', 'ALPHA', 'zzz-nothing']
  const expected = []
  for (const query of queries) expected.push(JSON.stringify(await host.resolver.listCandidates(AGENT, query, LIMIT)))
  apply(host.ctx, sessionOnly)
  for (const [index, query] of queries.entries()) {
    const actual = JSON.stringify(await host.resolver.listCandidates(AGENT, query, LIMIT))
    assert.equal(actual, expected[index], `query ${JSON.stringify(query)} diverged`)
  }
  host.dispose()
})

await check('session keystrokes are served from memory after one build', async () => {
  const host = makeSessionHost(613)
  apply(host.ctx, sessionOnly)
  const first = performance.now()
  await host.resolver.listCandidates(AGENT, '', LIMIT)
  const firstMs = performance.now() - first
  const second = performance.now()
  for (const query of ['d', 'de', 'dee', 'deep', 'deep ', 'deep s']) {
    await host.resolver.listCandidates(AGENT, query, LIMIT)
  }
  const perKeystroke = (performance.now() - second) / 6
  assert.ok(firstMs >= SCAN_MS, `first build should still pay one scan, got ${firstMs.toFixed(1)}ms`)
  assert.ok(perKeystroke < 15, `cached keystroke was ${perKeystroke.toFixed(2)}ms`)
  assert.ok(host.stats().listCalls <= 2, `expected at most 2 listings, saw ${host.stats().listCalls}`)
  console.log(`  session: first ${firstMs.toFixed(0)}ms, then ${perKeystroke.toFixed(2)}ms/keystroke`)
  host.dispose()
})

await check('session warm-up makes the very first @ fast', async () => {
  const host = makeSessionHost(613)
  apply(host.ctx, { ...sessionOnly, sessionWarmDelayMs: 0 })
  await sleep(SCAN_MS + 150)
  const startedAt = performance.now()
  const rows = await host.resolver.listCandidates(AGENT, 'topic', LIMIT)
  const elapsed = performance.now() - startedAt
  assert.ok(rows.length > 0)
  assert.ok(elapsed < 15, `warm first call was ${elapsed.toFixed(2)}ms`)
  host.dispose()
})

await check('a session created after the build appears without a rebuild', async () => {
  const host = makeSessionHost(40)
  apply(host.ctx, sessionOnly)
  await host.resolver.listCandidates(AGENT, '', LIMIT)
  host.addLive('session-brand-new', '刚建好的新对话 zephyr', 'C:\\Work\\alpha')
  const rows = await host.resolver.listCandidates(AGENT, 'zephyr', LIMIT)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].label, '刚建好的新对话 zephyr')
  assert.equal(rows[0].sameWorkspace, true)
  host.dispose()
})

await check('a rename on a live session is visible on the next keystroke', async () => {
  const host = makeSessionHost(40)
  apply(host.ctx, sessionOnly)
  await host.resolver.listCandidates(AGENT, '', LIMIT)
  host.addLive('session-0001', '旧名字', 'C:\\Work\\beta')
  assert.equal((await host.resolver.listCandidates(AGENT, '旧名字', LIMIT)).length, 1)
  host.renameLive('session-0001', '新名字 quokka')
  const renamed = await host.resolver.listCandidates(AGENT, 'quokka', LIMIT)
  assert.equal(renamed.length, 1)
  assert.equal(renamed[0].label, '新名字 quokka')
  assert.equal((await host.resolver.listCandidates(AGENT, '旧名字', LIMIT)).length, 0)
  host.dispose()
})

await check('a silent live rename still shows up within one second', async () => {
  const host = makeSessionHost(40)
  apply(host.ctx, sessionOnly)
  host.addLive('session-0002', '静默旧名', 'C:\\Work\\beta')
  assert.equal((await host.resolver.listCandidates(AGENT, '静默旧名', LIMIT)).length, 1)
  // Bypass the event: mutate the live title directly.
  const session = host.ctx.get('sessions').list().find((entry) => entry.id === 'session-0002')
  session.title = '静默新名 wombat'
  await sleep(1_050)
  const rows = await host.resolver.listCandidates(AGENT, 'wombat', LIMIT)
  assert.equal(rows.length, 1)
  host.dispose()
})

await check('a session that closes falls back to its persisted title', async () => {
  const host = makeSessionHost(40)
  apply(host.ctx, sessionOnly)
  await host.resolver.listCandidates(AGENT, '', LIMIT)
  host.addLive('session-0001', '临时标题 tempname', 'C:\\Work\\beta')
  assert.equal((await host.resolver.listCandidates(AGENT, 'tempname', LIMIT)).length, 1)
  host.removeLive('session-0001')
  const rows = await host.resolver.listCandidates(AGENT, 'topic', LIMIT)
  assert.ok(rows.some((row) => row.sessionId === 'session-0001'))
  host.dispose()
})

await check('the requesting session is excluded, cwd affinity is kept', async () => {
  const host = makeSessionHost(30)
  apply(host.ctx, sessionOnly)
  const rows = await host.resolver.listCandidates(AGENT, '', 6)
  assert.equal(rows.length, 6)
  assert.ok(!rows.some((row) => row.sessionId === AGENT.id))
  const sameWorkspace = rows.filter((row) => row.sameWorkspace).length
  assert.ok(sameWorkspace > 0)
  assert.ok(rows.slice(0, sameWorkspace).every((row) => row.sameWorkspace))
  host.dispose()
})

await check('without sessionQuery it delegates to the original path', async () => {
  const host = makeSessionHost(20)
  delete host.ctx.get('sessionQuery')
  const services = { sessionReferenceResolver: host.resolver }
  const bare = makeContext(services)
  apply(bare.ctx, sessionOnly)
  const rows = await bare.ctx.get('sessionReferenceResolver').listCandidates(AGENT, 'topic', 5)
  assert.ok(rows.length > 0)
  assert.equal(host.stats().candidateCalls, 1)
  bare.dispose()
  host.dispose()
})

await check('dispose restores the original method', async () => {
  const host = makeSessionHost(10)
  const original = host.resolver.listCandidates
  const hadOwnProperty = Object.hasOwn(host.resolver, 'listCandidates')
  apply(host.ctx, sessionOnly)
  assert.notEqual(host.resolver.listCandidates, original)
  host.dispose()
  assert.equal(host.resolver.listCandidates, original)
  assert.equal(Object.hasOwn(host.resolver, 'listCandidates'), hadOwnProperty)
})

await check('dispose restores a prototype method without leaving a shadow', async () => {
  const host = makeSessionHost(10)
  const { listCandidates, projectedLabels } = host.resolver
  class Resolver {
    listCandidates(agent, query, limit) {
      return listCandidates.call(this, agent, query, limit)
    }
    projectedLabels(items) {
      return projectedLabels.call(this, items)
    }
  }
  const service = new Resolver()
  const bare = makeContext({ sessionReferenceResolver: service, sessionQuery: host.ctx.get('sessionQuery'), sessions: host.ctx.get('sessions') })
  apply(bare.ctx, sessionOnly)
  assert.equal(Object.hasOwn(service, 'listCandidates'), true)
  bare.dispose()
  assert.equal(Object.hasOwn(service, 'listCandidates'), false)
  assert.equal(typeof service.listCandidates, 'function')
})

// -------------------------------------------------------------- workspace half

/** In-memory tree: `{ name: subtree | 'file' }`; readdir costs `delayMs` per call. */
function makeFakeFs(tree, delayMs = 0) {
  let readdirCalls = 0
  const nodeAt = (absolute) => {
    const parts = absolute.replaceAll('\\', '/').split('/').filter(Boolean)
    // parts[0] is the drive (or first segment); the tree hangs under ROOT.
    let node = FAKE_ROOTS
    for (const part of parts) {
      node = node?.[part.toLowerCase()] ?? node?.[part]
      if (node === undefined) return undefined
    }
    return node
  }
  const FAKE_ROOTS = {}
  const rootParts = ROOT.replaceAll('\\', '/').split('/').filter(Boolean)
  let cursor = FAKE_ROOTS
  for (const [index, part] of rootParts.entries()) {
    cursor[part.toLowerCase()] = index === rootParts.length - 1 ? tree : {}
    cursor = cursor[part.toLowerCase()]
  }
  const dirent = (name, value) => ({ name, isDirectory: () => typeof value === 'object', isFile: () => value === 'file' })
  return {
    calls: () => readdirCalls,
    async readdir(absolute) {
      readdirCalls += 1
      if (delayMs > 0) await sleep(delayMs)
      const node = nodeAt(absolute)
      if (node === undefined || typeof node !== 'object') throw Object.assign(new Error(`ENOENT ${absolute}`), { code: 'ENOENT' })
      return Object.entries(node).map(([name, value]) => dirent(name, value))
    },
    async lstat(absolute) {
      const node = nodeAt(absolute)
      if (node === undefined) throw Object.assign(new Error(`ENOENT ${absolute}`), { code: 'ENOENT' })
      return { isSymbolicLink: () => false, isDirectory: () => typeof node === 'object' }
    },
  }
}

const ROOT = process.platform === 'win32' ? 'C:\\Work\\alpha' : '/work/alpha'

function bigTree(dirs, filesPer) {
  const tree = { src: {}, docs: { 'readme.md': 'file' }, node_modules: { junk: { 'x.js': 'file' } }, '.git': { HEAD: 'file' } }
  for (let d = 0; d < dirs; d++) {
    const dir = {}
    for (let f = 0; f < filesPer; f++) dir[`material-${d}-${f}.ts`] = 'file'
    tree.src[`mod${d}`] = dir
  }
  return tree
}

/** Host for the file half: workingDirectory + agents + a stock-shaped fileReferences. */
function makeWorkspaceHost(cwdById = {}) {
  let live = []
  let stockCalls = 0
  const agents = { list: () => live, get: (id) => live.find((agent) => agent.id === id) }
  const workingDirectory = {
    get: (session) => (session.header.id in cwdById ? cwdById[session.header.id] : session.header.cwd),
    ensure: async (agent) => agent.session.header.cwd,
  }
  const stale = { disposed: false, dispose() { this.disposed = true } }
  const fileReferences = {
    config: { maxResults: 20, maxEntries: 50_000, excludedDirectories: ['.git', 'node_modules'] },
    searches: new Map([[{}, { cwd: ROOT, search: stale }]]),
    async list() {
      stockCalls += 1
      return [{ path: 'stock-answer', kind: 'file' }]
    },
  }
  const host = makeContext({ fileReferences, agents, workingDirectory })
  return {
    ...host,
    fileReferences,
    stale,
    stockCalls: () => stockCalls,
    addAgent(id, cwd = ROOT) {
      const agent = { id, session: { header: { id, cwd, isSeeded: false } } }
      live = [...live, agent]
      return agent
    },
    list: (agent, query) => fileReferences.list(agent, query, new AbortController().signal),
  }
}

const fileOnly = (fs, extra = {}) => ({ sessionIndex: false, warmupDelayMs: 0, coldBudgetMs: 50, rebuildMinMs: 0, fs, ...extra })

await check('two conversations in one workspace share one index (one traversal)', async () => {
  const fs = makeFakeFs(bigTree(30, 20))
  const host = makeWorkspaceHost()
  const first = host.addAgent('session-a1')
  const second = host.addAgent('session-a2')
  apply(host.ctx, fileOnly(fs, { prewarm: false }))
  await host.list(first, 'mat')
  const afterFirst = fs.calls()
  const rows = await host.list(second, 'mat')
  assert.equal(rows.length, 20)
  assert.equal(fs.calls(), afterFirst, 'second conversation must not re-walk the workspace')
  host.dispose()
})

await check('prewarm builds the index before the first @', async () => {
  const fs = makeFakeFs(bigTree(30, 20))
  const host = makeWorkspaceHost()
  const agent = host.addAgent('session-b1')
  apply(host.ctx, fileOnly(fs))
  host.emit('agent/created', { agent })
  await sleep(400)
  const calls = fs.calls()
  assert.ok(calls > 0, 'prewarm should have traversed')
  const startedAt = performance.now()
  const rows = await host.list(agent, 'material')
  const elapsed = performance.now() - startedAt
  assert.equal(rows.length, 20)
  assert.equal(fs.calls(), calls, 'a warmed index must not traverse again')
  assert.ok(elapsed < 20, `first @ after prewarm took ${elapsed.toFixed(1)}ms`)
  console.log(`  workspace: first @ after prewarm ${elapsed.toFixed(2)}ms`)
  host.dispose()
})

await check('agents already live when the plugin mounts are prewarmed', async () => {
  const fs = makeFakeFs(bigTree(5, 5))
  const host = makeWorkspaceHost()
  host.addAgent('session-b2')
  host.addAgent('session-b3')
  apply(host.ctx, fileOnly(fs))
  await sleep(200)
  const calls = fs.calls()
  assert.ok(calls > 0, 'mount-time prewarm should have traversed')
  await host.list(host.ctx.get('agents').get('session-b3'), 'mat')
  assert.equal(fs.calls(), calls, 'two agents in one directory warm it once')
  host.dispose()
})

await check('a cold index answers within its budget with partial rows', async () => {
  const fs = makeFakeFs(bigTree(60, 10), 8)
  const host = makeWorkspaceHost()
  const agent = host.addAgent('session-c1')
  apply(host.ctx, fileOnly(fs, { prewarm: false, coldBudgetMs: 40 }))
  const startedAt = performance.now()
  const rows = await host.list(agent, 'mod')
  const elapsed = performance.now() - startedAt
  assert.ok(elapsed < 120, `cold @ held the menu for ${elapsed.toFixed(1)}ms`)
  assert.ok(rows.length > 0, 'partial scan should already have shallow matches')
  await sleep(900)
  const full = await host.list(agent, 'material')
  assert.equal(full.length, 20)
  console.log(`  workspace: cold @ answered in ${elapsed.toFixed(0)}ms (full traversal ~${60 * 8}ms)`)
  host.dispose()
})

await check('excluded and hidden directories stay out, as in stock', async () => {
  const fs = makeFakeFs(bigTree(2, 2))
  const host = makeWorkspaceHost()
  const agent = host.addAgent('session-d1')
  apply(host.ctx, fileOnly(fs, { prewarm: false }))
  assert.equal((await host.list(agent, 'x.js')).length, 0, 'node_modules must not be indexed')
  assert.equal((await host.list(agent, 'HEAD')).length, 0, '.git must not be indexed')
  host.dispose()
})

await check('directory queries list live entries (stock semantics)', async () => {
  const fs = makeFakeFs(bigTree(3, 2))
  const host = makeWorkspaceHost()
  const agent = host.addAgent('session-e1')
  apply(host.ctx, fileOnly(fs, { prewarm: false }))
  assert.deepEqual((await host.list(agent, '')).map((row) => row.path), ['docs', 'src'])
  assert.deepEqual((await host.list(agent, 'src/')).map((row) => row.path), ['src/mod0', 'src/mod1', 'src/mod2'])
  assert.equal((await host.list(agent, '../')).length, 0)
  host.dispose()
})

await check('a tool result refreshes the index in the background', async () => {
  const tree = bigTree(2, 2)
  const fs = makeFakeFs(tree)
  const host = makeWorkspaceHost()
  const agent = host.addAgent('session-f1')
  apply(host.ctx, fileOnly(fs, { prewarm: false }))
  assert.equal((await host.list(agent, 'brandnew')).length, 0)
  tree.docs['brandnew.md'] = 'file'
  host.emit('session/event', agent.session, { type: 'tool/result' })
  assert.equal((await host.list(agent, 'brandnew')).length, 0, 'stale index answers first, without waiting')
  await sleep(30)
  assert.equal((await host.list(agent, 'brandnew')).length, 1, 'refreshed index sees the new file')
  host.dispose()
})

await check('unknown working directory falls back to the stock service', async () => {
  const fs = makeFakeFs(bigTree(1, 1))
  const host = makeWorkspaceHost({ 'session-g1': '' })
  const agent = host.addAgent('session-g1')
  apply(host.ctx, fileOnly(fs, { prewarm: false }))
  assert.deepEqual(await host.list(agent, 'x'), [{ path: 'stock-answer', kind: 'file' }])
  assert.equal(host.stockCalls(), 1)
  host.dispose()
})

await check('an unreadable workspace root falls back to the stock service', async () => {
  const fs = makeFakeFs(bigTree(1, 1))
  const host = makeWorkspaceHost()
  const agent = host.addAgent('session-h1', process.platform === 'win32' ? 'C:\\Missing' : '/missing')
  apply(host.ctx, fileOnly(fs, { prewarm: false }))
  assert.deepEqual(await host.list(agent, 'abc'), [{ path: 'stock-answer', kind: 'file' }])
  host.dispose()
})

await check('dispose restores the stock list method', async () => {
  const fs = makeFakeFs(bigTree(1, 1))
  const host = makeWorkspaceHost()
  const original = host.fileReferences.list
  apply(host.ctx, fileOnly(fs, { prewarm: false }))
  assert.notEqual(host.fileReferences.list, original)
  host.dispose()
  assert.equal(host.fileReferences.list, original)
})

await check('duplicate per-conversation stock indices are released', async () => {
  const fs = makeFakeFs(bigTree(1, 1))
  const host = makeWorkspaceHost()
  apply(host.ctx, fileOnly(fs, { prewarm: false }))
  assert.equal(host.fileReferences.searches.size, 0)
  assert.equal(host.stale.disposed, true)
  host.dispose()
})

await check('config can disable either half', async () => {
  const fs = makeFakeFs(bigTree(1, 1))
  const host = makeWorkspaceHost()
  const resolverHost = makeSessionHost(10)
  const bare = makeContext({
    fileReferences: host.fileReferences,
    agents: host.ctx.get('agents'),
    workingDirectory: host.ctx.get('workingDirectory'),
    sessionReferenceResolver: resolverHost.resolver,
    sessionQuery: resolverHost.ctx.get('sessionQuery'),
    sessions: resolverHost.ctx.get('sessions'),
  })
  const originalCandidates = resolverHost.resolver.listCandidates
  const originalList = host.fileReferences.list
  apply(bare.ctx, { fileIndex: false, sessionIndex: false, fs })
  assert.equal(resolverHost.resolver.listCandidates, originalCandidates)
  assert.equal(host.fileReferences.list, originalList)
  bare.dispose()
})

const failed = results.filter((entry) => !entry.ok)
for (const entry of results) {
  console.log(`${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name}`)
  if (!entry.ok) console.log(`      ${entry.error?.stack ?? entry.error}`)
}
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exitCode = failed.length === 0 ? 0 : 1
