/** Parse one JSONL line to an object, or null if it isn't valid JSON. */
export function tryParse(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}
