import { describe, expect, it } from "vitest";
import { referenceHash, referenceFromHash } from "../src/references";
import { pageFromHash } from "../src/navigation";

describe("note reference URLs", () => {
  it("round trips Chinese paths and URL delimiters while selecting the workspace", () => {
    const reference = { path: "Wiki/中文 #?&+%.md", version: "abc123", scope: '["D:/资料","Wiki & Notes"]' };
    const hash = referenceHash(reference);
    expect(referenceFromHash(hash)).toEqual(reference);
    expect(pageFromHash(hash)).toBe("概览");
    expect(referenceFromHash("#learning-os/overview?note=x")).toBeUndefined();
    expect(pageFromHash("#host?note=x")).toBeUndefined();
  });
});
