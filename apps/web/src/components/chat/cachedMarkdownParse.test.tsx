import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import type { Processor } from "unified";
import { describe, expect, it } from "vite-plus/test";
import { CHAT_MARKDOWN_REMARK_PLUGINS } from "@t3tools/shared/markdownPipeline";
import { createMarkdownParseCache } from "./cachedMarkdownParse";
import { splitMarkdownBlocks } from "./markdownStreamBlocks";

describe("cached markdown parsing", () => {
  it("reuses finished streaming blocks across remounts while parsing the growing tail", () => {
    const parsed: string[] = [];
    function observe(this: Processor) {
      const parse = this.parser!;
      this.parser = (source, file) => {
        parsed.push(source);
        return parse(source, file);
      };
    }
    const cache = createMarkdownParseCache();
    const render = (text: string) =>
      renderToStaticMarkup(
        <>
          {splitMarkdownBlocks(text)!.map((source, index, blocks) => (
            <ReactMarkdown
              key={source}
              remarkPlugins={[
                ...CHAT_MARKDOWN_REMARK_PLUGINS,
                observe,
                ...(index < blocks.length - 1 ? [cache] : []),
              ]}
            >
              {source}
            </ReactMarkdown>
          ))}
        </>,
      );
    render("Finished block\n\nStill growing");
    expect(render("Finished block\n\nStill growing more")).toContain("Still growing more");
    render("Finished block\n\nStill growing more");
    expect(parsed.filter((source) => source.includes("Finished block"))).toHaveLength(1);
    expect(parsed.filter((source) => source.includes("Still growing"))).toHaveLength(3);
  });

  it("isolates cached snapshots from syntax transforms and bounds retained sources", () => {
    const sources: string[] = [];
    function observe(this: Processor) {
      const parse = this.parser!;
      this.parser = (source, file) => {
        sources.push(source);
        return parse(source, file);
      };
    }
    const cache = createMarkdownParseCache(1600);
    const render = (text: string) =>
      renderToStaticMarkup(
        <ReactMarkdown remarkPlugins={[...CHAT_MARKDOWN_REMARK_PLUGINS, observe, cache]}>
          {text}
        </ReactMarkdown>,
      );
    const task = "- [x] complete";
    expect(render(task)).toBe(render(task));
    expect(sources.filter((source) => source === task)).toHaveLength(1);
    for (const source of ["one", "two", "three", "four", "five", "six", "seven", "eight"])
      render(source);
    render(task);
    expect(sources.filter((source) => source === task)).toHaveLength(2);
    const huge = "x".repeat(500);
    render(huge);
    render(huge);
    expect(sources.filter((source) => source === huge)).toHaveLength(2);
  });
});
