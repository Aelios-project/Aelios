import type { SurfaceEntry } from "../surface";

export function orderCurrentStateSurface(entries: SurfaceEntry[]) {
  if (!entries.some((entry) => entry.currentState)) return entries;
  const out = [...entries];
  for (const entry of entries) {
    if (!entry.currentState) continue;
    const index = out.indexOf(entry);
    const decision = out.findIndex(
      (other) => other.namespace === entry.namespace && other.id === entry.currentState?.by
    );
    if (decision > index) out.splice(index, 0, ...out.splice(decision, 1));
  }
  return out.map((entry) =>
    entry.currentState && entry.recordedDate
      ? {
          ...entry,
          content: `（${entry.recordedDate.slice(0, 10)} 的说法）${entry.content}`
        }
      : entry
  );
}
