// BMA documentation says durable items can include reasoning summaries, but
// does not publish their exact preview shape. This OPTIONAL compatibility parser
// recognizes ONLY the explicitly public Responses-style summary_text envelope.
// Enable only after deployment review; no request reasoning knob is sent to BMA.
export type PublicSummary = { id: string; turnId: string; text: string };
export function extractPublicSummaries(
  items: unknown[],
  allowedTurns: Set<string>,
): PublicSummary[] {
  const output = new Map<string, PublicSummary>();
  let remaining = 24000;
  for (const value of items) {
    if (!value || typeof value !== "object") continue;
    const item = value as Record<string, unknown>;
    if (
      item.type !== "reasoning" ||
      typeof item.id !== "string" ||
      !item.id.trim() ||
      item.id.length > 256 ||
      typeof item.turn_id !== "string" ||
      !item.turn_id.trim() ||
      item.turn_id.length > 256 ||
      !allowedTurns.has(item.turn_id) ||
      !Array.isArray(item.summary)
    )
      continue;
    const parts: string[] = [];
    for (const value of item.summary.slice(0, 10)) {
      if (!value || typeof value !== "object") continue;
      const part = value as Record<string, unknown>;
      if (
        part.type === "summary_text" &&
        typeof part.text === "string" &&
        part.text.trim() &&
        part.text.length <= 6000
      )
        parts.push(part.text);
    }
    if (!parts.length) continue;
    const text = parts.join("\n");
    const key = JSON.stringify([item.turn_id, item.id]);
    if (output.has(key) || text.length > remaining) continue;
    remaining -= text.length;
    output.set(key, { id: item.id, turnId: item.turn_id, text });
    if (output.size === 10) break;
  }
  return [...output.values()];
}
