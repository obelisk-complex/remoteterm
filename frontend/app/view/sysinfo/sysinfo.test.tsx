// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import {
    buildMetricsMenu,
    errorForMetric,
    getGpuColor,
    metricMetaToTimeSeriesMeta,
    plotMemoKey,
    SysinfoViewModel,
} from "@/app/view/sysinfo/sysinfo";
import * as jotai from "jotai";
import { describe, expect, it, vi } from "vitest";

describe("getGpuColor", () => {
    it("returns a distinct color per GPU index, cycling through the palette", () => {
        const c0 = getGpuColor(0);
        const c1 = getGpuColor(1);
        expect(c0).not.toEqual(c1);
        expect(getGpuColor(0)).toEqual(c0);
    });
});

describe("buildMetricsMenu", () => {
    const fixtureMeta: Record<string, TimeSeriesMeta> = {
        cpu: { name: "CPU %", label: "%", color: "var(--sysinfo-cpu-color)" },
        "mem:used": { name: "Memory Used", label: "GB", color: "var(--sysinfo-mem-color)" },
        "gpu:0:util": { name: "GPU 0 %", label: "%", color: "#000" },
        "gpu:1:util": { name: "GPU 1 %", label: "%", color: "#000" },
    };

    it("groups GPU keys by index into their own submenu, leaves cpu/mem flat", () => {
        const menu = buildMetricsMenu(fixtureMeta, ["cpu"], vi.fn());
        const topLevelLabels = menu.map((item) => item.label);
        expect(topLevelLabels).toContain("cpu");
        expect(topLevelLabels).toContain("mem:used");
        const gpuGroups = menu.filter((item) => item.submenu);
        expect(gpuGroups.length).toBe(2);
    });

    it("marks currently-selected metrics as checked", () => {
        const menu = buildMetricsMenu(fixtureMeta, ["cpu", "mem:used"], vi.fn());
        expect(menu.find((item) => item.label === "cpu")?.checked).toBe(true);
        expect(menu.find((item) => item.label === "mem:used")?.checked).toBe(true);
    });

    it("produces an empty menu when no metrics are available (no GPU, no sensors)", () => {
        expect(buildMetricsMenu({}, [], vi.fn()).length).toBe(0);
    });

    it("computes independent checked-state for two different selections against the same discovery data", () => {
        // Two sysinfo widgets on one connection share discovery metadata but each has its own
        // graph:metrics selection, so buildMetricsMenu must be a pure function of `selected`.
        const menuA = buildMetricsMenu(fixtureMeta, ["cpu"], vi.fn());
        const menuB = buildMetricsMenu(fixtureMeta, ["mem:used"], vi.fn());
        expect(menuA.find((i) => i.label === "cpu")?.checked).toBe(true);
        expect(menuA.find((i) => i.label === "mem:used")?.checked).toBe(false);
        expect(menuB.find((i) => i.label === "cpu")?.checked).toBe(false);
        expect(menuB.find((i) => i.label === "mem:used")?.checked).toBe(true);
    });

    it("invokes onToggle with the metric key from both flat and GPU submenu items", () => {
        const onToggle = vi.fn();
        const menu = buildMetricsMenu(fixtureMeta, [], onToggle);
        menu.find((i) => i.label === "cpu").click();
        menu.find((i) => i.label === "GPU 1").submenu[0].click();
        expect(onToggle).toHaveBeenNthCalledWith(1, "cpu");
        expect(onToggle).toHaveBeenNthCalledWith(2, "gpu:1:util");
    });
});

describe("metricMetaToTimeSeriesMeta", () => {
    it("maps backend label/unit/decimalplaces onto the plot's name/label/decimalPlaces", () => {
        const meta = metricMetaToTimeSeriesMeta("cpu", {
            label: "CPU %",
            unit: "%",
            color: "var(--sysinfo-cpu-color)",
            miny: 0,
            maxy: 100,
            decimalplaces: 0,
        });
        expect(meta).toEqual({
            name: "CPU %",
            label: "%",
            color: "var(--sysinfo-cpu-color)",
            miny: 0,
            maxy: 100,
            decimalPlaces: 0,
        });
    });

    it("uses maxykey as a data-relative upper bound when present", () => {
        const meta = metricMetaToTimeSeriesMeta("mem:used", {
            label: "Memory Used",
            unit: "GB",
            color: "var(--sysinfo-mem-color)",
            miny: 0,
            maxy: 0,
            maxykey: "mem:total",
            decimalplaces: 1,
        });
        expect(meta.maxy).toBe("mem:total");
    });

    it("falls back to the metric's own value as its upper bound when no usable maxy is given", () => {
        const meta = metricMetaToTimeSeriesMeta("mem:total", {
            label: "Memory Total",
            unit: "GB",
            color: "var(--sysinfo-mem-color)",
            miny: 0,
            maxy: 0,
            decimalplaces: 1,
        });
        expect(meta.maxy).toBe("mem:total");
    });

    it("overrides GPU colors with the per-index frontend palette", () => {
        const meta = metricMetaToTimeSeriesMeta("gpu:1:temp", {
            label: "GPU 1 Temp",
            unit: "°C",
            color: "var(--sysinfo-gpu-color)",
            miny: 0,
            maxy: 110,
            decimalplaces: 0,
        });
        expect(meta.color).toBe(getGpuColor(1));
    });
});

describe("plotMemoKey", () => {
    const cpuMeta: TimeSeriesMeta = {
        name: "CPU %",
        label: "%",
        color: "var(--sysinfo-cpu-color)",
        miny: 0,
        maxy: 100,
        decimalPlaces: 0,
    };

    // 120 s across 300 px = 400 ms of axis travel per pixel.
    it("stays equal while the value is unchanged and the axis has moved less than a pixel", () => {
        const a = plotMemoKey([{ ts: 800, cpu: 42 }], "cpu", cpuMeta, "#000", 300, 150, 120);
        const b = plotMemoKey([{ ts: 800 }, { ts: 1100, cpu: 42 }], "cpu", cpuMeta, "#000", 300, 150, 120);
        expect(b).toEqual(a);
    });

    it("changes when the axis advances a pixel or more even though the value is constant", () => {
        const a = plotMemoKey([{ ts: 1000, cpu: 0 }], "cpu", cpuMeta, "#000", 300, 150, 120);
        const b = plotMemoKey([{ ts: 1000, cpu: 0 }, { ts: 2000, cpu: 0 }], "cpu", cpuMeta, "#000", 300, 150, 120);
        expect(b).not.toEqual(a);
    });

    it("scales the skip window with the time span per pixel", () => {
        const a = plotMemoKey([{ ts: 0, cpu: 5 }], "cpu", cpuMeta, "#000", 300, 150, 3600);
        const b = plotMemoKey([{ ts: 0 }, { ts: 11000, cpu: 5 }], "cpu", cpuMeta, "#000", 300, 150, 3600);
        const c = plotMemoKey([{ ts: 0 }, { ts: 12000, cpu: 5 }], "cpu", cpuMeta, "#000", 300, 150, 3600);
        expect(b).toEqual(a);
        expect(c).not.toEqual(a);
    });

    it("changes when the metric's display name changes", () => {
        const a = plotMemoKey([{ ts: 1000, cpu: 42 }], "cpu", cpuMeta, "#000", 300, 150, 120);
        const renamed = { ...cpuMeta, name: "CPU (all)" };
        expect(plotMemoKey([{ ts: 1000, cpu: 42 }], "cpu", renamed, "#000", 300, 150, 120)).not.toEqual(a);
    });

    it("keys on the raw timestamp when the plot has no width yet", () => {
        const a = plotMemoKey([{ ts: 1000, cpu: 42 }], "cpu", cpuMeta, "#000", 0, 0, 120);
        const b = plotMemoKey([{ ts: 1001, cpu: 42 }], "cpu", cpuMeta, "#000", 0, 0, 120);
        expect(b).not.toEqual(a);
    });

    it("changes when this metric's own latest value changes", () => {
        const a = plotMemoKey([{ ts: 1000, cpu: 42 }], "cpu", cpuMeta, "#000", 300, 150, 120);
        const b = plotMemoKey([{ ts: 2000, cpu: 43 }], "cpu", cpuMeta, "#000", 300, 150, 120);
        expect(b).not.toEqual(a);
    });

    it("changes when width or height changes", () => {
        const a = plotMemoKey([{ ts: 1000, cpu: 42 }], "cpu", cpuMeta, "#000", 300, 150, 120);
        expect(plotMemoKey([{ ts: 1000, cpu: 42 }], "cpu", cpuMeta, "#000", 301, 150, 120)).not.toEqual(a);
        expect(plotMemoKey([{ ts: 1000, cpu: 42 }], "cpu", cpuMeta, "#000", 300, 151, 120)).not.toEqual(a);
    });

    it("treats two NaN latest values (gap markers) as an unchanged key, not a fresh diff each tick", () => {
        const a = plotMemoKey([{ ts: 800, cpu: NaN }], "cpu", cpuMeta, "#000", 300, 150, 120);
        const b = plotMemoKey([{ ts: 1100, cpu: NaN }], "cpu", cpuMeta, "#000", 300, 150, 120);
        expect(b).toEqual(a);
    });

    it("changes when yvalMeta's color/label/decimalPlaces/domain bounds change", () => {
        const a = plotMemoKey([{ ts: 1000, cpu: 42 }], "cpu", cpuMeta, "#000", 300, 150, 120);
        const recolored = { ...cpuMeta, color: "#fff" };
        expect(plotMemoKey([{ ts: 1000, cpu: 42 }], "cpu", recolored, "#000", 300, 150, 120)).not.toEqual(a);
    });

    it("falls back to the default color when yvalMeta has none, and that still participates in the key", () => {
        const noColorMeta = { ...cpuMeta, color: undefined };
        const a = plotMemoKey([{ ts: 1000, cpu: 42 }], "cpu", noColorMeta, "#000", 300, 150, 120);
        const b = plotMemoKey([{ ts: 1000, cpu: 42 }], "cpu", noColorMeta, "#fff", 300, 150, 120);
        expect(b).not.toEqual(a);
    });
});

describe("errorForMetric", () => {
    it("maps cpu, core, mem and temp keys to their owning collector", () => {
        const errors = { cpu: "cpu err", mem: "mem err", temp: "temp err" };
        expect(errorForMetric("cpu", errors)).toBe("cpu err");
        expect(errorForMetric("cpu:3", errors)).toBe("cpu err");
        expect(errorForMetric("mem:used", errors)).toBe("mem err");
        expect(errorForMetric("cpu:temp", errors)).toBe("temp err");
    });

    it("attributes gpu keys to whichever GPU collector reported an error", () => {
        expect(errorForMetric("gpu:0:util", { "gpu-amd": "rocm-smi failed" })).toBe("rocm-smi failed");
        expect(errorForMetric("gpu:0:util", { cpu: "cpu err" })).toBeUndefined();
    });

    it("returns undefined when there are no errors", () => {
        expect(errorForMetric("cpu", {})).toBeUndefined();
        expect(errorForMetric("cpu", null)).toBeUndefined();
    });
});

function makeFakeEnv(connection: string) {
    const metaAtoms: Record<string, jotai.Atom<any>> = {
        connection: jotai.atom(connection),
        "graph:numpoints": jotai.atom(null),
        "graph:metrics": jotai.atom(null),
        count: jotai.atom(null),
    };
    return {
        rpc: {
            EventReadHistoryCommand: vi.fn().mockResolvedValue([]),
            SetMetaCommand: vi.fn().mockResolvedValue(undefined),
            GetSysInfoMetricsCommand: vi.fn().mockResolvedValue({}),
            SysInfoReprobeCommand: vi.fn().mockResolvedValue(undefined),
        },
        getConnStatusAtom: () => jotai.atom({ status: "connected" }),
        getBlockMetaKeyAtom: (_blockId: string, key: string) => metaAtoms[key],
    };
}

function makeSysinfoEvent(ts: number, errors?: Record<string, string>): Extract<WaveEvent, { event: "sysinfo" }> {
    return { event: "sysinfo", scopes: ["local"], data: { ts, values: { cpu: 10 }, errors } };
}

describe("SysinfoViewModel errorsAtom", () => {
    it("is populated from the last history event on initial load", async () => {
        const env = makeFakeEnv("local");
        const now = Date.now();
        env.rpc.EventReadHistoryCommand.mockResolvedValue([
            makeSysinfoEvent(now - 1000, { cpu: "stale" }),
            makeSysinfoEvent(now, { "gpu-amd": "rocm-smi failed" }),
        ]);
        const model = new SysinfoViewModel({ blockId: "b1", waveEnv: env } as any);
        await vi.waitFor(() => expect(globalStore.get(model.loadingAtom)).toBe(false));
        expect(globalStore.get(model.errorsAtom)).toEqual({ "gpu-amd": "rocm-smi failed" });
    });

    it("is replaced by each live event's errors", async () => {
        const model = new SysinfoViewModel({ blockId: "b1", waveEnv: makeFakeEnv("local") } as any);
        await vi.waitFor(() => expect(globalStore.get(model.loadingAtom)).toBe(false));
        const now = Date.now();
        globalStore.set(model.dataAtom, [{ ts: now - 1000 }]);
        model.handleSysinfoEvent(makeSysinfoEvent(now, { temp: "no sensors" }));
        expect(globalStore.get(model.errorsAtom)).toEqual({ temp: "no sensors" });
        model.handleSysinfoEvent(makeSysinfoEvent(now + 1000));
        expect(globalStore.get(model.errorsAtom)).toEqual({});
    });
});

describe("SysinfoViewModel RPC routing", () => {
    it.each([
        ["myhost", "conn:myhost"],
        ["", "conn:local"],
    ])("routes discovery and reprobe for connection %j to %s with a matching connname", async (conn, route) => {
        const env = makeFakeEnv(conn);
        const model = new SysinfoViewModel({ blockId: "b1", waveEnv: env } as any);
        const expectedConnName = route.replace(/^conn:/, "");

        await model.loadAvailableMetrics();
        const [, metricsData, metricsOpts] = env.rpc.GetSysInfoMetricsCommand.mock.calls.at(-1);
        expect(metricsData).toEqual({ connname: expectedConnName });
        expect(metricsOpts.route).toBe(route);

        await model.reprobe();
        const [, reprobeData, reprobeOpts] = env.rpc.SysInfoReprobeCommand.mock.calls.at(-1);
        expect(reprobeData).toEqual({ connname: expectedConnName });
        expect(reprobeOpts.route).toBe(route);
        expect(reprobeOpts.timeout).toBeGreaterThanOrEqual(5000);
    });

    it("refetches discovery once when a live event arrives while metadata is still empty", async () => {
        const env = makeFakeEnv("local");
        env.rpc.GetSysInfoMetricsCommand.mockResolvedValueOnce({}).mockResolvedValue({
            cpu: { label: "CPU %", unit: "%", color: "c", miny: 0, maxy: 100, decimalplaces: 0 },
        });
        const model = new SysinfoViewModel({ blockId: "b1", waveEnv: env } as any);
        await vi.waitFor(() => expect(globalStore.get(model.loadingAtom)).toBe(false));
        await model.loadAvailableMetrics();
        expect(globalStore.get(model.availableMetaAtom)).toEqual({});

        const now = Date.now();
        globalStore.set(model.dataAtom, [{ ts: now - 1000 }]);
        model.handleSysinfoEvent(makeSysinfoEvent(now));
        model.handleSysinfoEvent(makeSysinfoEvent(now + 1));
        await vi.waitFor(() => expect(globalStore.get(model.availableMetaAtom).cpu?.name).toBe("CPU %"));
        expect(env.rpc.GetSysInfoMetricsCommand).toHaveBeenCalledTimes(2);

        model.handleSysinfoEvent(makeSysinfoEvent(now + 2));
        expect(env.rpc.GetSysInfoMetricsCommand).toHaveBeenCalledTimes(2);
    });

    it("resetConnectionState clears errors and discovery metadata", () => {
        const model = new SysinfoViewModel({ blockId: "b1", waveEnv: makeFakeEnv("local") } as any);
        globalStore.set(model.errorsAtom, { cpu: "old" });
        globalStore.set(model.availableMetaAtom, { cpu: { name: "CPU %" } });
        model.resetConnectionState();
        expect(globalStore.get(model.errorsAtom)).toEqual({});
        expect(globalStore.get(model.availableMetaAtom)).toEqual({});
    });

    it("stores discovery results as plot metadata", async () => {
        const env = makeFakeEnv("local");
        env.rpc.GetSysInfoMetricsCommand.mockResolvedValue({
            cpu: { label: "CPU %", unit: "%", color: "c", miny: 0, maxy: 100, decimalplaces: 0 },
        });
        const model = new SysinfoViewModel({ blockId: "b1", waveEnv: env } as any);
        await model.loadAvailableMetrics();
        expect(globalStore.get(model.availableMetaAtom).cpu.name).toBe("CPU %");
    });
});
