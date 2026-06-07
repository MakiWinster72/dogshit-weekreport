import { createServer, type Server } from 'node:http'
import type { Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import type { IPty } from 'node-pty'
import * as pty from 'node-pty'
import { WebSocketServer, type WebSocket } from 'ws'
import { FileAccessError, createProjectDirectory, createProjectFile, deleteProjectEntry, listDirectory, readProjectFile, writeProjectFile } from './files.js'
import { watchProjectDirectory } from './fileWatch.js'
import { buildShellEnv, getDefaultShell } from './shell.js'
import { buildClaudeShellEnv, isClientIpAllowed, normalizeClientIp } from './env.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export interface WorkspaceServerOptions {
  cwd: string
  port?: number
  host?: string
  allowedIps?: string[]
}

export interface WorkspaceServerHandle {
  url: string
  port: number
  cwd: string
  shell: ReturnType<typeof getDefaultShell>
  close: () => Promise<void>
}

interface TerminalClientMessage {
  type: 'input' | 'resize' | 'switch'
  data?: string
  cols?: number
  rows?: number
  profile?: TerminalProfile
}

type TerminalProfile = 'shell' | 'claude'

const TERMINAL_BUFFER_LIMIT = 512 * 1024

interface TerminalSession {
  pty: IPty | null
  buffer: string
  exitCode: number | null
}

function resolvePublicDir(): string {
  return join(__dirname, '..', 'public')
}

function profileLabel(profile: TerminalProfile, shell: ReturnType<typeof getDefaultShell>): string {
  return profile === 'claude' ? 'Claude' : shell.label
}

function appendSessionBuffer(session: TerminalSession, data: string): void {
  session.buffer += data
  if (session.buffer.length > TERMINAL_BUFFER_LIMIT) {
    session.buffer = session.buffer.slice(-TERMINAL_BUFFER_LIMIT)
  }
}

function attachTerminal(
  ws: WebSocket,
  cwd: string,
  shell: ReturnType<typeof getDefaultShell>,
  initialProfile: TerminalProfile = 'shell',
): () => void {
  let cols = 80
  let rows = 24
  let activeProfile: TerminalProfile = initialProfile

  const sessions: Record<TerminalProfile, TerminalSession> = {
    shell: { pty: null, buffer: '', exitCode: null },
    claude: { pty: null, buffer: '', exitCode: null },
  }

  const disposeAll = () => {
    for (const profile of ['shell', 'claude'] as const) {
      if (sessions[profile].pty) {
        sessions[profile].pty.kill()
        sessions[profile].pty = null
      }
    }
  }

  const sendSwitch = (profile: TerminalProfile) => {
    const session = sessions[profile]
    ws.send(
      JSON.stringify({
        type: 'switch',
        profile,
        label: profileLabel(profile, shell),
        data: session.buffer,
        exitCode: session.exitCode,
      }),
    )
  }

  const spawnSession = (profile: TerminalProfile) => {
    const session = sessions[profile]
    if (session.pty) {
      return
    }

    session.exitCode = null

    const spawnOptions = {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env:
        profile === 'claude'
          ? (buildClaudeShellEnv(buildShellEnv(cwd)) as Record<string, string>)
          : (buildShellEnv(cwd) as Record<string, string>),
    }

    const ptyProcess =
      profile === 'claude'
        ? pty.spawn('claude', [], spawnOptions)
        : pty.spawn(shell.command, shell.args, spawnOptions)

    session.pty = ptyProcess

    ptyProcess.onData((data) => {
      appendSessionBuffer(session, data)
      if (activeProfile === profile && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'output', data, profile }))
      }
    })

    ptyProcess.onExit(({ exitCode }) => {
      session.pty = null
      session.exitCode = exitCode
      const notice = `\r\n\x1b[90m[${profileLabel(profile, shell)} 已退出，退出码 ${exitCode}]\x1b[0m`
      appendSessionBuffer(session, notice)
      if (activeProfile === profile && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'exit', exitCode, profile }))
      }
    })
  }

  const ensureSession = (profile: TerminalProfile) => {
    if (!sessions[profile].pty && sessions[profile].exitCode === null) {
      spawnSession(profile)
    }
  }

  const activateProfile = (profile: TerminalProfile) => {
    ensureSession(profile)
    activeProfile = profile
    sendSwitch(profile)
  }

  const resizeSessions = (nextCols: number, nextRows: number) => {
    cols = nextCols
    rows = nextRows
    for (const profile of ['shell', 'claude'] as const) {
      sessions[profile].pty?.resize(nextCols, nextRows)
    }
  }

  spawnSession('shell')
  if (initialProfile === 'claude') {
    spawnSession('claude')
    activeProfile = 'claude'
  }

  ws.send(
    JSON.stringify({
      type: 'ready',
      cwd,
      shell: profileLabel(activeProfile, shell),
      platform: process.platform,
      profile: activeProfile,
      data: sessions[activeProfile].buffer,
      exitCode: sessions[activeProfile].exitCode,
    }),
  )

  ws.on('message', (raw) => {
    let message: TerminalClientMessage
    try {
      message = JSON.parse(String(raw)) as TerminalClientMessage
    } catch {
      return
    }

    if (message.type === 'switch') {
      const profile = message.profile === 'claude' ? 'claude' : 'shell'
      const nextCols =
        typeof message.cols === 'number' && message.cols > 0 ? message.cols : cols
      const nextRows =
        typeof message.rows === 'number' && message.rows > 0 ? message.rows : rows
      resizeSessions(nextCols, nextRows)
      activateProfile(profile)
      return
    }

    if (
      message.type === 'resize'
      && typeof message.cols === 'number'
      && typeof message.rows === 'number'
      && message.cols > 0
      && message.rows > 0
    ) {
      resizeSessions(message.cols, message.rows)
      return
    }

    if (message.type === 'input' && typeof message.data === 'string') {
      const session = sessions[activeProfile]
      if (session.pty) {
        session.pty.write(message.data)
      }
    }
  })

  return disposeAll
}

function sendFileError(res: express.Response, error: unknown): void {
  if (error instanceof FileAccessError) {
    res.status(error.status).json({ error: error.message })
    return
  }
  res.status(500).json({ error: '服务器内部错误' })
}

export async function startWorkspaceServer(options: WorkspaceServerOptions): Promise<WorkspaceServerHandle> {
  const cwd = options.cwd
  const host = options.host ?? '127.0.0.1'
  const allowedIps = options.allowedIps ?? []
  const shell = getDefaultShell()
  const app = express()
  const publicDir = resolvePublicDir()

  const rejectClient = (remoteAddress: string | undefined): boolean => {
    return !isClientIpAllowed(normalizeClientIp(remoteAddress), allowedIps)
  }

  app.use(express.json({ limit: '16kb' }))

  app.use((req, res, next) => {
    if (rejectClient(req.socket.remoteAddress)) {
      res.status(403).json({ error: '客户端 IP 不在允许列表中' })
      return
    }
    next()
  })

  app.get('/api/info', (_req, res) => {
    res.json({
      cwd,
      shell: shell.label,
      platform: process.platform,
    })
  })

  app.get('/api/files', async (req, res) => {
    const path = typeof req.query.path === 'string' ? req.query.path : ''
    try {
      const entries = await listDirectory(cwd, path)
      res.json({ path, entries })
    } catch (error) {
      sendFileError(res, error)
    }
  })

  app.get('/api/file', async (req, res) => {
    const path = typeof req.query.path === 'string' ? req.query.path : ''
    try {
      const file = await readProjectFile(cwd, path)
      res.json(file)
    } catch (error) {
      sendFileError(res, error)
    }
  })

  app.post('/api/create', async (req, res) => {
    const parentPath = typeof req.body?.parentPath === 'string' ? req.body.parentPath : ''
    const name = typeof req.body?.name === 'string' ? req.body.name : ''
    const type = req.body?.type

    if (type !== 'file' && type !== 'directory') {
      res.status(400).json({ error: '无效的类型' })
      return
    }

    try {
      const entry =
        type === 'directory'
          ? await createProjectDirectory(cwd, parentPath, name)
          : await createProjectFile(cwd, parentPath, name)
      res.status(201).json({ entry })
    } catch (error) {
      sendFileError(res, error)
    }
  })

  app.post('/api/delete', async (req, res) => {
    const path = typeof req.body?.path === 'string' ? req.body.path : ''
    try {
      await deleteProjectEntry(cwd, path)
      res.json({ ok: true })
    } catch (error) {
      sendFileError(res, error)
    }
  })

  app.put('/api/file', async (req, res) => {
    const path = typeof req.body?.path === 'string' ? req.body.path : ''
    const content = typeof req.body?.content === 'string' ? req.body.content : null

    if (content === null) {
      res.status(400).json({ error: '缺少文件内容' })
      return
    }

    try {
      const file = await writeProjectFile(cwd, path, content)
      res.json(file)
    } catch (error) {
      sendFileError(res, error)
    }
  })

  app.use(express.static(publicDir))

  app.get('*', (_req, res) => {
    res.sendFile(join(publicDir, 'index.html'))
  })

  const server: Server = createServer(app)
  const wss = new WebSocketServer({ noServer: true })
  const treeWss = new WebSocketServer({ noServer: true })
  const cleanups = new Set<() => void>()
  const treeClients = new Set<WebSocket>()
  let fileWatchCleanup: (() => void) | null = null

  server.on('upgrade', (request, socket, head) => {
    const clientSocket = socket as Socket
    if (rejectClient(clientSocket.remoteAddress)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
      return
    }

    const reqHost = request.headers.host ?? '127.0.0.1'
    const pathname = new URL(request.url ?? '/', `http://${reqHost}`).pathname

    if (pathname === '/ws') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request)
      })
      return
    }

    if (pathname === '/ws/tree') {
      treeWss.handleUpgrade(request, socket, head, (ws) => {
        treeWss.emit('connection', ws, request)
      })
      return
    }

    socket.destroy()
  })

  const broadcastTreeChange = () => {
    const payload = JSON.stringify({ type: 'changed' })
    for (const client of treeClients) {
      if (client.readyState === client.OPEN) {
        client.send(payload)
      }
    }
  }

  const ensureFileWatcher = () => {
    if (fileWatchCleanup) {
      return
    }
    fileWatchCleanup = watchProjectDirectory(cwd, broadcastTreeChange)
    cleanups.add(fileWatchCleanup)
  }

  wss.on('connection', (ws, request) => {
    const host = request.headers.host ?? '127.0.0.1'
    const profileParam = new URL(request.url ?? '/', `http://${host}`).searchParams.get('profile')
    const initialProfile = profileParam === 'claude' ? 'claude' : 'shell'
    const cleanup = attachTerminal(ws, cwd, shell, initialProfile)
    cleanups.add(cleanup)

    const onClose = () => {
      cleanup()
      cleanups.delete(cleanup)
      ws.off('close', onClose)
      ws.off('error', onClose)
    }

    ws.on('close', onClose)
    ws.on('error', onClose)
  })

  treeWss.on('connection', (ws) => {
    ensureFileWatcher()
    treeClients.add(ws)
    ws.on('close', () => {
      treeClients.delete(ws)
      if (treeClients.size === 0 && fileWatchCleanup) {
        fileWatchCleanup()
        cleanups.delete(fileWatchCleanup)
        fileWatchCleanup = null
      }
    })
  })

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 4721, host, () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to resolve server port'))
        return
      }
      resolve(address.port)
    })
  })

  const url = `http://${host}:${port}`

  let isClosing = false

  return {
    url,
    port,
    cwd,
    shell,
    close: () =>
      new Promise((resolve, reject) => {
        if (isClosing) {
          resolve()
          return
        }
        isClosing = true

        for (const cleanup of cleanups) {
          cleanup()
        }
        cleanups.clear()

        wss.close((wssError) => {
          if (wssError) {
            reject(wssError)
            return
          }
          treeWss.close((treeWssError) => {
            if (treeWssError) {
              reject(treeWssError)
              return
            }
            server.close((serverError) => {
              if (serverError) {
                reject(serverError)
                return
              }
              resolve()
            })
          })
        })
      }),
  }
}
