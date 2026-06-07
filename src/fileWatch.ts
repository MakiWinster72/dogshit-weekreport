import { watch, type FSWatcher } from 'node:fs'
import { IGNORED_DIRS } from './files.js'

function isIgnoredRelativePath(relativePath: string): boolean {
  const parts = relativePath.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.some((part) => IGNORED_DIRS.has(part))
}

export function watchProjectDirectory(root: string, onChange: () => void): () => void {
  let debounceTimer: NodeJS.Timeout | null = null

  const schedule = () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      onChange()
    }, 250)
  }

  let watcher: FSWatcher
  try {
    watcher = watch(root, { recursive: true }, (_eventType, filename) => {
      if (filename && isIgnoredRelativePath(filename)) {
        return
      }
      schedule()
    })
  } catch {
    watcher = watch(root, schedule)
  }

  return () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
    }
    watcher.close()
  }
}
