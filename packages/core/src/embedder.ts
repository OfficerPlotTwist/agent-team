/** Turns text into a fixed-dim vector. Real models are async + network-bound;
 *  the provider depends only on this port and never picks a model itself. */
export interface Embedder {
  embed(text: string): Promise<Float32Array>;
  readonly dim: number;
}

/**
 * Deterministic, network-free embedder for offline v1 + tests. Hashes
 * whitespace tokens into a fixed-dim bag-of-words vector (FNV-1a), L2-normalized
 * so vec0's L2 distance tracks cosine similarity. NOT semantically strong — it
 * proves the retrieval seam; swap a real embedder in via the Embedder port with
 * no provider change.
 */
export class HashEmbedder implements Embedder {
  readonly dim: number;
  constructor(dim = 64) {
    this.dim = dim;
  }

  async embed(text: string): Promise<Float32Array> {
    const v = new Float32Array(this.dim);
    for (const tok of text.toLowerCase().split(/\s+/).filter(Boolean)) {
      let h = 2166136261;
      for (let i = 0; i < tok.length; i++) {
        h ^= tok.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      v[(h >>> 0) % this.dim] += 1;
    }
    let norm = 0;
    for (let i = 0; i < this.dim; i++) norm += v[i] * v[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < this.dim; i++) v[i] /= norm;
    return v;
  }
}
