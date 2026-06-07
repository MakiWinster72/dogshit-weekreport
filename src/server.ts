import { createServer, type Server } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import type { IPty } from 'node-pty'
import * as pty from 'node-pty'
import { WebSocketServer, type WebSocket } from 'ws'
import { FileAccessError, createProjectDirectory, createProjectFile, deleteProjectEntry, listDirectory, readProjectFile, writeProjectFile } from './files.js'
import { watchProjectDirectory } from './fileWatch.js'
import { buildShellEnv, getDefaultShell } from './shell.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export interface WorkspaceServerOptions {
  cwd: string
  port?: number
  host?: string
}

export interface WorkspaceServerHandle {
  url: string
  port: number
  cwd: string
  shell: ReturnType<typeof getDefaultShell>
  close: () => Promise<void>
}

interface TerminalClientMessage {
  type: 'input' | 'resize'
  data?: string
  cols?: number
  rows?: number
}

function resolvePublicDir(): string {
  return join(__dirname, '..', 'public')
}

function attachTerminal(
  ws: WebSocket,
  cwd: string,
  shell: ReturnType<typeof getDefaultShell>,
): () => void {
  let ptyProcess: IPty | null = null

  const dispose = () => {
    if (ptyProcess) {
      ptyProcess.kill()
      ptyProcess = null
    }
  }

  ptyProcess = pty.spawn(shell.command, shell.args, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd,
    env: buildShellEnv(cwd) as Record<string, string>,
  })

  ptyProcess.onData((data) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'output', data }))
    }
  })

  ptyProcess.onExit(({ exitCode }) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'exit', exitCode }))
      ws.close()
    }
    ptyProcess = null
  })

  ws.on('message', (raw) => {
    if (!ptyProcess) {
      return
    }

    let message: TerminalClientMessage
    try {
      message = JSON.parse(String(raw)) as TerminalClientMessage
    } catch {
      return
    }

    if (message.type === 'input' && typeof message.data === 'string') {
      ptyProcess.write(message.data)
      return
    }

    if (
      message.type === 'resize'
      && typeof message.cols === 'number'
      && typeof message.rows === 'number'
      && message.cols > 0
      && message.rows > 0
    ) {
      ptyProcess.resize(message.cols, message.rows)
    }
  })

  ws.on('close', dispose)
  ws.on('error', dispose)

  ws.send(
    JSON.stringify({
      type: 'ready',
      cwd,
      shell: shell.label,
      platform: process.platform,
    }),
  )

  return dispose
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
  const shell = getDefaultShell()
  const app = express()
  const publicDir = resolvePublicDir()

  app.use(express.json({ limit: '16kb' }))

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
  const wss = new WebSocketServer({ server, path: '/ws' })
  const treeWss = new WebSocketServer({ server, path: '/ws/tree' })
  const cleanups = new Set<() => void>()
  const treeClients = new Set<WebSocket>()
  let fileWatchCleanup: (() => void) | null = null

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

  wss.on('connection', (ws) => {
    const cleanup = attachTerminal(ws, cwd, shell)
    cleanups.add(cleanup)
    ws.on('close', () => {
      cleanups.delete(cleanup)
    })
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
    server.listen(options.port ?? 0, host, () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to resolve server port'))
        return
      }
      resolve(address.port)
    })
  })

  const url = `http://${host}:${port}`

  return {
    url,
    port,
    cwd,
    shell,
    close: () =>
      new Promise((resolve, reject) => {
        for (const cleanup of cleanups) {
          cleanup()
        }
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
