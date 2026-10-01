import { useEffect, useState } from 'react'

// Subscribes the sidetab overlay window to mainWindow's state snapshots.
// On mount we pull the latest cached snapshot (in case mainWindow already
// pushed before the overlay existed), then keep listening for new pushes.
// No writes here — see SidetabOverlay for the Stop/Send forwarders.
export function useOverlaySync(): OverlaySnapshot | null {
  const [snapshot, setSnapshot] = useState<OverlaySnapshot | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.twixy.overlayRequestSync().then(snap => {
      if (!cancelled && snap) setSnapshot(snap)
    })
    const off = window.twixy.onOverlaySync(s => setSnapshot(s))
    return () => { cancelled = true; off() }
  }, [])

  return snapshot
}
