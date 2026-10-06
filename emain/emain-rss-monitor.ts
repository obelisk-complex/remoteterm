// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export interface RssSample {
    pid: number;
    type: string;
    name?: string;
    workingSetSizeKb: number;
    peakWorkingSetSizeKb: number;
}

export function summarizeProcessMetrics(metrics: Electron.ProcessMetric[]): RssSample[] {
    return metrics.map((m) => ({
        pid: m.pid,
        type: m.type,
        name: m.name,
        workingSetSizeKb: m.memory.workingSetSize,
        peakWorkingSetSizeKb: m.memory.peakWorkingSetSize,
    }));
}

export function formatRssSampleLine(samples: RssSample[], now: number): string {
    const totalRssKb = samples.reduce((sum, s) => sum + s.workingSetSizeKb, 0);
    const parts = samples
        .map(
            (s) =>
                `type=${s.type} pid=${s.pid}${s.name ? ` name=${s.name}` : ""} rssKb=${s.workingSetSizeKb} peakKb=${s.peakWorkingSetSizeKb}`
        )
        .join(" | ");
    return `[rss-sample] ts=${now} totalRssKb=${totalRssKb} procCount=${samples.length} :: ${parts}`;
}
