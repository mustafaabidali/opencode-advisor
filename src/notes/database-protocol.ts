import type { FindingDatabase } from "./database"

export type Operation = keyof FindingDatabase
export type Arguments<K extends Operation> = Parameters<FindingDatabase[K]>
export type Result<K extends Operation> = ReturnType<FindingDatabase[K]>
export type Request = {
  [K in Operation]: Readonly<{ id: number; dataDir: string; operation: K; args: Arguments<K> }>
}[Operation]
export type Response =
  | Readonly<{ id: number; ok: true; value: Result<Operation> }>
  | Readonly<{ id: number; ok: false; error: string }>
