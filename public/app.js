const projectPathEl = document.getElementById('project-path')
const fileTreeEl = document.getElementById('file-tree')
const editorTabEl = document.getElementById('editor-tab')
const editorBodyEl = document.getElementById('editor-body')
const editorToolbarEl = document.getElementById('editor-toolbar')
const editorModeViewBtn = document.getElementById('editor-mode-view')
const editorModeEditBtn = document.getElementById('editor-mode-edit')
const editorSaveBtn = document.getElementById('editor-save')
const shellLabelEl = document.getElementById('shell-label')
const terminalStatusEl = document.getElementById('terminal-status')
const terminalContainerEl = document.getElementById('terminal')
const terminalPaneEl = document.querySelector('.terminal-pane')
const createDialogEl = document.getElementById('create-dialog')
const createFormEl = document.getElementById('create-form')
const createTitleEl = document.getElementById('create-title')
const createInputEl = document.getElementById('create-input')
const createErrorEl = document.getElementById('create-error')
const createCancelEl = document.getElementById('create-cancel')
const rootCreateFolderBtn = document.getElementById('root-create-folder')
const rootCreateFileBtn = document.getElementById('root-create-file')
const confirmDialogEl = document.getElementById('confirm-dialog')
const confirmTitleEl = document.getElementById('confirm-title')
const confirmMessageEl = document.getElementById('confirm-message')
const confirmCancelEl = document.getElementById('confirm-cancel')
const confirmOkEl = document.getElementById('confirm-ok')

/** @type {string | null} */
let activeFilePath = null

/** @type {'view' | 'edit'} */
let editorMode = 'view'

let savedFileContent = ''
let draftFileContent = ''
let activeFileIsBinary = false

/** @type {{ path: string; type: 'file' | 'directory'; name: string } | null} */
let pendingDelete = null

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

const THEMES = ['dark', 'light', 'one-dark']
let currentThemeIndex = 0

function getCssVariable(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function applyTheme(themeName) {
  if (themeName === 'dark') {
    document.documentElement.removeAttribute('data-theme')
  } else {
    document.documentElement.setAttribute('data-theme', themeName)
  }
  
  if (term) {
    term.options.theme = {
      background: getCssVariable('--bg-primary') || '#1e1e1e',
      foreground: getCssVariable('--text-primary') || '#cccccc',
      cursor: getCssVariable('--text-strong') || '#ffffff',
      selectionBackground: getCssVariable('--term-selection') || '#264f78',
    }
  }

  document.querySelectorAll('.theme-circle').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === themeName)
  })
}

function toggleTheme() {
  currentThemeIndex = (currentThemeIndex + 1) % THEMES.length
  applyTheme(THEMES[currentThemeIndex])
}

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

async function fetchJson(url, options) {
  const response = await fetch(url, options)
  const data = await response.json()
  if (!response.ok) {
    throw new Error(data.error ?? '请求失败')
  }
  return data
}

/** @type {{ parentPath: string; type: 'file' | 'directory' } | null} */
let pendingCreate = null

function openCreateDialog(parentPath, type) {
  pendingCreate = { parentPath, type }
  createTitleEl.textContent = type === 'directory' ? '新建文件夹' : '新建文件'
  createInputEl.value = ''
  createErrorEl.textContent = ''
  createInputEl.placeholder = type === 'directory' ? '文件夹名称' : '文件名称'
  createDialogEl.classList.remove('hidden')
  createInputEl.focus()
}

function closeCreateDialog() {
  pendingCreate = null
  createDialogEl.classList.add('hidden')
  createInputEl.value = ''
  createErrorEl.textContent = ''
}

async function submitCreate(name) {
  if (!pendingCreate) {
    return
  }

  const { parentPath, type } = pendingCreate
  const data = await fetchJson('/api/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parentPath, name, type }),
  })

  closeCreateDialog()
  await refreshTreeAt(parentPath)

  if (data.entry.type === 'file') {
    await openFile(data.entry.path)
  }
}

function createTreeActionButton(action, title, onClick, options = {}) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `tree-action-btn${options.danger ? ' danger' : ''}`
  button.title = title
  button.setAttribute('aria-label', title)

  if (action === 'mkdir') {
    button.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-2 8h-3v3h-2v-3h-3v-2h3V9h2v3h3v2z"/></svg>'
  } else if (action === 'touch') {
    button.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11zm-3-7h-2v-2h-2v2H9v2h2v2h2v-2h2v-2z"/></svg>'
  } else {
    button.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>'
  }

  button.addEventListener('click', (event) => {
    event.stopPropagation()
    onClick()
  })

  return button
}

function appendTreeRowActions(row, entry) {
  const actions = document.createElement('div')
  actions.className = 'tree-actions'

  if (entry.type === 'directory') {
    actions.append(
      createTreeActionButton('mkdir', '新建文件夹', () => {
        openCreateDialog(entry.path, 'directory')
      }),
      createTreeActionButton('touch', '新建文件', () => {
        openCreateDialog(entry.path, 'file')
      }),
    )
  }

  actions.append(
    createTreeActionButton('delete', '删除', () => {
      openDeleteConfirm(entry)
    }, { danger: true }),
  )

  row.appendChild(actions)
}

function getParentPath(path) {
  const index = path.lastIndexOf('/')
  return index === -1 ? '' : path.slice(0, index)
}

function openDeleteConfirm(entry) {
  pendingDelete = entry
  confirmTitleEl.textContent = entry.type === 'directory' ? '删除文件夹' : '删除文件'
  confirmMessageEl.textContent =
    entry.type === 'directory'
      ? `确定删除文件夹「${entry.name}」及其全部内容？此操作不可撤销。`
      : `确定删除文件「${entry.name}」？此操作不可撤销。`
  confirmDialogEl.classList.remove('hidden')
}

function closeDeleteConfirm() {
  pendingDelete = null
  confirmDialogEl.classList.add('hidden')
  confirmMessageEl.textContent = ''
}

function shouldClearEditor(deletedPath) {
  if (!activeFilePath) {
    return false
  }
  return activeFilePath === deletedPath || activeFilePath.startsWith(`${deletedPath}/`)
}

async function submitDelete() {
  if (!pendingDelete) {
    return
  }

  const entry = pendingDelete
  const parentPath = getParentPath(entry.path)

  await fetchJson('/api/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: entry.path }),
  })

  closeDeleteConfirm()

  if (shouldClearEditor(entry.path)) {
    setEditorEmpty('从左侧选择文件以预览内容')
  }

  await refreshTreeAt(parentPath)
}

function renderLineNumbers(content) {
  const lineCount = content.split('\n').length
  const numbers = Array.from({ length: lineCount }, (_, index) => `<span>${index + 1}</span>`).join('')
  return `<div class="line-numbers">${numbers}</div>`
}

function isEditorDirty() {
  return draftFileContent !== savedFileContent
}

function syncDraftFromEditor() {
  const textarea = editorBodyEl.querySelector('.editor-textarea')
  if (textarea instanceof HTMLTextAreaElement) {
    draftFileContent = textarea.value
  }
}

function updateEditorToolbar() {
  if (!activeFilePath || activeFileIsBinary) {
    editorToolbarEl.classList.add('hidden')
    editorTabEl.textContent = activeFilePath ?? '未打开文件'
    return
  }

  editorToolbarEl.classList.remove('hidden')
  editorModeViewBtn.classList.toggle('active', editorMode === 'view')
  editorModeEditBtn.classList.toggle('active', editorMode === 'edit')
  editorSaveBtn.disabled = !isEditorDirty()
  editorTabEl.textContent = isEditorDirty() ? `${activeFilePath} •` : activeFilePath
}

function renderEditorView() {
  if (!activeFilePath) {
    return
  }

  if (isMarkdownFile(activeFilePath)) {
    editorBodyEl.innerHTML = `<article class="markdown-body">${renderMarkdown(draftFileContent)}</article>`
    return
  }

  editorBodyEl.innerHTML = `
    <div class="code-view">
      ${renderLineNumbers(draftFileContent)}
      <pre class="code-content">${escapeHtml(draftFileContent)}</pre>
    </div>
  `
}

function renderEditorEdit() {
  const textarea = document.createElement('textarea')
  textarea.className = 'editor-textarea'
  textarea.spellcheck = false
  textarea.value = draftFileContent
  textarea.addEventListener('input', () => {
    draftFileContent = textarea.value
    updateEditorToolbar()
  })

  editorBodyEl.innerHTML = ''
  editorBodyEl.appendChild(textarea)
  textarea.focus()
}

function setEditorMode(mode) {
  if (!activeFilePath || activeFileIsBinary) {
    return
  }

  if (editorMode === 'edit' && mode === 'view') {
    syncDraftFromEditor()
  }

  editorMode = mode
  if (mode === 'view') {
    renderEditorView()
  } else {
    renderEditorEdit()
  }
  updateEditorToolbar()
}

async function saveActiveFile() {
  if (!activeFilePath || activeFileIsBinary || !isEditorDirty()) {
    return
  }

  syncDraftFromEditor()
  await fetchJson('/api/file', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: activeFilePath,
      content: draftFileContent,
    }),
  })

  savedFileContent = draftFileContent
  updateEditorToolbar()
}

function resetEditorState() {
  activeFilePath = null
  savedFileContent = ''
  draftFileContent = ''
  activeFileIsBinary = false
  editorMode = 'view'
}

function setEditorEmpty(message) {
  resetEditorState()
  editorTabEl.textContent = '未打开文件'
  editorBodyEl.innerHTML = `<div class="editor-empty">${escapeHtml(message)}</div>`
  updateEditorToolbar()
}

function setEditorError(message) {
  editorBodyEl.innerHTML = `<div class="editor-error">${escapeHtml(message)}</div>`
  updateEditorToolbar()
}

function setEditorBinary(path, size) {
  activeFileIsBinary = true
  editorTabEl.textContent = path
  editorBodyEl.innerHTML = `<div class="editor-binary">二进制文件，无法预览（${size} 字节）</div>`
  updateEditorToolbar()
}

function loadEditableFile(path, content) {
  activeFilePath = path
  activeFileIsBinary = false
  savedFileContent = content
  draftFileContent = content
  editorMode = 'view'
  renderEditorView()
  updateEditorToolbar()
}

function markActiveFile(path) {
  document.querySelectorAll('.tree-row.file.active').forEach((node) => {
    node.classList.remove('active')
  })
  const selector = `[data-path="${CSS.escape(path)}"][data-kind="file"]`
  document.querySelector(selector)?.classList.add('active')
}

async function openFile(path) {
  if (activeFilePath && path !== activeFilePath && isEditorDirty()) {
    const discard = window.confirm('当前文件有未保存的修改，是否丢弃并打开新文件？')
    if (!discard) {
      return
    }
  }

  activeFilePath = path
  markActiveFile(path)
  editorTabEl.textContent = path
  editorBodyEl.innerHTML = '<div class="editor-empty">加载中…</div>'
  editorToolbarEl.classList.add('hidden')

  try {
    const file = await fetchJson(`/api/file?path=${encodeURIComponent(path)}`)
    if (file.binary) {
      setEditorBinary(file.path, file.size)
      return
    }
    loadEditableFile(file.path, file.content)
  } catch (error) {
    resetEditorState()
    setEditorError(error instanceof Error ? error.message : '读取文件失败')
  }
}

function createTreeRow(entry, depth) {
  const row = document.createElement('div')
  row.className = `tree-row ${entry.type}`
  row.style.setProperty('--depth', String(depth))
  row.dataset.path = entry.path
  row.dataset.kind = entry.type

  if (entry.type === 'directory') {
    const chevron = document.createElement('span')
    chevron.className = 'tree-chevron'
    chevron.textContent = '▸'
    row.appendChild(chevron)

    const icon = document.createElement('span')
    icon.className = 'tree-icon'
    icon.innerHTML = renderFileIcon(resolveDirectoryIconName(entry.name, false))
    row.appendChild(icon)

    appendTreeRowActions(row, entry)
  } else {
    const spacer = document.createElement('span')
    spacer.className = 'tree-chevron placeholder'
    row.appendChild(spacer)

    const icon = document.createElement('span')
    icon.className = 'tree-icon'
    icon.innerHTML = renderFileIcon(resolveFileIconName(entry.name))
    row.appendChild(icon)
  }

  const label = document.createElement('span')
  label.className = 'tree-label'
  label.textContent = entry.name

  row.append(label)

  if (entry.type === 'file') {
    appendTreeRowActions(row, entry)
  }

  return row
}

function updateDirectoryRowIcon(row, expanded) {
  const iconEl = row.querySelector('.tree-icon')
  const chevronEl = row.querySelector('.tree-chevron')
  const dirName = row.dataset.path.split('/').pop() ?? ''
  if (iconEl) {
    iconEl.innerHTML = renderFileIcon(resolveDirectoryIconName(dirName, expanded))
  }
  if (chevronEl) {
    chevronEl.textContent = expanded ? '▾' : '▸'
  }
}

async function reloadDirectory(path, container, depth) {
  container.innerHTML = ''
  await loadDirectory(path, container, depth)
}

async function refreshTreeAt(parentPath) {
  if (!parentPath) {
    await reloadDirectory('', fileTreeEl, 0)
    return
  }

  const row = fileTreeEl.querySelector(`.tree-row.directory[data-path="${CSS.escape(parentPath)}"]`)
  const node = row?.closest('.tree-node')
  if (!row || !node) {
    await reloadDirectory('', fileTreeEl, 0)
    return
  }

  const depth = Number(row.style.getPropertyValue('--depth') || '0')
  const childContainer = node.querySelector('.tree-children')
  if (!childContainer) {
    return
  }

  node.classList.add('expanded')
  updateDirectoryRowIcon(row, true)
  node.dataset.loaded = '1'
  await reloadDirectory(parentPath, childContainer, depth + 1)
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
        updateDirectoryRowIcon(row, expanded)

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
      background: getCssVariable('--bg-primary') || '#1e1e1e',
      foreground: getCssVariable('--text-primary') || '#cccccc',
      cursor: getCssVariable('--text-strong') || '#ffffff',
      selectionBackground: getCssVariable('--term-selection') || '#264f78',
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

  rootCreateFolderBtn.addEventListener('click', () => {
    openCreateDialog('', 'directory')
  })
  rootCreateFileBtn.addEventListener('click', () => {
    openCreateDialog('', 'file')
  })

  editorModeViewBtn.addEventListener('click', () => {
    setEditorMode('view')
  })

  editorModeEditBtn.addEventListener('click', () => {
    setEditorMode('edit')
  })

  editorSaveBtn.addEventListener('click', () => {
    saveActiveFile().catch((error) => {
      window.alert(error instanceof Error ? error.message : '保存失败')
    })
  })

  document.addEventListener('keydown', (event) => {
    if (event.altKey && event.key.toLowerCase() === 't') {
      event.preventDefault()
      toggleTheme()
      return
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      if (!activeFilePath || activeFileIsBinary || !isEditorDirty()) {
        return
      }
      event.preventDefault()
      saveActiveFile().catch((error) => {
        window.alert(error instanceof Error ? error.message : '保存失败')
      })
    }
  })

  confirmCancelEl.addEventListener('click', () => {
    closeDeleteConfirm()
  })

  confirmDialogEl.addEventListener('click', (event) => {
    if (event.target === confirmDialogEl) {
      closeDeleteConfirm()
    }
  })

  confirmOkEl.addEventListener('click', async () => {
    if (!pendingDelete) {
      return
    }

    try {
      await submitDelete()
    } catch (error) {
      confirmMessageEl.textContent = error instanceof Error ? error.message : '删除失败'
    }
  })

  createCancelEl.addEventListener('click', () => {
    closeCreateDialog()
  })

  createDialogEl.addEventListener('click', (event) => {
    if (event.target === createDialogEl) {
      closeCreateDialog()
    }
  })

  createFormEl.addEventListener('submit', async (event) => {
    event.preventDefault()
    const name = createInputEl.value.trim()
    if (!name || !pendingCreate) {
      return
    }

    try {
      await submitCreate(name)
    } catch (error) {
      createErrorEl.textContent = error instanceof Error ? error.message : '创建失败'
    }
  })

  createInputEl.addEventListener('input', () => {
    createErrorEl.textContent = ''
  })

  document.querySelectorAll('.theme-circle').forEach((btn, index) => {
    btn.addEventListener('click', () => {
      currentThemeIndex = index
      applyTheme(btn.dataset.theme)
    })
  })

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
