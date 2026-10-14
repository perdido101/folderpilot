import type { Job } from "bullmq";
import { describe, expect, it } from "vitest";
import { systemProcessor } from "./processors";

describe("system processor", () => {
  it("answers heartbeats", async () => {
    const res = await systemProcessor("w1")({ id: "1", name: "heartbeat" } as Job);
    expect(res).toMatchObject({ workerId: "w1" });
  });
  it("fails unknown jobs loudly", async () => {
    await expect(systemProcessor("w1")({ id: "2", name: "mystery" } as Job)).rejects.toThrow(/Unknown system job/);
  });
});
