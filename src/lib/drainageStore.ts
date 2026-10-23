import type { Flowline } from '../api/nhd'

/**
 * Drainage (USGS NHD flowlines) saved on the device per forecast block, in IndexedDB: the data almost never
 * changes, and the live query took 12–31 s per block (Oct 22: one timed out at 30 s), so a saved block skips the
 * request entirely. Entries expire after 30 days. Nothing here is required: every failure reads as "not saved".
 */
export const DRAINAGE_TTL_MS = 30 * 24 * 3_600_000
const DB = 'stormscope'
const STORE = 'drainage'

export interface SavedDrainage {
  key: string
  at: number
  lines: Flowline[]
  truncated: boolean
  /** Size of the saved entry as JSON (bytes), reported on the Flood page. */
  bytes: number
}

let dbPromise: Promise<IDBDatabase | null> | null = null
function open(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null)
      const req = indexedDB.open(DB, 1)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'key' })
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbPromise
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return open().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null)
        try {
          const req = run(db.transaction(STORE, mode).objectStore(STORE))
          req.onsuccess = () => resolve(req.result ?? null)
          req.onerror = () => resolve(null)
        } catch {
          resolve(null)
        }
      }),
  )
}

/** The saved drainage for a block, or null when none is saved or it is older than 30 days (then it is removed). */
export async function loadDrainage(key: string, now = Date.now()): Promise<SavedDrainage | null> {
  const row = await tx<SavedDrainage>('readonly', (s) => s.get(key))
  if (!row || typeof row.at !== 'number' || !Array.isArray(row.lines)) return null
  if (now - row.at > DRAINAGE_TTL_MS) {
    void tx('readwrite', (s) => s.delete(key))
    return null
  }
  return row
}

/** Save a block's drainage; returns the entry as saved (with its size), or null when it could not be saved. */
export async function saveDrainage(key: string, lines: Flowline[], truncated: boolean, now = Date.now()): Promise<SavedDrainage | null> {
  const row: SavedDrainage = { key, at: now, lines, truncated, bytes: 0 }
  row.bytes = JSON.stringify(row).length
  const ok = await tx('readwrite', (s) => s.put(row))
  return ok === null ? null : row
}
