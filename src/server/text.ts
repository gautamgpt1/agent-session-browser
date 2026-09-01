const TEXT_LIMIT = 20_000;

export function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function truncateText(value: string | null | undefined, limit = TEXT_LIMIT): string | null {
  if (!value) return null;
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n...[truncated ${value.length - limit} chars]`;
}

export function toDisplayText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => {
        if (typeof entry === "string") return entry;
        if (entry && typeof entry === "object") {
          const record = entry as Record<string, unknown>;
          return (
            toDisplayText(record.text) ||
            toDisplayText(record.input_text) ||
            toDisplayText(record.output_text) ||
            toDisplayText(record.content) ||
            null
          );
        }
        return toDisplayText(entry);
      })
      .filter(Boolean);
    return parts.join("\n");
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return (
      toDisplayText(record.text) ||
      toDisplayText(record.message) ||
      toDisplayText(record.output) ||
      toDisplayText(record.content) ||
      JSON.stringify(value, null, 2)
    );
  }
  return null;
}

export function normalizeSearchTerms(q: string | null | undefined): string[] {
  if (!q) return [];
  return q
    .trim()
    .split(/\s+/)
    .map((term) => term.replace(/"/g, ""))
    .filter(Boolean)
    .slice(0, 8);
}
