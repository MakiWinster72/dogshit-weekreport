const projectPathEl = document.getElementById('project-path')
const fileTreeEl = document.getElementById('file-tree')
const editorTabEl = document.getElementById('editor-tab')
const editorBodyEl = document.getElementById('editor-body')
const shellLabelEl = document.getElementById('shell-label')
const terminalStatusEl = document.getElementById('terminal-status')
const terminalContainerEl = document.getElementById('terminal')
const terminalPaneEl = document.querySelector('.terminal-pane')

/** @type {import('@xterm/xterm').Terminal | null} */
let term = null

/** @type {import('@xterm/addon-fit').FitAddon | null} */
let fitAddon = null

/** @type {WebSocket | null} */
let terminalSocket = null

/** @type {ReturnType<typeof setTimeout> | null} */
let reconnectTimer = null

function escapeHtml(text) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

const MARKDOWN_EXTENSIONS = ['.md', '.markdown', '.mdx']

function isMarkdownFile(path) {
  const lower = path.toLowerCase()
  return MARKDOWN_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

function renderMarkdown(content) {
  if (typeof marked === 'undefined') {
    return escapeHtml(content)
  }

  marked.setOptions({
    gfm: true,
    breaks: true,
  })

  const html = marked.parse(content)
  if (typeof DOMPurify !== 'undefined') {
    return DOMPurify.sanitize(html)
  }
  return html
}

async function fetchJson(url) {
  const response = await fetch(url)
  const data = await response.json()
  if (!response.ok) {
    throw new Error(data.error ?? '请求失败')
  }
  return data
}

function renderLineNumbers(content) {
  const lineCount = content.split('\n').length
  const numbers = Array.from({ length: lineCount }, (_, index) => `<span>${index + 1}</span>`).join('')
  return `<div class="line-numbers">${numbers}</div>`
}

function setEditorEmpty(message) {
  editorTabEl.textContent = '未打开文件'
  editorBodyEl.innerHTML = `<div class="editor-empty">${escapeHtml(message)}</div>`
}

function setEditorError(message) {
  editorBodyEl.innerHTML = `<div class="editor-error">${escapeHtml(message)}</div>`
}

function setEditorBinary(path, size) {
  editorTabEl.textContent = path
  editorBodyEl.innerHTML = `<div class="editor-binary">二进制文件，无法预览（${size} 字节）</div>`
}

function setEditorContent(path, content) {
  editorTabEl.textContent = path
  editorBodyEl.innerHTML = `
    <div class="code-view">
      ${renderLineNumbers(content)}
      <pre class="code-content">${escapeHtml(content)}</pre>
    </div>
  `
}

function setEditorMarkdown(path, content) {
  editorTabEl.textContent = path
  editorBodyEl.innerHTML = `<article class="markdown-body">${renderMarkdown(content)}</article>`
}

function markActiveFile(path) {
  document.querySelectorAll('.tree-row.file.active').forEach((node) => {
    node.classList.remove('active')
  })
  const selector = `[data-path="${CSS.escape(path)}"][data-kind="file"]`
  document.querySelector(selector)?.classList.add('active')
}

async function openFile(path) {
  markActiveFile(path)
  editorTabEl.textContent = path
  editorBodyEl.innerHTML = '<div class="editor-empty">加载中…</div>'

  try {
    const file = await fetchJson(`/api/file?path=${encodeURIComponent(path)}`)
    if (file.binary) {
      setEditorBinary(file.path, file.size)
      return
    }
    if (isMarkdownFile(file.path)) {
      setEditorMarkdown(file.path, file.content)
    } else {
      setEditorContent(file.path, file.content)
    }
  } catch (error) {
    setEditorError(error instanceof Error ? error.message : '读取文件失败')
  }
}

function createTreeRow(entry, depth) {
  const row = document.createElement('div')
  row.className = `tree-row ${entry.type}`
  row.style.setProperty('--depth', String(depth))
  row.dataset.path = entry.path
  row.dataset.kind = entry.type

  const icon = document.createElement('span')
  icon.className = 'tree-icon'
  icon.textContent = entry.type === 'directory' ? '▸' : '•'

  const label = document.createElement('span')
  label.className = 'tree-label'
  label.textContent = entry.name

  row.append(icon, label)
  return row
}

async function loadDirectory(path, container, depth) {
  const data = await fetchJson(`/api/files?path=${encodeURIComponent(path)}`)

  for (const entry of data.entries) {
    const node = document.createElement('div')
    node.className = 'tree-node'
    if (entry.type === 'directory') {
      node.classList.add('directory')
    }

    const row = createTreeRow(entry, depth)
    node.appendChild(row)

    if (entry.type === 'directory') {
      const childContainer = document.createElement('div')
      childContainer.className = 'tree-children'
      node.appendChild(childContainer)

      row.addEventListener('click', async (event) => {
        event.stopPropagation()
        const expanded = node.classList.toggle('expanded')
        row.querySelector('.tree-icon').textContent = expanded ? '▾' : '▸'

        if (expanded && !node.dataset.loaded) {
          node.dataset.loaded = '1'
          try {
            await loadDirectory(entry.path, childContainer, depth + 1)
          } catch {
            childContainer.innerHTML = `<div class="tree-row" style="--depth:${depth + 1};color:#f48771">加载失败</div>`
          }
        }
      })
    } else {
      row.addEventListener('click', () => {
        openFile(entry.path)
      })
    }

    container.appendChild(node)
  }
}

async function initFileTree() {
  fileTreeEl.innerHTML = '<div class="editor-empty" style="height:auto;padding:16px">加载文件树…</div>'

  try {
    fileTreeEl.innerHTML = ''
    await loadDirectory('', fileTreeEl, 0)
  } catch (error) {
    fileTreeEl.innerHTML = `<div class="editor-empty" style="height:auto;padding:16px;color:#f48771">${escapeHtml(error instanceof Error ? error.message : '加载失败')}</div>`
  }
}

function setTerminalStatus(state) {
  terminalStatusEl.className = `status-dot ${state}`
}

function sendTerminal(message) {
  if (terminalSocket && terminalSocket.readyState === WebSocket.OPEN) {
    terminalSocket.send(JSON.stringify(message))
  }
}

function resizeTerminal() {
  if (!term || !fitAddon) {
    return
  }

  fitAddon.fit()
  sendTerminal({
    type: 'resize',
    cols: term.cols,
    rows: term.rows,
  })
}

function initTerminal() {
  term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    theme: {
      background: '#1e1e1e',
      foreground: '#cccccc',
      cursor: '#ffffff',
      selectionBackground: '#264f78',
    },
    allowProposedApi: true,
  })

  fitAddon = new FitAddon.FitAddon()
  term.loadAddon(fitAddon)
  term.loadAddon(new WebLinksAddon.WebLinksAddon())
  term.open(terminalContainerEl)

  term.onData((data) => {
    sendTerminal({ type: 'input', data })
  })

  terminalPaneEl.addEventListener('mousedown', () => {
    term.focus()
  })

  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        resizeTerminal()
      })
    })
    observer.observe(terminalPaneEl)
  }

  window.addEventListener('resize', () => {
    requestAnimationFrame(() => {
      resizeTerminal()
    })
  })
}

function connectTerminal() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  terminalSocket = new WebSocket(`${protocol}//${location.host}/ws`)

  terminalSocket.addEventListener('open', () => {
    setTerminalStatus('connected')
    requestAnimationFrame(() => {
      resizeTerminal()
    })
  })

  terminalSocket.addEventListener('message', (event) => {
    let message
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }

    if (message.type === 'ready') {
      shellLabelEl.textContent = message.shell
      requestAnimationFrame(() => {
        resizeTerminal()
        term?.focus()
      })
      return
    }

    if (message.type === 'output') {
      term?.write(message.data)
      return
    }

    if (message.type === 'exit') {
      term?.writeln(`\r\n\x1b[90m[进程已退出，退出码 ${message.exitCode}]\x1b[0m`)
      setTerminalStatus('error')
    }
  })

  terminalSocket.addEventListener('close', () => {
    setTerminalStatus('error')
    reconnectTimer = setTimeout(connectTerminal, 1500)
  })

  terminalSocket.addEventListener('error', () => {
    setTerminalStatus('error')
  })
}

async function init() {
  initTerminal()

  try {
    const info = await fetchJson('/api/info')
    projectPathEl.textContent = info.cwd
    shellLabelEl.textContent = info.shell
  } catch {
    projectPathEl.textContent = '—'
  }

  setEditorEmpty('从左侧选择文件以预览内容')
  connectTerminal()

  requestAnimationFrame(() => {
    resizeTerminal()
    term?.focus()
  })

  void initFileTree()
}

init()
