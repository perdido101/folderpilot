CREATE EXTENSION IF NOT EXISTS unaccent;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "embedding_model" text;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "embedding_hash" text;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "search_tsv" tsvector;--> statement-breakpoint
CREATE INDEX "files_search_tsv_gin" ON "files" USING gin ("search_tsv");--> statement-breakpoint
CREATE INDEX "files_embedding_hnsw" ON "files" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
-- Full-text search document (spec §11): weighted, accent-insensitive, language-neutral ('simple').
-- A trigger (not a generated column): unaccent() and array_to_string() aren't immutable.
CREATE OR REPLACE FUNCTION files_search_tsv() RETURNS trigger AS $$
BEGIN
  NEW.search_tsv :=
    setweight(to_tsvector('simple', unaccent(coalesce(NEW.name, '') || ' ' || regexp_replace(coalesce(NEW.name, ''), '[._()-]+', ' ', 'g') || ' ' || coalesce(NEW.entities->>'client', ''))), 'A') ||
    setweight(to_tsvector('simple', unaccent(coalesce(NEW.caption, '') || ' ' || coalesce(NEW.category, '') || ' ' || array_to_string(NEW.tags, ' ') || ' ' || coalesce(NEW.entities->>'docType', ''))), 'B') ||
    setweight(to_tsvector('simple', unaccent(regexp_replace(coalesce(NEW.path, ''), '[/._()-]+', ' ', 'g'))), 'C') ||
    setweight(to_tsvector('simple', unaccent(left(coalesce(NEW.text_excerpt, ''), 20000))), 'D');
  RETURN NEW;
END
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER files_search_tsv BEFORE INSERT OR UPDATE OF name, path, caption, category, tags, entities, text_excerpt ON files
  FOR EACH ROW EXECUTE FUNCTION files_search_tsv();--> statement-breakpoint
UPDATE files SET name = name;
