/**
 * Calibration eval (architecture-v2.md §3.4).
 *
 * Runs the labeled questions in data/eval-questions.json through retrieve()
 * and reports: similarity distributions for correct hits vs. incorrect /
 * absent hits, precision/recall at candidate floors, and the Stage-1 band
 * each question lands in.
 *
 * THE REFUSAL: thresholds are set from REAL embedding similarities only.
 * When the embedder is the mock (keyword overlap) — which is the case
 * until the OpenAI key lands — this script prints the distributions for
 * inspection and REFUSES to recommend thresholds. Mock similarities have
 * a different scale and shape than text-embedding-3-small cosine
 * similarities; calibrating on them would produce thresholds that are
 * wrong in production. Re-run with OPENAI_API_KEY + Supabase configured
 * (and the OpenAI embedder implemented) to get a threshold suggestion.
 *
 * Usage: npm run eval
 * CI: runs when OPENAI_API_KEY is present as a repo secret; skips
 * gracefully (exit 0) without one.
 */

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import {
  RETRIEVAL_FLOOR,
  STAGE1_ANSWER_MIN,
  STAGE1_CAVEAT_MIN,
} from "@/lib/agent/thresholds";
import { getEmbedder } from "@/lib/rag/embeddings";
import { retrieve } from "@/lib/rag/retrieve";

interface EvalQuestion {
  id: string;
  category:
    | "answerable"
    | "unanswerable"
    | "cross-policy"
    | "adversarial"
    | "transactional";
  question: string;
  expectedSlug: string | null;
  expectedSection: string | null;
  notes?: string;
}

interface EvalRow {
  id: string;
  category: string;
  question: string;
  expectedSlug: string | null;
  topSlug: string | null;
  topSimilarity: number | null;
  surviving: number;
  correct: boolean | null; // null when no expected slug (unanswerable/transactional)
  band: "answer" | "caveat" | "escalate";
}

function bandOf(top: number | null): EvalRow["band"] {
  if (top === null) return "escalate";
  if (top >= STAGE1_ANSWER_MIN) return "answer";
  if (top >= STAGE1_CAVEAT_MIN) return "caveat";
  return "escalate";
}

function stats(values: number[]): { min: number; median: number; max: number } | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: sorted[0],
    median: sorted[Math.floor(sorted.length / 2)],
    max: sorted[sorted.length - 1],
  };
}

function fmt(n: number | null | undefined): string {
  return n === null || n === undefined ? "  n/a" : n.toFixed(2).padStart(5);
}

async function main(): Promise<void> {
  const embedder = getEmbedder();
  const isMock = embedder.kind === "mock";

  const file = JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), "data", "eval-questions.json"),
      "utf-8",
    ),
  ) as { questions: EvalQuestion[] };
  const questions = file.questions;

  console.log(`\nLoopp retrieval calibration eval — ${questions.length} questions`);
  console.log(`Embedder: ${embedder.kind} (dims ${embedder.dims})`);
  console.log(
    `Provisional thresholds: floor ${RETRIEVAL_FLOOR}, caveat ${STAGE1_CAVEAT_MIN}, answer ${STAGE1_ANSWER_MIN}\n`,
  );

  const rows: EvalRow[] = [];
  for (const q of questions) {
    const hits = await retrieve(q.question);
    const top = hits[0] ?? null;
    const correct =
      q.expectedSlug === null
        ? null
        : top !== null && top.policySlug === q.expectedSlug;
    rows.push({
      id: q.id,
      category: q.category,
      question: q.question,
      expectedSlug: q.expectedSlug,
      topSlug: top?.policySlug ?? null,
      topSimilarity: top?.similarity ?? null,
      surviving: hits.length,
      correct,
      band: bandOf(top?.similarity ?? null),
    });
  }

  // Per-question table.
  console.log(
    "id   category       top-1  band      correct  top slug        question",
  );
  for (const r of rows) {
    const correct =
      r.correct === null ? "  n/a " : r.correct ? "  ✓  " : "  ✗  ";
    console.log(
      `${r.id.padEnd(4)} ${r.category.padEnd(14)} ${fmt(r.topSimilarity)}  ${r.band.padEnd(9)} ${correct} ${(r.topSlug ?? "-").padEnd(15)} ${r.question.slice(0, 60)}`,
    );
  }

  // Distributions.
  const correctTop = rows
    .filter((r) => r.correct === true)
    .map((r) => r.topSimilarity as number);
  // Wrong top-1 rows with NO surviving chunks have topSimilarity null —
  // exclude them from the distribution (they are zero-hit rows, not
  // low-similarity rows).
  const wrongTop = rows
    .filter((r) => r.correct === false && r.topSimilarity !== null)
    .map((r) => r.topSimilarity as number);
  const unanswerableTop = rows
    .filter((r) => r.category === "unanswerable" && r.topSimilarity !== null)
    .map((r) => r.topSimilarity as number);

  console.log("\n--- Distributions (top-1 similarity) ---");
  const cStats = stats(correctTop);
  const wStats = stats(wrongTop);
  const uStats = stats(unanswerableTop);
  console.log(
    `Correct hits     (n=${correctTop.length}): min ${fmt(cStats?.min)}  median ${fmt(cStats?.median)}  max ${fmt(cStats?.max)}`,
  );
  console.log(
    `Wrong top-1      (n=${wrongTop.length}): min ${fmt(wStats?.min)}  median ${fmt(wStats?.median)}  max ${fmt(wStats?.max)}`,
  );
  console.log(
    `Unanswerable top (n=${unanswerableTop.length}): min ${fmt(uStats?.min)}  median ${fmt(uStats?.median)}  max ${fmt(uStats?.max)}`,
  );
  const unanswerableZero = rows.filter(
    (r) => r.category === "unanswerable" && r.surviving === 0,
  ).length;
  const unanswerableTotal = rows.filter(
    (r) => r.category === "unanswerable",
  ).length;
  console.log(
    `Unanswerable with zero surviving chunks: ${unanswerableZero}/${unanswerableTotal} (these escalate correctly)`,
  );

  // Band counts.
  const bands = { answer: 0, caveat: 0, escalate: 0 };
  for (const r of rows) bands[r.band] += 1;
  console.log(
    `\nStage-1 bands: answer ${bands.answer}, caveat ${bands.caveat}, escalate ${bands.escalate}`,
  );

  // Precision/recall at candidate floors (answerable + cross-policy + adversarial).
  const gated = rows.filter((r) =>
    ["answerable", "cross-policy", "adversarial"].includes(r.category),
  );
  console.log("\n--- Precision / recall at candidate floors (gated categories) ---");
  for (const floor of [0.2, 0.3, 0.4, 0.5]) {
    const retrieved = gated.filter(
      (r) => r.topSimilarity !== null && r.topSimilarity >= floor,
    );
    const correct = retrieved.filter((r) => r.correct).length;
    const precision = retrieved.length ? correct / retrieved.length : 1;
    const recall = gated.length ? correct / gated.length : 0;
    console.log(
      `floor ${floor.toFixed(1)}: precision ${precision.toFixed(2)} (${correct}/${retrieved.length}), recall ${recall.toFixed(2)} (${correct}/${gated.length})`,
    );
  }

  // The refusal (mock) or the suggestion (real embeddings).
  console.log("");
  if (isMock) {
    console.log(
      "⚠  THRESHOLD REFUSAL: the embedder is the mock (keyword overlap).\n" +
        "   Mock similarities are NOT embedding cosine similarities — their\n" +
        "   scale and shape differ, so no threshold can be set from them.\n" +
        "   The distributions above are for inspection only.\n" +
        "   Re-run with OPENAI_API_KEY + Supabase configured (and the OpenAI\n" +
        "   embedder implemented) to get a data-driven threshold suggestion.",
    );
    return;
  }

  // Real embeddings: suggest a floor in the gap between correct and
  // wrong/unanswerable clusters, if a clean gap exists.
  const wrongMax = Math.max(
    ...(wrongTop.length ? wrongTop : [0]),
    ...(unanswerableTop.length ? unanswerableTop : [0]),
  );
  const correctMin = correctTop.length ? Math.min(...correctTop) : 1;
  if (correctMin > wrongMax + 0.05) {
    const suggested = ((correctMin + wrongMax) / 2).toFixed(2);
    console.log(
      `✓ Clean gap found: wrong/unanswerable max ${wrongMax.toFixed(2)}, correct min ${correctMin.toFixed(2)}.\n` +
        `  Suggested floor: ${suggested} (midpoint). Record it in lib/agent/thresholds.ts + the README.`,
    );
  } else {
    console.log(
      `No clean gap (wrong/unanswerable max ${wrongMax.toFixed(2)}, correct min ${correctMin.toFixed(2)}).\n` +
        "  Keep the thresholds conservative (escalate more) and record the overlap in the README.",
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
