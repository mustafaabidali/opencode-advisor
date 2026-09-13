import { expect, test } from "bun:test"
import { ProviderAdmission } from "../src/advisor/admission"

test("provider admission is bounded and rotates between roots without starving a waiting reviewer", async () => {
  const admission = new ProviderAdmission(1)
  const first = await admission.acquire("provider", "root-a")
  const order: string[] = []
  const a = admission.acquire("provider", "root-a").then((release) => { order.push("a"); return release })
  const b = admission.acquire("provider", "root-b").then((release) => { order.push("b"); return release })
  first()
  const second = await b
  expect(order).toEqual(["b"])
  second()
  const third = await a
  expect(order).toEqual(["b", "a"])
  third()
  expect(admission.active("provider")).toBe(0)
})

test("unlimited admission preserves concurrency and cancelling a waiter cannot leak a permit", async () => {
  const unlimited = new ProviderAdmission(0)
  const leases = await Promise.all(Array.from({ length: 8 }, (_, index) => unlimited.acquire("p", `r-${index}`)))
  expect(unlimited.active("p")).toBe(8)
  leases.forEach((release) => release())
  const admission = new ProviderAdmission(1)
  const first = await admission.acquire("p", "a")
  const controller = new AbortController()
  const waiting = admission.acquire("p", "b", controller.signal)
  controller.abort()
  await expect(waiting).rejects.toThrow()
  first()
  const release = await admission.acquire("p", "c")
  release()
  release()
  expect(admission.active("p")).toBe(0)
})
