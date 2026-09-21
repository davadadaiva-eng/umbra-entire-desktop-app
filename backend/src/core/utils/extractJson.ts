export function extractJson(text: string): any | null {
  const first = text.indexOf('{');
  if (first === -1) return null;

  const candidates: string[] = [];
  let last = text.lastIndexOf('}');
  while (last > first) {
    candidates.push(text.substring(first, last + 1));
    last = text.lastIndexOf('}', last - 1);
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // truncated or malformed — try next candidate
    }
  }

  const bracketFirst = text.indexOf('[');
  if (bracketFirst !== -1) {
    let bracketLast = text.lastIndexOf(']');
    while (bracketLast > bracketFirst) {
      try {
        return JSON.parse(text.substring(bracketFirst, bracketLast + 1));
      } catch {
        bracketLast = text.lastIndexOf(']', bracketLast - 1);
      }
    }
  }

  return null;
}
