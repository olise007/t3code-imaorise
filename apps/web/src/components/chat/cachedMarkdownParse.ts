import type { Processor } from "unified";

/** Cache immutable parse snapshots across remounts, never a growing streaming prefix. */
export function createMarkdownParseCache(maxChars = 500_000) {
  const parsed = new Map<string, ReturnType<NonNullable<Processor["parser"]>>>();
  let size = 0;
  return function cachedParse(this: Processor) {
    const parse = this.parser;
    if (!parse) return;
    this.parser = (source, file) => {
      const cached = parsed.get(source);
      if (cached !== undefined) {
        parsed.delete(source);
        parsed.set(source, cached);
        return structuredClone(cached);
      }
      const tree = parse(source, file);
      // Avoid letting one huge response evict every other thread's blocks.
      const cost = source.length + 200;
      if (cost <= maxChars / 4) {
        parsed.set(source, structuredClone(tree));
        size += cost;
        for (const oldest of parsed.keys()) {
          if (size <= maxChars) break;
          parsed.delete(oldest);
          size -= oldest.length + 200;
        }
      }
      return tree;
    };
  };
}

export const cachedMarkdownParse = createMarkdownParseCache();
