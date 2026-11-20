/**
 * Shared text processing for the mock RAG path (tokenize + stem).
 *
 * Used by the mock embedder (vector path) and the local keyword search
 * (demo-mode fallback). Real embeddings do not use this module — it exists
 * only so the keyless demo retrieves sensible chunks.
 */

// Common function + conversational words carry no topical signal; hashing
// them into a vector (or counting them as overlap) only dilutes the content
// words — a 4-word query would spend half its weight on "how do I".
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "than", "so",
  "is", "are", "was", "were", "be", "been", "being", "am",
  "i", "you", "he", "she", "it", "we", "they", "my", "your", "his",
  "her", "its", "our", "their", "me", "him", "us", "them",
  "this", "that", "these", "those", "there", "here",
  "do", "does", "did", "doing", "can", "could", "will", "would",
  "should", "may", "might", "must", "shall",
  "of", "in", "on", "at", "to", "for", "with", "by", "from", "as",
  "about", "into", "over", "after", "before", "between", "through",
  "how", "what", "when", "where", "which", "who", "whom", "why",
  "not", "no", "yes", "very", "just", "also", "more", "most", "other",
  "some", "any", "all", "each", "per", "via",
  "much", "many", "get", "got", "make", "made", "take", "give",
  "given", "say", "said", "know", "need", "want", "like", "really",
  "please", "thanks", "thank", "hi", "hello", "hey", "help",
]);

/**
 * Crude suffix stemmer (Porter-lite): strips common English suffixes so
 * "returns" matches "return", "longer" matches "long", "days" matches
 * "day". It over-stems sometimes ("shipping" → "shipp") but it is applied
 * identically to queries and chunks, so matching stays consistent.
 */
export function stem(word: string): string {
  if (word.length <= 3) return word;
  for (const suffix of ["ing", "ers", "er", "ed", "es", "s"]) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
      return word.slice(0, -suffix.length);
    }
  }
  return word;
}

/** Lowercase → strip punctuation → drop stopwords/short tokens → stem. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s$-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map(stem);
}
