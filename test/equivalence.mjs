/**
 * Equivalence + speed check against the REAL stock implementation.
 *
 * Imports `WorkspaceFileSearch` from the installed DSH package and compares its
 * answers with the plugin's shared index on real directories, query by query.
 *
 * Run: node test/equivalence.mjs [dir ...]
 */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import { WorkspaceIndex, listDirectory, STOCK_EXCLUDED_DIRECTORIES } from '../lib/workspace-index.js'

// Point DSH_APP at your DSH Desktop `resources/app` directory.
const DSH_APP = process.env.DSH_APP ?? 'D:\\DSHDesktop\\DSH Desktop\\resources\\app'
const STOCK = `${DSH_APP}/node_modules/@deepseek-ai/dsh-file-reference-local/lib/index.js`
const { WorkspaceFileSearch, DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES } = await import(pathToFileURL(STOCK).href)

assert.deepEqual([...STOCK_EXCLUDED_DIRECTORIES], [...DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES], 'excluded directories drifted')

const roots = process.argv.slice(2).filter((dir) => existsSync(dir))
if (roots.length === 0) roots.push(process.cwd())

const QUERIES = [
  '', 'a', 'ma', 'mat', 'mate', 'material', 'materials', 'src', 'src/', 'lib/', 'test', 'index', 'index.js', 'readme',
  'README', 'json', '.git', '.', '.vs', 'x', 'xyzq', '主', '主席', 'png', 'uasset', 'content', 'Content/', 'Content/The',
  'out', 'build', 'node_modules/', '..', '../', 'a/b', 'abc', 'ts', 'main', 'mod', 'conf', 'zz', 'q', 'cfg', '-', '_', ' ',
]
const config = { maxResults: 20, maxEntries: 50_000, excludedDirectories: [...DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES] }
const signal = new AbortController().signal

let mismatches = 0
for (const root of roots) {
  const stock = new WorkspaceFileSearch(root, config)
  let began = performance.now()
  await stock.list('a', signal)
  const stockBuild = performance.now() - began

  const mine = new WorkspaceIndex(root, { maxEntries: config.maxEntries, excludedDirectories: config.excludedDirectories })
  began = performance.now()
  await mine.ensureBuild()
  const mineBuild = performance.now() - began

  const directoryOptions = { excludedSet: new Set(config.excludedDirectories), maxResults: config.maxResults }
  const answer = async (query) => {
    const normalized = query.replaceAll('\\', '/')
    if (normalized === '' || normalized.includes('/')) return listDirectory(root, normalized, directoryOptions, signal)
    return (await mine.query(normalized, config.maxResults, 0, signal)).rows
  }

  // Equivalence, including the incremental-narrowing path (typed in sequence).
  for (const query of QUERIES) {
    const expected = await stock.list(query, signal)
    const actual = await answer(query)
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      mismatches += 1
      console.log(`MISMATCH root=${root} q=${JSON.stringify(query)}`)
      console.log('  stock:', JSON.stringify(expected).slice(0, 400))
      console.log('  mine :', JSON.stringify(actual).slice(0, 400))
    }
  }
  // Typing sequences exercise narrowing caches.
  for (const word of ['material', 'readme', 'index.js', 'content', 'texture', 'uasset']) {
    for (let length = 1; length <= word.length; length += 1) {
      const query = word.slice(0, length)
      const expected = await stock.list(query, signal)
      const actual = await answer(query)
      if (JSON.stringify(expected) !== JSON.stringify(actual)) {
        mismatches += 1
        console.log(`MISMATCH(typing) root=${root} q=${JSON.stringify(query)}`)
      }
    }
  }

  // Speed: per keystroke, typed "material".
  const time = async (fn, runs = 7) => {
    const samples = []
    for (let i = 0; i < runs; i += 1) {
      const t = performance.now()
      await fn()
      samples.push(performance.now() - t)
    }
    samples.sort((x, y) => x - y)
    return samples[Math.floor(runs / 2)]
  }
  const typing = 'material'
  let stockTotal = 0
  let mineTotal = 0
  for (let length = 1; length <= typing.length; length += 1) {
    const query = typing.slice(0, length)
    stockTotal += await time(() => stock.list(query, signal))
    mineTotal += await time(() => answer(query))
  }
  const entries = mine.settled.length
  console.log(
    `${root}\n  entries=${entries}  build: stock ${stockBuild.toFixed(0)}ms / mine ${mineBuild.toFixed(0)}ms\n` +
      `  per keystroke (typing "material"): stock ${(stockTotal / typing.length).toFixed(2)}ms / mine ${(mineTotal / typing.length).toFixed(2)}ms`,
  )

  // Cold partial answer: a fresh index with a tiny budget must answer quickly.
  const cold = new WorkspaceIndex(root, { maxEntries: config.maxEntries, excludedDirectories: config.excludedDirectories })
  began = performance.now()
  const { rows, partial } = await cold.query('a', 20, 60, signal)
  console.log(`  cold first query (budget 60ms): ${(performance.now() - began).toFixed(0)}ms partial=${partial} rows=${rows.length}`)
  cold.dispose()
  stock.dispose()
  mine.dispose()
}

console.log(mismatches === 0 ? '\nEQUIVALENT: all queries identical to stock' : `\n${mismatches} MISMATCHES`)
process.exitCode = mismatches === 0 ? 0 : 1
