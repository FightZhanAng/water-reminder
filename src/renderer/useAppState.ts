import { useCallback, useEffect, useState } from 'react'
import type { AppState, DrinkSource, Settings } from '@shared/types'

export interface AppActions {
  state: AppState | null
  addDrink: (ml: number, source?: DrinkSource) => Promise<void>
  undo: () => Promise<void>
  patch: (patch: Partial<Settings>) => Promise<void>
  pause: (minutes: number) => Promise<void>
  resume: () => Promise<void>
}

/** 主进程是唯一真相源：这里只做「拉一次 + 订阅推送」 */
export function useAppState(): AppActions {
  const [state, setState] = useState<AppState | null>(null)

  useEffect(() => {
    let alive = true
    void window.api.getState().then((next) => {
      if (alive) setState(next)
    })
    const off = window.api.onState((next) => setState(next))
    return () => {
      alive = false
      off()
    }
  }, [])

  const addDrink = useCallback(async (ml: number, source: DrinkSource = 'manual') => {
    setState(await window.api.addDrink(ml, source))
  }, [])

  const undo = useCallback(async () => {
    setState(await window.api.undoLast())
  }, [])

  const patch = useCallback(async (next: Partial<Settings>) => {
    setState(await window.api.patchSettings(next))
  }, [])

  const pause = useCallback(async (minutes: number) => {
    setState(await window.api.pause(minutes))
  }, [])

  const resume = useCallback(async () => {
    setState(await window.api.resume())
  }, [])

  return { state, addDrink, undo, patch, pause, resume }
}
