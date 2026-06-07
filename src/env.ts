import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface AppEnvConfig {
  host: string
  port: number
  allowedIps: string[]
}

const DEFAULT_PORT = 4721
const DEFAULT_HOST = '127.0.0.1'

/** 从工作目录加载 `.env`（不覆盖已有 process.env） */
export function loadEnvFile(cwd: string): void {
  const envPath = join(cwd, '.env')
  if (!existsSync(envPath)) {
    return
  }

  const content = readFileSync(envPath, 'utf8')
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) {
      continue
    }

    const eq = line.indexOf('=')
    if (eq <= 0) {
      continue
    }

    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()

    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    if (process.env[key] === undefined) {
      process.env[key] = value
    }
  }
}

export function normalizeClientIp(raw: string | undefined): string {
  if (!raw) {
    return ''
  }

  let ip = raw.trim()
  if (ip.startsWith('::ffff:')) {
    ip = ip.slice(7)
  }

  return ip
}

export function parseAllowedIps(raw: string | undefined): string[] {
  if (!raw?.trim()) {
    return []
  }

  return raw
    .split(',')
    .map((part) => normalizeClientIp(part.trim()))
    .filter(Boolean)
}

export function readAppEnvConfig(portOverride?: number): AppEnvConfig {
  const portFromEnv = Number.parseInt(process.env.DWR_PORT ?? '', 10)
  const port = portOverride ?? (Number.isFinite(portFromEnv) && portFromEnv > 0 ? portFromEnv : DEFAULT_PORT)

  const host = process.env.DWR_HOST?.trim() || DEFAULT_HOST
  const allowedIps = parseAllowedIps(process.env.DWR_ALLOWED_IPS)

  return { host, port, allowedIps }
}

export function isClientIpAllowed(clientIp: string, allowedIps: string[]): boolean {
  const ip = normalizeClientIp(clientIp)
  if (!ip) {
    return false
  }

  if (allowedIps.length === 0) {
    return ip === '127.0.0.1' || ip === '::1'
  }

  return allowedIps.includes(ip)
}

/** 注入 Claude CLI 可能用到的密钥（仅对话 PTY） */
export function buildClaudeShellEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base }
  const keys = ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'] as const

  for (const key of keys) {
    const value = process.env[key]?.trim()
    if (value) {
      env[key] = value
    }
  }

  return env
}
