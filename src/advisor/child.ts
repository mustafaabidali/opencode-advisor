import { pickModel, type ModelCatalog } from "../models"
import type { ReviewContext } from "../notes"
import { AdvisorCallError, type PassResult } from "./pass-types"
import type { AdvisorRuntimeOptions, ResolvedEntry } from "./runtime-types"
import { readProjectFiles } from "./files"
import { carryFindings, contextBudget } from "./carry"

export class ContextBudgetExceeded extends Error {}

/** Owns one browsable reviewer generation and its deterministic carry into the next. */
export class ReviewChild {
  #id: string | undefined
  #primed = false
  #files: Awaited<ReturnType<typeof readProjectFiles>> | undefined
  #carry = ""
  #context: PassResult["context"]
  #budget: number | undefined
  #generation = 0
  #blocked = false
  #retired = false
  #restored = false
  constructor(readonly root: string, readonly entry: ResolvedEntry, private readonly options: AdvisorRuntimeOptions) {}
  get id(): string | undefined { return this.#id }
  get primed(): boolean { return this.#primed }
  get material() { return { ...this.#files, carryForward: this.#carry } }
  get status() {
    return { generation: this.#generation, context_tokens: this.#context?.tokens,
      context_budget: this.#budget, context_budget_available: this.#budget !== undefined,
      context_budget_exceeded: this.#blocked }
  }
  retire(): void { this.#retired = true }
  restore(generation: number): void { this.#generation = generation; this.#restored = generation > 0 }
  async ensure(): Promise<string> {
    if (this.#id !== undefined) return this.#id
    const result = await this.options.client.session.create({
      query: { directory: this.options.directory }, body: { parentID: this.root, title: `advisor:${this.entry.slug}` },
    })
    if (result.error !== undefined || result.data === undefined || (result.response?.status ?? 200) >= 400) {
      throw new AdvisorCallError("advisor session creation failed", result.response?.status, result.error)
    }
    if (this.#retired) throw new Error("Advisor child retired")
    this.#id = result.data.id
    this.#generation++
    this.options.onAdvisorSession(this.#id)
    return this.#id
  }
  async prepare(catalog: ModelCatalog, review?: ReviewContext): Promise<void> {
    const selected = pickModel(this.entry, this.options.cooldowns)?.ref ?? this.entry.model
    this.#budget = contextBudget(this.options.config, selected, catalog)
    if (this.#restored || (this.#id !== undefined && this.#budget !== undefined && (this.#context?.tokens ?? 0) >= this.#budget)) {
      await this.#rotate(review)
      this.#restored = false
    }
    this.#files ??= await readProjectFiles(this.options.directory, this.options.readFile, this.options.log)
  }
  async refresh(review?: ReviewContext): Promise<string> {
    await this.#rotate(review)
    this.#files = await readProjectFiles(this.options.directory, this.options.readFile, this.options.log)
    return this.ensure()
  }
  async #rotate(review?: ReviewContext): Promise<void> {
    const carry = await carryFindings(this.options.store, this.options.directory, this.root, this.entry.slug,
      review?.task_id, this.options.config.context_carry_chars)
    if (carry === undefined) {
      if (!this.#blocked) await this.options.onWarning(this.entry.slug,
        "Advisor context budget exceeded: required findings or evidence cannot be carried safely. Resolve findings or increase context_carry_chars before resuming.")
      this.#blocked = true
      throw new ContextBudgetExceeded("Advisor required context cannot fit")
    }
    this.#blocked = false
    this.#carry = carry
    this.#id = undefined
    this.#primed = false
    this.#files = undefined
    this.#context = undefined
  }
  complete(result: PassResult, prompted: ReadonlySet<string>): void {
    if (this.#id !== undefined && prompted.has(this.#id)) this.#primed = true
    if (result.context !== undefined) this.#context = result.context
  }
}
