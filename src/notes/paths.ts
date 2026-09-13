import { createHash } from "node:crypto"
import { dirname } from "node:path"

export function cwdKey(cwd: string): string {
  return createHash("sha1").update(cwd).digest("hex")
}

export function cwdParents(cwd: string): readonly string[] {
  const parents: string[] = []
  let current = cwd
  while (true) {
    parents.push(current)
    const parent = dirname(current)
    if (parent === current) return parents
    current = parent
  }
}
