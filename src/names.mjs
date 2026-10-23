// MCP public tool names and `toolFilter` patterns.
//
// `@deepseek-ai/dsh-mcp-client` registers each MCP tool under a public name derived from (serverName,
// rawName): `mcp__<server>__<raw>` normalized to `[A-Za-z0-9_-]`, with a
// 12-hex SHA-256 identity hash appended whenever normalization was lossy or the
// name exceeded 64 characters. The bridge does not export the function and its
// README pins it as a v1 contract, so it is reproduced here and locked by
// test/golden-names.json, generated from the harness source.

import { createHash } from 'node:crypto'

const MAX_PUBLIC_NAME_LENGTH = 64
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g
const HASH_LENGTH = 12

/** Public-name prefix of every MCP tool. */
export const MCP_TOOL_PREFIX = 'mcp__'

/**
 * @param {string} serverName - the `serverName` of an mcp-client row.
 * @returns {string} the public-name prefix every tool of that server carries.
 */
export function serverPrefix(serverName) {
  return `${MCP_TOOL_PREFIX}${serverName}__`
}

/**
 * Derive the public name dsh registers for one MCP tool.
 * @param {string} serverName - the `serverName` of an mcp-client row.
 * @param {string} rawName - the MCP server's own tool name.
 * @returns {string} the registered public name, hashed when normalization was lossy.
 */
export function publicToolName(serverName, rawName) {
  const joined = `${serverPrefix(serverName)}${rawName}`
  const normalized = joined.replace(INVALID_NAME_CHARS, '_')
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
}

/**
 * Compile an mcp-client `toolFilter` (upstream raw names; a trailing `*` is a
 * prefix match) into a predicate over public names.
 * @param {string} serverName - the server the patterns belong to.
 * @param {readonly unknown[]} patterns - the `toolFilter` array from the config block.
 * @returns {(publicName: string) => boolean} true when the tool stays visible.
 * @throws when a pattern is not a non-empty string or misplaces `*`.
 */
export function compileToolFilter(serverName, patterns) {
  const exact = new Set()
  const prefixes = []
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || pattern.length === 0) {
      throw new Error(`toolFilter of "${serverName}": entries must be non-empty strings, got ${JSON.stringify(pattern)}`)
    }
    const star = pattern.indexOf('*')
    if (star === -1) {
      exact.add(publicToolName(serverName, pattern))
      continue
    }
    if (star !== pattern.length - 1 || star === 0) {
      throw new Error(`toolFilter of "${serverName}": "${pattern}" — "*" is only supported as a trailing prefix match`)
    }
    prefixes.push(`${serverPrefix(serverName)}${pattern.slice(0, star)}`.replace(INVALID_NAME_CHARS, '_'))
  }
  return (publicName) => exact.has(publicName) || prefixes.some((prefix) => publicName.startsWith(prefix))
}

/**
 * The server a public MCP tool name belongs to.
 *
 * `serverName` may contain `__`, so the longest known server whose prefix
 * matches wins; an unclaimed name falls back to the segment before the first
 * `__`.
 * @param {string} toolName - a registered tool name.
 * @param {readonly string[]} known - configured server names.
 * @returns {string | undefined} the owning server, or undefined for a non-MCP tool.
 */
export function attributeServer(toolName, known) {
  if (!toolName.startsWith(MCP_TOOL_PREFIX)) return undefined
  let owner
  for (const serverName of known) {
    if (!toolName.startsWith(serverPrefix(serverName))) continue
    if (owner === undefined || serverName.length > owner.length) owner = serverName
  }
  if (owner !== undefined) return owner
  const rest = toolName.slice(MCP_TOOL_PREFIX.length)
  const boundary = rest.indexOf('__')
  return boundary > 0 ? rest.slice(0, boundary) : undefined
}
