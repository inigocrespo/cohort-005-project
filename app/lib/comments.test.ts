import { describe, expect, it } from "vitest";
import { commentAnchor, commentIdFromHash } from "./comments";

describe("commentAnchor", () => {
  it("names a comment's anchor after its id", () => {
    expect(commentAnchor(42)).toBe("comment-42");
  });
});

describe("commentIdFromHash", () => {
  it("reads the comment id from a URL hash", () => {
    expect(commentIdFromHash("#comment-42")).toBe(42);
  });

  it("ignores hashes that don't point at a comment", () => {
    expect(commentIdFromHash("")).toBeNull();
    expect(commentIdFromHash("#")).toBeNull();
    expect(commentIdFromHash("#lesson-notes")).toBeNull();
    expect(commentIdFromHash("#comment-")).toBeNull();
    expect(commentIdFromHash("#comment-abc")).toBeNull();
    expect(commentIdFromHash("#comment-4x")).toBeNull();
  });
});
