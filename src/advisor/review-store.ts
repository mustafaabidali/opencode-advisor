import type { ReviewContext, TranscriptRecord } from "../notes"
import type { AdvisorStore } from "./pass-types"

export function reviewStore(store: AdvisorStore, review?: ReviewContext,
  onTranscript?: (record: TranscriptRecord) => void): AdvisorStore {
  return {
    ...store,
    writeNote: (note) => store.writeNote({ ...note, ...(review === undefined ? {} : { review }) }),
    ...(store.recoverNote === undefined ? {} : { recoverNote: (note) =>
      store.recoverNote?.({ ...note, ...(review === undefined ? {} : { review }) }) ?? Promise.resolve(undefined) }),
    appendTranscript: async (root, record) => { onTranscript?.(record); await store.appendTranscript(root, record) },
    writeState: (cwd, state) => store.writeState(cwd, state),
  }
}
