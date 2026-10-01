import { useState, useEffect, useCallback } from 'react'

// `projectDir` is the user-picked project ROOT (e.g. ~/MyMarketing).
// The actual personal workspace that the agent reads/writes is <root>/user,
// exposed separately via getWorkspace / the IPC helpers. `collabMode` tells
// the UI whether this project is solo, Dropbox/iCloud-synced, or server-synced.
export function useProjectDir() {
  const [projectDir, setProjectDir] = useState<string | null>(null)
  const [collabMode, setCollabMode] = useState<CollabMode>('solo')
  const [projectConfig, setProjectConfig] = useState<ProjectConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [setting, setSetting] = useState(false)

  const refreshCollab = useCallback(async () => {
    const [mode, cfg] = await Promise.all([
      window.twixy.getCollabMode(),
      window.twixy.getProjectConfig(),
    ])
    setCollabMode(mode)
    setProjectConfig(cfg)
  }, [])

  useEffect(() => {
    Promise.all([
      window.twixy.getProjectDir(),
      window.twixy.getCollabMode(),
      window.twixy.getProjectConfig(),
    ]).then(([dir, mode, cfg]) => {
      setProjectDir(dir)
      setCollabMode(mode)
      setProjectConfig(cfg)
      setLoading(false)
    })
  }, [])

  useEffect(() => {
    return window.twixy.onProjectDirChanged(dir => {
      setProjectDir(dir)
      // Project changed → collab mode + config may differ. Refresh.
      void refreshCollab()
    })
  }, [refreshCollab])

  const pickAndSet = useCallback(async (): Promise<boolean> => {
    setSetting(true)
    try {
      const picked = await window.twixy.pickProjectDir()
      if (!picked.ok || !picked.dir) return false
      const result = await window.twixy.setProjectDir(picked.dir)
      if (result.ok) setProjectDir(picked.dir)
      return result.ok
    } finally {
      setSetting(false)
    }
  }, [])

  const folderName = projectDir
    ? projectDir.split(/[\\/]/).filter(Boolean).pop() ?? projectDir
    : null

  return {
    projectDir, folderName, collabMode, projectConfig,
    loading, setting, pickAndSet,
  }
}
