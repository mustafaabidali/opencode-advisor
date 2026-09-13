/** Remember recent identities without retaining an unbounded event history. */
export function remember(values: Set<string>, value: string, limit: number): void {
  values.delete(value)
  values.add(value)
  while (values.size > limit) {
    const oldest = values.values().next().value
    if (oldest === undefined) break
    values.delete(oldest)
  }
}
