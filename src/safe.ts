import type { Logger } from "./log"

type ErrorLogger = Pick<Logger, "error">

export function safe<Args extends unknown[], Result>(
  log: ErrorLogger,
  name: string,
  fn: (...args: Args) => Result | Promise<Result>,
): (...args: Args) => Promise<Result | undefined> {
  return async (...args: Args): Promise<Result | undefined> => {
    try {
      return await fn(...args)
    } catch (error: unknown) {
      await log.error({
        msg: "hook failed",
        hook: name,
        error,
      })
      return undefined
    }
  }
}
