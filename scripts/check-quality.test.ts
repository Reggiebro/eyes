import { expect, it } from "vitest";
import { qualityPasses } from "./check-quality";

it("allows existing debt and a 250-point drop, but blocks degradation or incomplete results", () => {
  expect(qualityPasses("Quality: 6494 -> 6494\n✓ No degradation detected", 0)).toBe(true);
  expect(qualityPasses("Quality: 6494 -> 6244", 0)).toBe(true);
  expect(qualityPasses("Quality: 6494 -> 6243", 0)).toBe(false);
  expect(qualityPasses("Quality: 6494 -> 7000", 0)).toBe(true);
  expect(qualityPasses("Quality: 6494 -> 6494\nDEGRADED", 0)).toBe(false);
  expect(qualityPasses("Quality: 6494 -> 6494", 2)).toBe(false);
  expect(qualityPasses("Quality: 6494 -> 6494", 1)).toBe(false);
  expect(qualityPasses("Quality: 6494 -> 6494", null)).toBe(false);
  expect(qualityPasses("Baseline saved\nQuality: 6494", 0)).toBe(false);
});
