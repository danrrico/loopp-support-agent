/**
 * Transactional policy ingestion (architecture-v2.md §2.2).
 *
 * Per policy slug, in ONE transaction (via the ingest_policy_chunks RPC):
 * DELETE the old chunks for the slug, then INSERT the new ones. An edited
 * policy that produces fewer chunks leaves no stale rows retrievable, and
 * re-running ingestion is idempotent (run it twice, count rows — identical).
 *
 * Usage: npm run ingest
 * Requires: Supabase project with migrations applied + env vars in .env.local.
 * Embeddings: mock embedder until OPENAI_API_KEY lands (TODO(key)).
 */

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { chunkPolicy } from "../lib/rag/chunk";
import { getEmbedder } from "../lib/rag/embeddings";

const CORPUS_VERSION = "v1";

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    console.error(
      "Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. " +
        "Create a Supabase project, apply supabase/migrations, and set the " +
        "vars in .env.local (see setup-v2.md §4–5).",
    );
    process.exit(1);
  }
  const supabase = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const dir = path.join(process.cwd(), "data", "policies");
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort();
  if (files.length === 0) {
    console.error(`No .md policies found in ${dir}`);
    process.exit(1);
  }

  const embedder = getEmbedder();
  let total = 0;
  for (const file of files) {
    const slug = file.replace(/\.md$/, "");
    const markdown = fs.readFileSync(path.join(dir, file), "utf-8");
    const chunks = chunkPolicy(markdown);
    const embeddings = await embedder.embed(chunks.map((c) => c.content));
    const title =
      markdown.match(/^#\s+(.+?)\s*$/m)?.[1] ?? slug;

    const payload = chunks.map((chunk, i) => ({
      chunk_index: chunk.chunkIndex,
      section: chunk.section,
      content: chunk.content,
      embedding: embeddings[i],
      metadata: { policy_title: title, section_heading: chunk.section },
      corpus_version: CORPUS_VERSION,
    }));

    const { data, error } = await supabase.rpc("ingest_policy_chunks", {
      p_policy_slug: slug,
      p_chunks: payload,
    });
    if (error) {
      console.error(`Ingest failed for ${slug}: ${error.message}`);
      process.exit(1);
    }
    if (data !== chunks.length) {
      console.error(
        `Ingest count mismatch for ${slug}: expected ${chunks.length} chunks, RPC inserted ${data}. Aborting.`,
      );
      process.exit(1);
    }
    console.log(`✓ ${slug}: ${data} chunks`);
    total += data;
  }
  console.log(`Done. ${total} chunks across ${files.length} policies.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
