import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Api, AppState, DrinkSource, Settings } from '../shared/types'

const api: Api = {
  getState: () => ipcRenderer.invoke('app:state'),
  addDrink: (ml: number, source: DrinkSource) => ipcRenderer.invoke('log:add', ml, source),
  undoLast: () => ipcRenderer.invoke('log:undo'),
  patchSettings: (patch: Partial<Settings>) => ipcRenderer.invoke('settings:patch', patch),
  hideFloat: () => ipcRenderer.invoke('float:hide'),
  extendFloat: () => ipcRenderer.invoke('float:extend'),
  previewFloat: () => ipcRenderer.invoke('float:preview'),
  reportFloatMetrics: (metrics) => ipcRenderer.send('float:metrics', metrics),
  pause: (minutes: number) => ipcRenderer.invoke('scheduler:pause', minutes),
  resume: () => ipcRenderer.invoke('scheduler:resume'),
  openDataDir: () => ipcRenderer.invoke('app:open-data-dir'),
  openMain: () => ipcRenderer.invoke('app:open-main'),
  quit: () => ipcRenderer.invoke('app:quit'),
  notifyFloatReady: () => ipcRenderer.send('float:ready'),
  onState: (cb) => {
    const handler = (_event: IpcRendererEvent, state: AppState): void => cb(state)
    ipcRenderer.on('state:changed', handler)
    return () => {
      ipcRenderer.off('state:changed', handler)
    }
  },
  onReminder: (cb) => {
    const handler = (): void => cb()
    ipcRenderer.on('reminder:fire', handler)
    return () => {
      ipcRenderer.off('reminder:fire', handler)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
