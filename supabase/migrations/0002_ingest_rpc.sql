-- Loopp Support Agent — transactional policy ingestion (architecture-v2.md §2.2)
--
-- Re-ingest must be transactional per policy slug: DELETE the old chunks for
-- the slug, then INSERT the new ones, in ONE transaction — so an edited
-- policy that produces fewer chunks leaves no stale rows retrievable, and a
-- failed ingest never leaves a slug half-replaced.
--
-- supabase-js cannot run multi-statement transactions from the client, so
-- the transaction lives here: a single function call runs in one
-- transaction. scripts/ingest-policies.ts calls this RPC once per slug.
--
-- chunks: JSONB array of objects, each:
--   { chunk_index: int, section: text, content: text,
--     embedding: [number, ...] (1536 dims), metadata: object,
--     corpus_version: text }
-- Returns the number of chunks inserted for the slug.

CREATE OR REPLACE FUNCTION ingest_policy_chunks(
  p_policy_slug text,
  p_chunks jsonb
) RETURNS integer AS $$
DECLARE
  v_inserted integer;
BEGIN
  DELETE FROM policy_chunks WHERE policy_slug = p_policy_slug;

  INSERT INTO policy_chunks
    (policy_slug, chunk_index, section, content, embedding, metadata, corpus_version)
  SELECT
    p_policy_slug,
    c.chunk_index,
    c.section,
    c.content,
    (c.embedding)::vector(1536),
    COALESCE(c.metadata, '{}'::jsonb),
    COALESCE(c.corpus_version, 'v1')
  FROM jsonb_to_recordset(p_chunks) AS c(
    chunk_index integer,
    section text,
    content text,
    embedding text,
    metadata jsonb,
    corpus_version text
  );

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$ LANGUAGE plpgsql;
