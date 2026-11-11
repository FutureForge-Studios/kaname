import { describe, expect, it } from "vitest";
import {
  MAX_POLL_FAILURES,
  jobFromAccepted,
  jobsReducer,
  parseJob,
  pollable,
  pollDelay,
  type Job,
  type TrackedJob,
} from "./jobs";

const job = (status: Job["status"], id = "j1"): Job => parseJob({ id, status, label: "Restart nginx" })!;

describe("parseJob / jobFromAccepted", () => {
  it("reads the job out of a 202 body", () => {
    const parsed = jobFromAccepted({ job: { id: "abc", status: "queued", type: "service.restart" } });
    expect(parsed?.id).toBe("abc");
    expect(parsed?.type).toBe("service.restart");
    expect(parsed?.label).toBeNull();
  });

  it("tolerates missing and unknown fields", () => {
    expect(parseJob({ id: "x", status: "weird" })?.status).toBe("queued");
    expect(parseJob({ status: "queued" })).toBeNull();
    expect(parseJob(null)).toBeNull();
    expect(parseJob({ id: "x", status: "failed", error: { message: "boom" } })?.error).toEqual({
      code: "error",
      message: "boom",
    });
  });
});

describe("jobsReducer", () => {
  const track = (state: TrackedJob[], j: Job) =>
    jobsReducer(state, { type: "track", connectionId: "c1", job: j, now: 0 });

  it("walks queued → running → succeeded and stops polling", () => {
    let s = track([], job("queued"));
    expect(pollable(s)).toHaveLength(1);
    s = jobsReducer(s, { type: "polled", jobId: "j1", job: job("running") });
    expect(s[0]!.job.status).toBe("running");
    expect(pollable(s)).toHaveLength(1);
    s = jobsReducer(s, { type: "polled", jobId: "j1", job: job("succeeded") });
    expect(s[0]!.job.status).toBe("succeeded");
    expect(pollable(s)).toHaveLength(0);
  });

  it("never regresses from a terminal state on a late poll", () => {
    let s = track([], job("queued"));
    s = jobsReducer(s, { type: "polled", jobId: "j1", job: job("failed") });
    s = jobsReducer(s, { type: "polled", jobId: "j1", job: job("running") });
    expect(s[0]!.job.status).toBe("failed");
  });

  it("does not duplicate a tracked job and puts new jobs first", () => {
    let s = track([], job("queued", "a"));
    s = track(s, job("queued", "b"));
    s = track(s, job("running", "a"));
    expect(s.map((t) => t.job.id)).toEqual(["b", "a"]);
    expect(s[1]!.job.status).toBe("running");
  });

  it("backs off on failed polls and gives up after the limit", () => {
    let s = track([], job("running"));
    expect(pollDelay(s[0]!)).toBe(1000);
    s = jobsReducer(s, { type: "poll_failed", jobId: "j1", message: "network" });
    expect(pollDelay(s[0]!)).toBe(2000);
    for (let i = 1; i < MAX_POLL_FAILURES; i += 1) {
      s = jobsReducer(s, { type: "poll_failed", jobId: "j1", message: "network" });
    }
    expect(pollDelay(s[0]!)).toBe(10_000);
    expect(pollable(s)).toHaveLength(0);
    // A successful poll resets the failure count.
    s = jobsReducer(s, { type: "polled", jobId: "j1", job: job("running") });
    expect(s[0]!.pollFailures).toBe(0);
    expect(s[0]!.pollError).toBeNull();
  });

  it("dismisses one job and clears finished ones", () => {
    let s = track([], job("succeeded", "a"));
    s = track(s, job("running", "b"));
    s = track(s, job("failed", "c"));
    expect(jobsReducer(s, { type: "clear_finished" }).map((t) => t.job.id)).toEqual(["b"]);
    expect(jobsReducer(s, { type: "dismiss", jobId: "b" }).map((t) => t.job.id)).toEqual(["c", "a"]);
  });
});
