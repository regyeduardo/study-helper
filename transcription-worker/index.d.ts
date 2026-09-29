declare const worker: {
  fetch(request: Request, env: Record<string, unknown>, ctx?: { waitUntil(promise: Promise<unknown>): void }): Promise<Response>
}

export default worker
