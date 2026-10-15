// The host log event API. Structured diagnostics travel this channel and never stdout: the native
// supervisor treats any supervised stdout byte after the ready frame as invalid output.
// Deliberately dependency-free so the tool layer can emit diagnostics without importing the host
// (which owns the file, HTTP and config modules).
export interface HostLogSink {
  event(raw: unknown): void;
}

const sinks = new Set<HostLogSink>();

/** Attach one host log sink; the returned function detaches it. */
export function attachHostLogSink(sink: HostLogSink): () => void {
  sinks.add(sink);
  return () => { sinks.delete(sink); };
}

/** Route one structured host diagnostic to every attached host log. Validation stays in the sink. */
export function hostLogEvent(raw: unknown): void {
  for (const sink of sinks) sink.event(raw);
}
