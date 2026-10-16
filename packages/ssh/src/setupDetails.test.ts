import { expect, it } from "vite-plus/test";
import { createSetupDetails } from "./setupDetails.ts";

it("redacts complete sensitive lines and URLs across arbitrary transport boundaries", () => {
  const lines: string[] = [];
  const stream = createSetupDetails((line) => lines.push(line));
  for (const character of "Installing git\nhttps://auth.openai.com/oauth/authorize?code=private\npassword: private secret\nuser_code: ABC123\nVerified runtime\n")
    stream.push(character);
  stream.finish();
  expect(lines).toEqual([
    "Installing git",
    "[address omitted]",
    "[Sensitive output omitted]",
    "[Sensitive output omitted]",
    "Verified runtime",
  ]);
});

it("bounds an unterminated line without transmitting a secret suffix", () => {
  const lines: string[] = [];
  const stream = createSetupDetails((line) => lines.push(line));
  stream.push("x".repeat(9000));
  stream.push("password: hidden\nDone");
  stream.finish();
  expect(lines).toEqual(["[Oversized output line omitted]", "Done"]);
});

it("omits private-key blocks across chunks and never previews key material", () => {
  const lines: string[] = [];
  const details = createSetupDetails((line) => lines.push(line));
  details.push("-----BEGIN OPENSSH PRIVATE KEY-----\nabc");
  expect(details.preview()).toBeNull();
  details.push("def\n-----END OPENSSH PRIVATE KEY-----\nVerified");
  expect(details.preview()).toBe("Verified");
  details.finish();
  expect(lines.join("\n")).not.toContain("abcdef");
  expect(lines.at(-1)).toBe("Verified");
});
