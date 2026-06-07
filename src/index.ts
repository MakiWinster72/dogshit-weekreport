#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { loadEnvFile, readAppEnvConfig } from './env.js'
import { startWorkspaceServer } from './server.js'

const DEFAULT_PORT = 4721

function openInBrowser(url: string): void {
  const launcher =
    process.platform === 'win32'
      ? { command: 'cmd', args: ['/c', 'start', '', url] as string[] }
      : process.platform === 'darwin'
        ? { command: 'open', args: [url] }
        : { command: 'xdg-open', args: [url] }

  spawn(launcher.command, launcher.args, { detached: true, stdio: 'ignore' }).unref()
}

function parseArgs(argv: string[]): { cwd: string; port?: number; openBrowser: boolean } {
  const args = [...argv]
  let cwd = process.cwd()
  let port: number | undefined
  let openBrowser = true

  while (args.length > 0) {
    const arg = args.shift()
    if (!arg) {
      break
    }

    if (arg === '--cwd' && args[0]) {
      cwd = resolve(args.shift()!)
      continue
    }

    if (arg === '--port' && args[0]) {
      const parsed = Number.parseInt(args.shift()!, 10)
      if (!Number.isNaN(parsed) && parsed > 0) {
        port = parsed
      }
      continue
    }

    if (arg === '--no-open') {
      openBrowser = false
      continue
    }

    if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    }
  }

  return { cwd, port, openBrowser }
}

function printHelp(): void {
  console.log(`weekreport-term — 浏览器内项目工作台

用法:
  weekreport-term [--cwd <path>] [--port <number>] [--no-open]

选项:
  --cwd      项目根目录，默认为当前目录（从此目录读取 .env）
  --port     监听端口，默认 ${DEFAULT_PORT}（.env 中 DWR_PORT 次之）
  --no-open  启动后不自动打开浏览器
  -h         显示帮助

环境变量（见 .env.example）:
  DWR_HOST         监听地址，默认 127.0.0.1
  DWR_PORT         服务端口
  DWR_ALLOWED_IPS  允许访问的客户端 IP，逗号分隔
  ANTHROPIC_API_KEY  对话模式 Claude CLI 使用的密钥
`)
}

async function main(): Promise<void> {
  const { cwd, port: portArg, openBrowser } = parseArgs(process.argv.slice(2))
  loadEnvFile(cwd)
  const { host, port, allowedIps } = readAppEnvConfig(portArg)

  if (host === '0.0.0.0' && allowedIps.length === 0) {
    console.warn('警告: DWR_HOST=0.0.0.0 但未配置 DWR_ALLOWED_IPS，仅允许本机 IP 访问')
  }

  const handle = await startWorkspaceServer({ cwd, port, host, allowedIps })

  console.log('')
  console.log('  项目工作台已启动')
  console.log(`  工作目录: ${handle.cwd}`)
  console.log(`  打开:     ${handle.url}`)
  console.log('')
  console.log('  按 Ctrl+C 停止服务')
  console.log('')

  if (openBrowser) {
    openInBrowser(handle.url)
  }

  let shuttingDown = false
  const shutdown = async () => {
    if (shuttingDown) {
      return
    }
    shuttingDown = true
    await handle.close()
    process.exit(0)
  }

  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

main().catch((error: unknown) => {
  console.error('启动失败:', error)
  process.exit(1)
})
