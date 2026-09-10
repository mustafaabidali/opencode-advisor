export function stripJsonComments(source: string): string {
  let result = ""
  let index = 0
  let inString = false
  let escaped = false
  while (index < source.length) {
    const current = source[index] ?? ""
    const next = source[index + 1] ?? ""
    if (inString) {
      result += current
      if (escaped) escaped = false
      else if (current === "\\") escaped = true
      else if (current === '"') inString = false
      index += 1
      continue
    }
    if (current === '"') {
      inString = true
      result += current
      index += 1
      continue
    }
    if (current === "/" && next === "/") {
      index += 2
      while (index < source.length && source[index] !== "\n") index += 1
      continue
    }
    if (current === "/" && next === "*") {
      index += 2
      while (index < source.length) {
        if (source[index] === "*" && source[index + 1] === "/") {
          index += 2
          break
        }
        if (source[index] === "\n") result += "\n"
        index += 1
      }
      continue
    }
    result += current
    index += 1
  }
  return result
}
