/** Embeddings for search by meaning (spec §5, §11): a provider's embed(), sized to what FolderPilot stores. */
import { toDims } from "@folderpilot/core";
import type { AIProvider } from "./types";

export interface Embedder {
  /** Stable id of the model that made the vectors, e.g. "openai:text-embedding-3-small". Only vectors from the same model are compared. */
  readonly model: string;
  /** Vectors sized to EMBEDDING_DIMS (shorter ones zero-padded; oversized ones refused). */
  embed(texts: string[]): Promise<number[][]>;
}

export function embedderOf(provider: AIProvider, model: string): Embedder | null {
  if (!provider.embed) return null;
  return {
    model,
    async embed(texts) {
      const vectors = await provider.embed!(texts);
      return vectors.map((v) => toDims(v));
    },
  };
}
