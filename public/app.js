const projectPathEl = document.getElementById('project-path')
const fileTreeEl = document.getElementById('file-tree')
const fileTreeNavAllBtn = document.getElementById('file-tree-nav-all')
const fileTreeNavUpBtn = document.getElementById('file-tree-nav-up')
const fileTreeNavPathEl = document.getElementById('file-tree-nav-path')
const editorTabEl = document.getElementById('editor-tab')
const editorBodyEl = document.getElementById('editor-body')
const editorToolbarEl = document.getElementById('editor-toolbar')
const editorModeViewBtn = document.getElementById('editor-mode-view')
const editorModeEditBtn = document.getElementById('editor-mode-edit')
const editorSaveBtn = document.getElementById('editor-save')
const editorFullscreenBtn = document.getElementById('editor-fullscreen')
const editorPaneEl = document.querySelector('.editor-pane')
const workspaceEl = document.querySelector('.workspace')
const sidebarEl = document.querySelector('.sidebar')
const resizerSidebarEl = document.getElementById('resizer-sidebar')
const resizerTerminalEl = document.getElementById('resizer-terminal')
const shellLabelEl = document.getElementById('shell-label')
const terminalStatusEl = document.getElementById('terminal-status')
const terminalModeShellBtn = document.getElementById('terminal-mode-shell')
const terminalModeClaudeBtn = document.getElementById('terminal-mode-claude')
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
let isFullscreen = false

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

/** @type {'shell' | 'claude'} */
let terminalProfile = 'shell'

function escapeHtml(text) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

const MARKDOWN_EXTENSIONS = ['.md', '.markdown', '.mdx']
const MARKDOWN_TASK_ITEM_RE = /^\s*[-*+]\s+\[[ xX]\]/

const THEMES = ['dark', 'light', 'one-dark']
const DEFAULT_THEME = 'one-dark'
const THEME_STORAGE_KEY = 'dwr-theme'
const LAST_FILE_STORAGE_KEY = 'dwr-last-file'
const DEFAULT_TREE_PATH = 'work'
const FOCUS_ROOT_NAMES = new Set(['work', 'CLAUDE.md', '.claude'])
let currentThemeIndex = THEMES.indexOf(DEFAULT_THEME)

/** @type {string} */
let treeViewPath = DEFAULT_TREE_PATH

/** @type {'focus' | 'full'} */
let treeScope = 'focus'

/** @type {Map<string, string>} */
const treeDirectoryFingerprints = new Map()

function getCssVariable(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function applyTheme(themeName, options = { persist: true }) {
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

  if (options.persist) {
    localStorage.setItem(THEME_STORAGE_KEY, themeName)
  }
}

function loadStoredTheme() {
  const saved = localStorage.getItem(THEME_STORAGE_KEY)
  const themeName = saved && THEMES.includes(saved) ? saved : DEFAULT_THEME
  currentThemeIndex = THEMES.indexOf(themeName)
  applyTheme(themeName, { persist: false })
}

function toggleTheme() {
  currentThemeIndex = (currentThemeIndex + 1) % THEMES.length
  applyTheme(THEMES[currentThemeIndex])
}

function isMarkdownFile(path) {
  const lower = path.toLowerCase()
  return MARKDOWN_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

function collectMarkdownTaskLineIndexes(content) {
  /** @type {number[]} */
  const indexes = []
  content.split('\n').forEach((line, index) => {
    if (MARKDOWN_TASK_ITEM_RE.test(line)) {
      indexes.push(index)
    }
  })
  return indexes
}

function isMarkdownTaskLine(line) {
  return MARKDOWN_TASK_ITEM_RE.test(line)
}

function setMarkdownTaskLineChecked(line, checked) {
  return line.replace(/^(\s*[-*+]\s+\[)[ xX](\])/, `$1${checked ? 'x' : ' '}$2`)
}

function enhanceMarkdownTaskListHtml(content, html) {
  const taskLineIndexes = collectMarkdownTaskLineIndexes(content)
  if (taskLineIndexes.length === 0) {
    return html
  }

  const lines = content.split('\n')
  let taskIndex = 0

  return html.replace(/<input\b[^>]*\btype="checkbox"[^>]*>/gi, (match) => {
    if (taskIndex >= taskLineIndexes.length) {
      return match
    }

    const lineIndex = taskLineIndexes[taskIndex]
    const line = lines[lineIndex] ?? ''
    const checked = /^\s*[-*+]\s+\[[xX]\]/.test(line)
    taskIndex += 1

    return `<input type="checkbox" class="md-task-checkbox" data-task-line="${lineIndex}"${checked ? ' checked' : ''}>`
  })
}

function toggleMarkdownTaskAtLine(lineIndex, checked) {
  const lines = draftFileContent.split('\n')
  const line = lines[lineIndex]
  if (!line || !isMarkdownTaskLine(line)) {
    return false
  }

  const nextLine = setMarkdownTaskLineChecked(line, checked)
  if (nextLine === line) {
    return false
  }

  lines[lineIndex] = nextLine
  draftFileContent = lines.join('\n')
  updateEditorToolbar()
  return true
}

function renderMarkdown(content) {
  if (typeof marked === 'undefined') {
    return escapeHtml(content)
  }

  marked.setOptions({
    gfm: true,
    breaks: true,
  })

  let html = marked.parse(content)
  html = enhanceMarkdownTaskListHtml(content, html)

  if (typeof DOMPurify !== 'undefined') {
    return DOMPurify.sanitize(html, {
      ADD_ATTR: ['data-task-line'],
    })
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

function toggleFullscreen() {
  isFullscreen = !isFullscreen
  if (isFullscreen) {
    editorPaneEl.classList.add('fullscreen')
    workspaceEl.classList.add('is-editor-fullscreen')
    editorFullscreenBtn.querySelector('.icon-enter').style.display = 'none'
    editorFullscreenBtn.querySelector('.icon-exit').style.display = 'block'
    editorFullscreenBtn.title = '退出全屏 (Alt+F)'
  } else {
    editorPaneEl.classList.remove('fullscreen')
    workspaceEl.classList.remove('is-editor-fullscreen')
    editorFullscreenBtn.querySelector('.icon-enter').style.display = 'block'
    editorFullscreenBtn.querySelector('.icon-exit').style.display = 'none'
    editorFullscreenBtn.title = '全屏 (Alt+F)'
    requestAnimationFrame(() => {
      resizeTerminal()
    })
  }
}

const PANEL_WIDTH_STORAGE_KEY = 'dwr-panel-widths'
const PANEL_LIMITS = {
  sidebar: { min: 180, max: 480, defaultWidth: 240 },
  terminal: { min: 240, max: 560, defaultWidth: 320 },
  editor: { min: 280 },
}

function clampPanelWidth(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function loadPanelWidths() {
  try {
    const saved = JSON.parse(localStorage.getItem(PANEL_WIDTH_STORAGE_KEY) ?? '{}')
    return {
      sidebar: clampPanelWidth(
        Number(saved.sidebar) || PANEL_LIMITS.sidebar.defaultWidth,
        PANEL_LIMITS.sidebar.min,
        PANEL_LIMITS.sidebar.max,
      ),
      terminal: clampPanelWidth(
        Number(saved.terminal) || PANEL_LIMITS.terminal.defaultWidth,
        PANEL_LIMITS.terminal.min,
        PANEL_LIMITS.terminal.max,
      ),
    }
  } catch {
    return {
      sidebar: PANEL_LIMITS.sidebar.defaultWidth,
      terminal: PANEL_LIMITS.terminal.defaultWidth,
    }
  }
}

function savePanelWidths(widths) {
  localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, JSON.stringify(widths))
}

function applyPanelWidths(widths) {
  document.documentElement.style.setProperty('--sidebar-width', `${widths.sidebar}px`)
  document.documentElement.style.setProperty('--terminal-width', `${widths.terminal}px`)
  sidebarEl.style.width = `${widths.sidebar}px`
  terminalPaneEl.style.width = `${widths.terminal}px`
}

function getWorkspaceInnerWidth() {
  const resizerWidth = 8
  return workspaceEl.clientWidth - resizerWidth
}

function constrainPanelWidths(widths) {
  const total = getWorkspaceInnerWidth()
  let sidebar = clampPanelWidth(widths.sidebar, PANEL_LIMITS.sidebar.min, PANEL_LIMITS.sidebar.max)
  let terminal = clampPanelWidth(widths.terminal, PANEL_LIMITS.terminal.min, PANEL_LIMITS.terminal.max)

  const editorWidth = total - sidebar - terminal
  if (editorWidth < PANEL_LIMITS.editor.min) {
    const deficit = PANEL_LIMITS.editor.min - editorWidth
    const terminalShrink = Math.min(deficit, terminal - PANEL_LIMITS.terminal.min)
    terminal -= terminalShrink
    const remaining = deficit - terminalShrink
    if (remaining > 0) {
      sidebar = Math.max(PANEL_LIMITS.sidebar.min, sidebar - remaining)
    }
  }

  return { sidebar, terminal }
}

function bindPanelResizer(resizerEl, onDrag, onStop) {
  resizerEl.addEventListener('mousedown', (event) => {
    event.preventDefault()
    document.body.classList.add('is-resizing')
    resizerEl.classList.add('is-active')

    const stop = () => {
      document.body.classList.remove('is-resizing')
      resizerEl.classList.remove('is-active')
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', stop)
      onStop()
      requestAnimationFrame(() => {
        resizeTerminal()
      })
    }

    const move = (moveEvent) => {
      onDrag(moveEvent.movementX)
    }

    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', stop)
  })
}

function initPanelResizers() {
  const widths = loadPanelWidths()
  applyPanelWidths(constrainPanelWidths(widths))

  const persistWidths = () => {
    savePanelWidths(widths)
  }

  bindPanelResizer(resizerSidebarEl, (deltaX) => {
    const next = constrainPanelWidths({
      sidebar: widths.sidebar + deltaX,
      terminal: widths.terminal,
    })
    widths.sidebar = next.sidebar
    widths.terminal = next.terminal
    applyPanelWidths(next)
    requestAnimationFrame(() => {
      resizeTerminal()
    })
  }, persistWidths)

  bindPanelResizer(resizerTerminalEl, (deltaX) => {
    const next = constrainPanelWidths({
      sidebar: widths.sidebar,
      terminal: widths.terminal - deltaX,
    })
    widths.sidebar = next.sidebar
    widths.terminal = next.terminal
    applyPanelWidths(next)
    requestAnimationFrame(() => {
      resizeTerminal()
    })
  }, persistWidths)

  window.addEventListener('resize', () => {
    const next = constrainPanelWidths(widths)
    widths.sidebar = next.sidebar
    widths.terminal = next.terminal
    applyPanelWidths(next)
    requestAnimationFrame(() => {
      resizeTerminal()
    })
  })
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
  textarea.setSelectionRange(0, 0)
  textarea.scrollTop = 0
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

function toggleEditorMode() {
  if (!activeFilePath || activeFileIsBinary) {
    return
  }
  setEditorMode(editorMode === 'view' ? 'edit' : 'view')
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
  if (isFullscreen) {
    toggleFullscreen()
  }
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
    localStorage.setItem(LAST_FILE_STORAGE_KEY, path)
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

function filterRootEntries(entries) {
  if (treeScope === 'full') {
    return entries
  }
  return entries.filter((entry) => FOCUS_ROOT_NAMES.has(entry.name))
}

function setTreeScope(scope) {
  treeScope = scope
  updateTreeNavUI()
}

async function showFullProjectTree() {
  setTreeScope('full')
  setTreeViewPath('')
  await reloadDirectory('', fileTreeEl, 0)
  treeDirectoryFingerprints.set('', await fetchDirectoryFingerprint(''))
}

async function showFocusProjectTree() {
  setTreeScope('focus')
  await reloadDirectory('', fileTreeEl, 0)
  treeDirectoryFingerprints.set('', await fetchDirectoryFingerprint(''))

  const defaultPath = await checkDirectoryExists(DEFAULT_TREE_PATH) ? DEFAULT_TREE_PATH : ''
  if (defaultPath) {
    await expandPathInTree(defaultPath)
  }
  setTreeViewPath(defaultPath)
}

async function toggleTreeScope() {
  if (treeScope === 'focus') {
    await showFullProjectTree()
    return
  }
  await showFocusProjectTree()
}

function setTreeViewPath(path) {
  treeViewPath = path
  updateTreeNavUI()
}

function navigateTreeUp() {
  if (!treeViewPath) {
    return
  }
  setTreeViewPath(getParentPath(treeViewPath))
}

function updateTreeNavUI() {
  if (!fileTreeNavAllBtn || !fileTreeNavPathEl) {
    return
  }

  if (treeScope === 'full') {
    fileTreeNavAllBtn.classList.add('is-focus-return')
    fileTreeNavAllBtn.classList.remove('is-scope-all')
    fileTreeNavAllBtn.title = '返回 work 聚焦视图'
    fileTreeNavAllBtn.innerHTML =
      'work<span class="file-tree-nav-back" aria-hidden="true">←</span>'
  } else {
    fileTreeNavAllBtn.classList.remove('is-focus-return')
    fileTreeNavAllBtn.classList.add('is-scope-all')
    fileTreeNavAllBtn.title = '显示整个项目'
    fileTreeNavAllBtn.textContent = '全部'
  }

  fileTreeNavPathEl.textContent =
    treeViewPath || (treeScope === 'full' ? '项目根目录' : 'work为周报文件夹')
  if (fileTreeNavUpBtn) {
    fileTreeNavUpBtn.disabled = !treeViewPath
  }
}

async function reloadDirectory(path, container, depth) {
  container.innerHTML = ''
  await loadDirectory(path, container, depth)
}

async function loadDirectory(path, container, depth) {
  const data = await fetchJson(`/api/files?path=${encodeURIComponent(path)}`)
  const entries = path === '' ? filterRootEntries(data.entries) : data.entries

  for (const entry of entries) {
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
        setTreeViewPath(entry.path)
        const expanded = node.classList.toggle('expanded')
        updateDirectoryRowIcon(row, expanded)

        if (expanded && !node.dataset.loaded) {
          node.dataset.loaded = '1'
          try {
            await loadDirectory(entry.path, childContainer, depth + 1)
            treeDirectoryFingerprints.set(entry.path, await fetchDirectoryFingerprint(entry.path))
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

function collectExpandedDirectoryPaths() {
  /** @type {string[]} */
  const paths = []
  fileTreeEl.querySelectorAll('.tree-node.directory.expanded').forEach((node) => {
    const row = node.querySelector('.tree-row.directory')
    const path = row?.dataset.path
    if (path !== undefined) {
      paths.push(path)
    }
  })
  return paths.sort((a, b) => a.split('/').length - b.split('/').length)
}

async function expandAndLoadDirectory(path) {
  const row = fileTreeEl.querySelector(`.tree-row.directory[data-path="${CSS.escape(path)}"]`)
  const node = row?.closest('.tree-node')
  const childContainer = node?.querySelector('.tree-children')
  if (!row || !node || !childContainer) {
    return
  }

  const depth = Number(row.style.getPropertyValue('--depth') || '0')
  node.classList.add('expanded')
  node.dataset.loaded = '1'
  updateDirectoryRowIcon(row, true)
  await reloadDirectory(path, childContainer, depth + 1)
  treeDirectoryFingerprints.set(path, await fetchDirectoryFingerprint(path))
}

async function expandPathInTree(path) {
  if (!path) {
    return
  }

  const segments = path.split('/')
  let current = ''
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment
    await expandAndLoadDirectory(current)
  }
}

function getDirectoryContainerInfo(path) {
  if (!path) {
    return { container: fileTreeEl, depth: 0 }
  }

  const row = fileTreeEl.querySelector(`.tree-row.directory[data-path="${CSS.escape(path)}"]`)
  const node = row?.closest('.tree-node')
  const container = node?.querySelector('.tree-children')
  if (!row || !container) {
    return null
  }

  return {
    container,
    depth: Number(row.style.getPropertyValue('--depth') || '0') + 1,
  }
}

async function reloadDirectoryContainer(path) {
  const expandedPaths = collectExpandedDirectoryPaths()
  const info = getDirectoryContainerInfo(path)
  if (!info) {
    return
  }

  await reloadDirectory(path, info.container, info.depth)

  for (const expandedPath of expandedPaths) {
    if (!path || expandedPath === path || expandedPath.startsWith(`${path}/`)) {
      await expandAndLoadDirectory(expandedPath)
    }
  }

  treeDirectoryFingerprints.set(path, await fetchDirectoryFingerprint(path))
}

async function refreshTreeAt(parentPath) {
  if (!parentPath) {
    const expandedPaths = collectExpandedDirectoryPaths()
    await reloadDirectory('', fileTreeEl, 0)
    for (const expandedPath of expandedPaths) {
      await expandAndLoadDirectory(expandedPath)
    }
    treeDirectoryFingerprints.set('', await fetchDirectoryFingerprint(''))
    return
  }

  const row = fileTreeEl.querySelector(`.tree-row.directory[data-path="${CSS.escape(parentPath)}"]`)
  const node = row?.closest('.tree-node')
  if (!row || !node) {
    await refreshTreeAt('')
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
  treeDirectoryFingerprints.set(parentPath, await fetchDirectoryFingerprint(parentPath))
}

async function checkDirectoryExists(path) {
  try {
    await fetchJson(`/api/files?path=${encodeURIComponent(path)}`)
    return true
  } catch {
    return false
  }
}

function fingerprintEntries(entries) {
  return entries.map((entry) => `${entry.type}:${entry.path}`).join('\n')
}

async function fetchDirectoryFingerprint(path) {
  const data = await fetchJson(`/api/files?path=${encodeURIComponent(path)}`)
  const entries = path === '' ? filterRootEntries(data.entries) : data.entries
  return fingerprintEntries(entries)
}

async function initFileTree() {
  fileTreeEl.innerHTML = '<div class="editor-empty" style="height:auto;padding:16px">加载文件树…</div>'

  try {
    fileTreeEl.innerHTML = ''
    setTreeScope('focus')
    await loadDirectory('', fileTreeEl, 0)
    treeDirectoryFingerprints.set('', await fetchDirectoryFingerprint(''))

    const defaultPath = await checkDirectoryExists(DEFAULT_TREE_PATH) ? DEFAULT_TREE_PATH : ''
    if (defaultPath) {
      await expandPathInTree(defaultPath)
    }
    setTreeViewPath(defaultPath)
  } catch (error) {
    fileTreeEl.innerHTML = `<div class="editor-empty" style="height:auto;padding:16px;color:#f48771">${escapeHtml(error instanceof Error ? error.message : '加载失败')}</div>`
  }
}

/** @type {WebSocket | null} */
let fileTreeSocket = null

/** @type {ReturnType<typeof setTimeout> | null} */
let fileTreeReconnectTimer = null

/** @type {ReturnType<typeof setTimeout> | null} */
let fileTreeRefreshTimer = null

let fileTreeRefreshing = false

async function refreshFileTree() {
  if (fileTreeRefreshing || !createDialogEl.classList.contains('hidden')) {
    return
  }

  fileTreeRefreshing = true
  try {
    const watchPaths = ['', ...collectExpandedDirectoryPaths()]
    /** @type {string[]} */
    const changedPaths = []

    for (const path of watchPaths) {
      const nextFingerprint = await fetchDirectoryFingerprint(path)
      if (treeDirectoryFingerprints.get(path) !== nextFingerprint) {
        changedPaths.push(path)
      }
    }

    if (changedPaths.length === 0) {
      return
    }

    changedPaths.sort((a, b) => a.split('/').length - b.split('/').length)

    for (const path of changedPaths) {
      await reloadDirectoryContainer(path)
    }

    if (activeFilePath) {
      markActiveFile(activeFilePath)
    }
  } catch {
    // 后台刷新失败时静默忽略，避免打断当前操作
  } finally {
    fileTreeRefreshing = false
  }
}

function scheduleFileTreeRefresh() {
  if (fileTreeRefreshTimer) {
    clearTimeout(fileTreeRefreshTimer)
  }
  fileTreeRefreshTimer = setTimeout(() => {
    fileTreeRefreshTimer = null
    void refreshFileTree()
  }, 800)
}

function connectFileTreeWatch() {
  if (fileTreeReconnectTimer) {
    clearTimeout(fileTreeReconnectTimer)
    fileTreeReconnectTimer = null
  }

  if (fileTreeSocket) {
    fileTreeSocket.close()
    fileTreeSocket = null
  }

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  fileTreeSocket = new WebSocket(`${protocol}//${location.host}/ws/tree`)

  fileTreeSocket.addEventListener('message', (event) => {
    let message
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }

    if (message.type === 'changed') {
      scheduleFileTreeRefresh()
    }
  })

  fileTreeSocket.addEventListener('close', () => {
    fileTreeReconnectTimer = setTimeout(connectFileTreeWatch, 3000)
  })
}

function isPathInFocusTree(path) {
  if (!path) {
    return true
  }
  if (path === 'CLAUDE.md') {
    return true
  }
  if (path === 'work' || path.startsWith('work/')) {
    return true
  }
  if (path === '.claude' || path.startsWith('.claude/')) {
    return true
  }
  return false
}

async function restoreLastOpenedFile() {
  const path = localStorage.getItem(LAST_FILE_STORAGE_KEY)
  if (!path) {
    return
  }

  if (!isPathInFocusTree(path)) {
    await showFullProjectTree()
  }

  await expandPathInTree(getParentPath(path))
  setTreeViewPath(getParentPath(path))

  try {
    await openFile(path)
  } catch {
    localStorage.removeItem(LAST_FILE_STORAGE_KEY)
  }
}

function setTerminalStatus(state) {
  terminalStatusEl.className = `status-dot ${state}`
}

function updateTerminalModeUI() {
  terminalModeShellBtn?.classList.toggle('active', terminalProfile === 'shell')
  terminalModeClaudeBtn?.classList.toggle('active', terminalProfile === 'claude')
}

function clearTerminalScreen() {
  term?.clear()
  term?.reset()
}

function applyTerminalSession(message) {
  if (message.profile === 'shell' || message.profile === 'claude') {
    terminalProfile = message.profile
    updateTerminalModeUI()
  }

  clearTerminalScreen()
  if (typeof message.data === 'string' && message.data) {
    term?.write(message.data)
  }

  shellLabelEl.textContent = message.label ?? message.shell ?? '—'
  setTerminalStatus(message.exitCode == null ? 'connected' : 'error')

  requestAnimationFrame(() => {
    resizeTerminal()
    term?.focus()
  })
}

function setTerminalMode(profile) {
  if (terminalProfile === profile) {
    term?.focus()
    return
  }

  terminalProfile = profile
  updateTerminalModeUI()

  if (terminalSocket?.readyState === WebSocket.OPEN) {
    fitAddon?.fit()
    sendTerminal({
      type: 'switch',
      profile,
      cols: term?.cols ?? 80,
      rows: term?.rows ?? 24,
    })
    return
  }

  connectTerminal()
}

function toggleTerminalMode() {
  setTerminalMode(terminalProfile === 'shell' ? 'claude' : 'shell')
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
    fontFamily: "'Cousine Nerd Font Mono', 'HarmonyOS Sans SC', Menlo, Monaco, 'Courier New', monospace",
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
  terminalSocket = new WebSocket(
    `${protocol}//${location.host}/ws?profile=${encodeURIComponent(terminalProfile)}`,
  )

  terminalSocket.addEventListener('open', () => {
    setTerminalStatus('connected')
    updateTerminalModeUI()
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
      applyTerminalSession(message)
      return
    }

    if (message.type === 'switch') {
      applyTerminalSession(message)
      return
    }

    if (message.type === 'output') {
      if (!message.profile || message.profile === terminalProfile) {
        term?.write(message.data)
      }
      return
    }

    if (message.type === 'exit') {
      if (!message.profile || message.profile === terminalProfile) {
        setTerminalStatus('error')
      }
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
  loadStoredTheme()
  updateTerminalModeUI()
  initTerminal()
  initPanelResizers()

  rootCreateFolderBtn.addEventListener('click', () => {
    openCreateDialog(treeViewPath, 'directory')
  })
  rootCreateFileBtn.addEventListener('click', () => {
    openCreateDialog(treeViewPath, 'file')
  })

  fileTreeNavAllBtn?.addEventListener('click', () => {
    void toggleTreeScope()
  })

  fileTreeNavUpBtn?.addEventListener('click', () => {
    navigateTreeUp()
  })

  terminalModeShellBtn?.addEventListener('click', () => {
    setTerminalMode('shell')
  })

  terminalModeClaudeBtn?.addEventListener('click', () => {
    setTerminalMode('claude')
  })

  editorFullscreenBtn.addEventListener('click', () => {
    toggleFullscreen()
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

  editorBodyEl.addEventListener('change', (event) => {
    const target = event.target
    if (!(target instanceof HTMLInputElement) || !target.classList.contains('md-task-checkbox')) {
      return
    }

    if (editorMode !== 'view' || !activeFilePath || !isMarkdownFile(activeFilePath)) {
      return
    }

    const lineIndex = Number(target.dataset.taskLine)
    if (Number.isNaN(lineIndex)) {
      return
    }

    const checked = target.checked
    if (!toggleMarkdownTaskAtLine(lineIndex, checked)) {
      target.checked = !checked
    }
  })

  document.addEventListener('keydown', (event) => {
    if (!event.altKey || event.ctrlKey || event.metaKey) {
      return
    }

    const key = event.key.toLowerCase()

    if (key === 'd') {
      event.preventDefault()
      toggleTheme()
      return
    }

    if (key === 's') {
      event.preventDefault()
      toggleTerminalMode()
      return
    }

    if (key === 'e') {
      if (!activeFilePath || activeFileIsBinary) {
        return
      }
      event.preventDefault()
      toggleEditorMode()
      return
    }

    if (key === 'f') {
      event.preventDefault()
      if (activeFilePath && !activeFileIsBinary) {
        toggleFullscreen()
      }
    }
  }, true)

  document.addEventListener('keydown', (event) => {
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

  void initFileTree().then(async () => {
    await restoreLastOpenedFile()
    connectFileTreeWatch()
  })
}

init()
