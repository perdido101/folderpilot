-- pgvector for semantic search embeddings (files.embedding vector(1024)).
CREATE EXTENSION IF NOT EXISTS vector;
-- gen_random_uuid() is built into Postgres 13+, pgcrypto kept for digest() helpers.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
