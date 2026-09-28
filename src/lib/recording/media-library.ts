export interface LocalMedia {
  storedName: string
  name: string
  mime: string
  durationSeconds: number
  size: number
  createdAt: string
  fileIds: string[]
}

const INDEX_NAME = 'midias.json'

async function root(): Promise<FileSystemDirectoryHandle> {
  return navigator.storage.getDirectory()
}

async function readIndex(): Promise<LocalMedia[]> {
  try {
    const handle = await (await root()).getFileHandle(INDEX_NAME)
    return JSON.parse(await (await handle.getFile()).text()) as LocalMedia[]
  } catch {
    return []
  }
}

async function writeIndex(items: LocalMedia[]): Promise<void> {
  const handle = await (await root()).getFileHandle(INDEX_NAME, { create: true })
  const writable = await handle.createWritable()
  await writable.write(JSON.stringify(items))
  await writable.close()
}

let queue: Promise<unknown> = Promise.resolve()

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task)
  queue = next.catch(() => undefined)
  return next
}

export async function listLocalMedia(): Promise<LocalMedia[]> {
  const items = await readIndex()
  return [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function addLocalMedia(item: LocalMedia): Promise<void> {
  return serialized(async () => writeIndex([...(await readIndex()).filter(entry => entry.storedName !== item.storedName), item]))
}

export function linkLocalMedia(storedName: string, fileId: string): Promise<void> {
  return serialized(async () =>
    writeIndex((await readIndex()).map(entry => (entry.storedName === storedName && !entry.fileIds.includes(fileId) ? { ...entry, fileIds: [...entry.fileIds, fileId] } : entry))),
  )
}

export async function readLocalMedia(item: LocalMedia): Promise<File> {
  const handle = await (await root()).getFileHandle(item.storedName)
  const stored = await handle.getFile()
  return new File([stored], item.name, { type: item.mime || stored.type })
}

export function removeLocalMedia(storedName: string): Promise<void> {
  return serialized(async () => {
    await (await root()).removeEntry(storedName).catch(() => undefined)
    await writeIndex((await readIndex()).filter(entry => entry.storedName !== storedName))
  })
}
