export type Timers = Readonly<{
  setTimeout: (callback: () => void, ms: number) => unknown
  clearTimeout: (timer: unknown) => void
}>

export const systemTimers: Timers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => {
    if (typeof timer === "number" || (typeof timer === "object" && timer !== null)) {
      clearTimeout(timer as ReturnType<typeof setTimeout>)
    }
  },
}

/** Bounds the caller, without claiming the underlying operation was cancelled. */
export async function within<T>(work: Promise<T>, ms: number, timers: Timers = systemTimers) {
  let timer: unknown
  const timeout = new Promise<{ completed: false }>((resolve) => {
    timer = timers.setTimeout(() => resolve({ completed: false }), Math.max(0, ms))
  })
  try {
    return await Promise.race([work.then((value) => ({ completed: true as const, value })), timeout])
  } finally {
    if (timer !== undefined) timers.clearTimeout(timer)
  }
}
