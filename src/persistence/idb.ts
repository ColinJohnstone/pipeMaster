import type { Score } from '../core/model/types'
import { parseBww, serializeBww } from '../core/bww/bww'
import { exportMidi } from '../core/midi/export'
import { exportMusicXml } from '../core/musicxml/export'

const DB_NAME = 'pipemaster'
const STORE = 'files'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function put(key: string, value: unknown): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

async function get<T>(key: string): Promise<T | undefined> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
    req.onsuccess = () => resolve(req.result as T | undefined)
    req.onerror = () => reject(req.error)
  })
}

export const saveAutosave = (score: Score) => put('autosave', score)
export const loadAutosave = () => get<Score>('autosave')

// -- File open/save ----------------------------------------------------------

export function downloadScore(score: Score) {
  const blob = new Blob([JSON.stringify(score, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${score.title.replace(/[^\w\- ]+/g, '') || 'tune'}.pms`
  a.click()
  URL.revokeObjectURL(a.href)
}

function download(filename: string, blob: Blob) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

const safeName = (title: string) => title.replace(/[^\w\- ]+/g, '') || 'tune'

export function downloadBww(score: Score) {
  download(`${safeName(score.title)}.bww`, new Blob([serializeBww(score)], { type: 'text/plain' }))
}

export function downloadMidi(score: Score) {
  const bytes = exportMidi(score, { drone: true })
  const buffer = bytes.buffer.slice(0) as ArrayBuffer
  download(`${safeName(score.title)}.mid`, new Blob([buffer], { type: 'audio/midi' }))
}

export function downloadMusicXml(score: Score) {
  download(
    `${safeName(score.title)}.musicxml`,
    new Blob([exportMusicXml(score)], { type: 'application/vnd.recordare.musicxml+xml' }),
  )
}

export interface OpenedFile {
  score: Score
  warnings: string[]
}

export function pickScoreFile(): Promise<OpenedFile | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.pms,.json,.bww'
    input.style.display = 'none'
    input.dataset.role = 'open-file'
    document.body.appendChild(input)
    input.onchange = async () => {
      const file = input.files?.[0]
      input.remove()
      if (!file) return resolve(null)
      const text = await file.text()
      try {
        if (/\.bww$/i.test(file.name)) {
          resolve(parseBww(text))
          return
        }
        const parsed = JSON.parse(text) as Score
        if (!parsed.parts || !parsed.timeSig) throw new Error('not a pipeMaster file')
        resolve({ score: parsed, warnings: [] })
      } catch {
        alert('Could not read that file — expected a pipeMaster .pms or Bagpipe Music Writer .bww file.')
        resolve(null)
      }
    }
    input.click()
  })
}
