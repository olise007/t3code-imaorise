import { useState } from "react";
import { createRoot } from "react-dom/client";
import { useComposerMultilinePrompt } from "../src/components/chat/useComposerMultilinePrompt";
import { revealSidebarRow } from "../src/components/sidebar/routeReveal";

function Fixture() {
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const multiline = useComposerMultilinePrompt(body);
  return (
    <>
      <div ref={setBody} style={{ width: 200, lineHeight: "20px", padding: 0 }}>
        <div
          data-testid="composer-editor"
          contentEditable
          suppressContentEditableWarning
          style={{ minHeight: 20, outline: "none" }}
        >
          short
        </div>
        <output>{multiline ? "multiline" : "single line"}</output>
      </div>
      <ul aria-label="Threads" style={{ height: 96, overflowY: "auto", margin: 0, padding: 0 }}>
        {Array.from({ length: 50 }, (_, index) => (
          <li
            key={index}
            id={`row-${index}`}
            tabIndex={-1}
            style={{ height: 24 }}
            onClick={(event) => revealSidebarRow(event.currentTarget)}
            onKeyDown={(event) => {
              if (event.key === "Enter") revealSidebarRow(event.currentTarget);
            }}
          >
            thread-{index}
          </li>
        ))}
      </ul>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
