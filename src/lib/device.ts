import type { StampedChange } from '@/types/domain'
import { newId, nowIso } from '@/lib/ids'

const DEVICE_KEY = 'study-helper:device'

export interface Device {
  id: string
  name: string
}

function browserName(agent: string): string {
  if (/Edg\//.test(agent)) return 'Edge'
  if (/Firefox\//.test(agent)) return 'Firefox'
  if (/Chrome\//.test(agent)) return 'Chrome'
  if (/Safari\//.test(agent)) return 'Safari'
  return 'Navegador'
}

function systemName(agent: string): string {
  if (/iPhone|iPad/.test(agent)) return 'iPhone'
  if (/Android/.test(agent)) return 'Android'
  if (/Windows/.test(agent)) return 'Windows'
  if (/Mac OS X/.test(agent)) return 'macOS'
  if (/Linux/.test(agent)) return 'Linux'
  return 'sistema desconhecido'
}

export function describeDevice(agent: string = navigator.userAgent): string {
  return `${browserName(agent)} · ${systemName(agent)}`
}

export function currentDevice(): Device {
  try {
    const saved = localStorage.getItem(DEVICE_KEY)
    if (saved) return JSON.parse(saved) as Device
  } catch {
    return { id: 'sem-armazenamento', name: describeDevice() }
  }
  const device = { id: newId(), name: describeDevice() }
  try {
    localStorage.setItem(DEVICE_KEY, JSON.stringify(device))
  } catch {
    return device
  }
  return device
}

export function stamp(): StampedChange {
  const device = currentDevice()
  return { at: nowIso(), deviceId: device.id, deviceName: device.name }
}
