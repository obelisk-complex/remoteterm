// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { formatRssSampleLine, summarizeProcessMetrics } from "./emain-rss-monitor";

function makeMetric(overrides: Partial<Electron.ProcessMetric> = {}): Electron.ProcessMetric {
    return {
        pid: 1000,
        type: "Browser",
        cpu: { percentCPUUsage: 0, cumulativeCPUUsageMs: 0, idleWakeupsPerSecond: 0 },
        creationTime: 0,
        memory: { workingSetSize: 100000, peakWorkingSetSize: 120000 },
        ...overrides,
    } as Electron.ProcessMetric;
}

describe("summarizeProcessMetrics", () => {
    it("extracts pid, type, name, and memory in KB from each process metric", () => {
        const metrics = [
            makeMetric({ pid: 1, type: "Browser", memory: { workingSetSize: 200000, peakWorkingSetSize: 250000 } }),
            makeMetric({
                pid: 2,
                type: "Tab",
                name: "renderer",
                memory: { workingSetSize: 300000, peakWorkingSetSize: 310000 },
            }),
        ];
        const result = summarizeProcessMetrics(metrics);
        expect(result).toEqual([
            { pid: 1, type: "Browser", name: undefined, workingSetSizeKb: 200000, peakWorkingSetSizeKb: 250000 },
            { pid: 2, type: "Tab", name: "renderer", workingSetSizeKb: 300000, peakWorkingSetSizeKb: 310000 },
        ]);
    });

    it("returns an empty array for an empty metrics list", () => {
        expect(summarizeProcessMetrics([])).toEqual([]);
    });
});

describe("formatRssSampleLine", () => {
    it("includes a totalRssKb sum, process count, and per-process detail", () => {
        const samples = [
            { pid: 1, type: "Browser", name: undefined, workingSetSizeKb: 100000, peakWorkingSetSizeKb: 120000 },
            { pid: 2, type: "Tab", name: "renderer", workingSetSizeKb: 300000, peakWorkingSetSizeKb: 310000 },
        ];
        const line = formatRssSampleLine(samples, 1700000000000);
        expect(line).toContain("[rss-sample]");
        expect(line).toContain("ts=1700000000000");
        expect(line).toContain("totalRssKb=400000");
        expect(line).toContain("procCount=2");
        expect(line).toContain("type=Browser pid=1 rssKb=100000 peakKb=120000");
        expect(line).toContain("type=Tab pid=2 name=renderer rssKb=300000 peakKb=310000");
    });

    it("handles zero processes without throwing", () => {
        const line = formatRssSampleLine([], 1700000000000);
        expect(line).toContain("totalRssKb=0");
        expect(line).toContain("procCount=0");
    });
});
