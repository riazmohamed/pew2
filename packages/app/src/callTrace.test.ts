import { describe, expect, it } from "bun:test";
import { TRACE_BATCH, traceBatches, traceLine } from "./callTrace";

describe("call trace", () => {
  it("stamps seconds since the call started", () => {
    expect(traceLine(1_000, 2_420, "route override speaker=true")).toBe(
      "+1.42s route override speaker=true",
    );
  });

  it("never lets a line split in two or carry control characters", () => {
    expect(traceLine(0, 0, "a\nb\u001b[31m")).toBe("+0.00s a?b?[31m");
    expect(traceLine(0, 0, "x".repeat(500)).length).toBe(280);
  });

  it("batches to what the daemon takes", () => {
    const lines = Array.from({ length: TRACE_BATCH * 2 + 1 }, (_, i) => `l${i}`);
    expect(traceBatches(lines).map((b) => b.length)).toEqual([TRACE_BATCH, TRACE_BATCH, 1]);
    expect(traceBatches([])).toEqual([]);
  });
});
