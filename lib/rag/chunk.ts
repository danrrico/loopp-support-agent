/**
 * Policy chunking (architecture-v2.md §2.2).
 *
 * Split each policy by Markdown H2 heading first; if a section exceeds
 * ~400 tokens, split on paragraph boundaries. Target 300–500 tokens per
 * chunk with 50-token overlap across paragraph splits.
 *
 * Token counts are estimates (chars / 4) — no tokenizer dependency is
 * pulled in for a 5-day build. The estimate is good enough for chunk
 * sizing; it is never used for billing or limits.
 */

export interface PolicyChunk {
  /** 0-based index within the policy (the real `chunk_index` column). */
  chunkIndex: number;
  /** H2 section heading, e.g. "60-Day Return Window". */
  section: string;
  content: string;
}

/** Rough token estimate: ~4 characters per token for English prose. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const MAX_TOKENS = 400;
const OVERLAP_TOKENS = 50;

/**
 * Split one policy's Markdown into chunks.
 *
 * @param markdown full policy text (H1 title + H2 sections)
 * @returns chunks in document order, each tagged with its section
 */
export function chunkPolicy(markdown: string): PolicyChunk[] {
  const sections = splitSections(markdown);
  const chunks: Array<Omit<PolicyChunk, "chunkIndex">> = [];
  for (const section of sections) {
    chunks.push(...splitSection(section.heading, section.body));
  }
  return chunks.map((chunk, index) => ({ ...chunk, chunkIndex: index }));
}

interface Section {
  heading: string;
  body: string;
}

/** Split Markdown into H2 sections. Text before the first H2 is dropped (title/intro). */
function splitSections(markdown: string): Section[] {
  const sections: Section[] = [];
  const lines = markdown.split("\n");
  let current: Section | null = null;
  for (const line of lines) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      if (current) sections.push(current);
      current = { heading: heading[1], body: "" };
    } else if (current) {
      current.body += `${line}\n`;
    }
    // Lines before the first H2 (H1 title, blank lines) are ignored.
  }
  if (current) sections.push(current);
  return sections.map((s) => ({ ...s, body: s.body.trim() })).filter((s) => s.body.length > 0);
}

/**
 * Split one section into chunks. Short sections are a single chunk; long
 * sections split on paragraph boundaries with 50-token overlap so a fact
 * split across a boundary stays retrievable in one chunk.
 */
function splitSection(
  heading: string,
  body: string,
): Array<Omit<PolicyChunk, "chunkIndex">> {
  if (estimateTokens(body) <= MAX_TOKENS) {
    return [{ section: heading, content: body }];
  }

  const paragraphs = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const chunks: Array<Omit<PolicyChunk, "chunkIndex">> = [];
  let current = "";
  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (estimateTokens(candidate) > MAX_TOKENS && current) {
      chunks.push({ section: heading, content: current });
      // Overlap: carry the tail of the previous chunk (~50 tokens) into the next.
      const overlapChars = OVERLAP_TOKENS * 4;
      const tail = current.slice(-overlapChars);
      const tailStart = tail.indexOf(" ");
      current = (tailStart >= 0 ? tail.slice(tailStart + 1) : tail) + `\n\n${paragraph}`;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) chunks.push({ section: heading, content: current.trim() });
  return chunks;
}
