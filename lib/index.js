/**
 * dsh-fast-mentions entry point.
 *
 * See `core.js` for what is accelerated and why, and `workspace-index.js` for
 * the shared file index.
 *
 * @module dsh-fast-mentions
 */
import * as workspaceIndex from './workspace-index.js'
import { apply as applyCore } from './core.js'

/** Cordis plugin name. */
export const name = 'fast-mentions'

/** Every service is resolved through `ctx.get`, so a missing one only disables its half. */
export const inject = []

/**
 * Install the session and file indices.
 * @param {object} ctx - plugin context.
 * @param {object} [config] - plugin config.
 */
export function apply(ctx, config) {
  applyCore(ctx, config, workspaceIndex)
}

export { candidateRank, compareRows, selectCandidates } from './core.js'
export { listDirectory, rankEntries, WorkspaceIndex, WorkspacePool } from './workspace-index.js'
