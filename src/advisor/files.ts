import { join } from "node:path"
import type { Logger } from "../log"

export async function readProjectFiles(directory: string, readFile: (path: string) => Promise<string>, log: Logger) {
  const read = async (name: string): Promise<string | undefined> => {
    try {
      return await readFile(join(directory, name))
    } catch (error) {
      await log.debug({ msg: "advisor context file unavailable", name, error })
      return undefined
    }
  }
  const [agentsMd, contextMd] = await Promise.all([read("AGENTS.md"), read("CONTEXT.md")])
  return {
    ...(agentsMd === undefined ? {} : { agentsMd }),
    ...(contextMd === undefined ? {} : { contextMd }),
  }
}
