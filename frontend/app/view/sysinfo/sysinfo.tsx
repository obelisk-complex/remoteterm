// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { makeORef } from "@/app/store/wos";
import * as util from "@/util/util";
import * as Plot from "@observablehq/plot";
import clsx from "clsx";
import dayjs from "dayjs";
import * as htl from "htl";
import * as jotai from "jotai";
import * as React from "react";

import { useDimensionsWithExistingRef } from "@/app/hook/useDimensions";
import type { MetaKeyAtomFnType, WaveEnv, WaveEnvSubset } from "@/app/remotetermenv/remotetermenv";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { OverlayScrollbarsComponent, OverlayScrollbarsComponentRef } from "overlayscrollbars-react";

export type SysinfoEnv = WaveEnvSubset<{
    rpc: {
        EventReadHistoryCommand: WaveEnv["rpc"]["EventReadHistoryCommand"];
        SetMetaCommand: WaveEnv["rpc"]["SetMetaCommand"];
        GetSysInfoMetricsCommand: WaveEnv["rpc"]["GetSysInfoMetricsCommand"];
        SysInfoReprobeCommand: WaveEnv["rpc"]["SysInfoReprobeCommand"];
    };
    getConnStatusAtom: WaveEnv["getConnStatusAtom"];
    getBlockMetaKeyAtom: MetaKeyAtomFnType<"graph:numpoints" | "graph:metrics" | "connection" | "count">;
}>;

const DefaultNumPoints = 120;
const DefaultMetrics = ["cpu"];
// Reprobe runs nvidia-smi, rocm-smi and a 1s intel_gpu_top sample back to back on the backend.
const ReprobeTimeoutMs = 5000;
const GpuCollectorNames = ["gpu-nvidia", "gpu-amd", "gpu-intel"];
const _plotColors = ["#58C142", "#FFC107", "#FF5722", "#2196F3", "#9C27B0", "#00BCD4", "#FFEB3B", "#795548"];

export function getGpuColor(gpuIndex: number): string {
    return _plotColors[gpuIndex % _plotColors.length];
}

type DataItem = {
    ts: number;
    [k: string]: number;
};

function convertWaveEventToDataItem(event: Extract<WaveEvent, { event: "sysinfo" }>): DataItem {
    const eventData = event.data;
    if (eventData == null || eventData.ts == null || eventData.values == null) {
        return null;
    }
    const dataItem = { ts: eventData.ts };
    for (const key in eventData.values) {
        dataItem[key] = eventData.values[key];
    }
    return dataItem;
}

function gpuIndexFromKey(key: string): number | null {
    const match = key.match(/^gpu:(\d+):/);
    if (match == null) {
        return null;
    }
    return parseInt(match[1], 10);
}

function collectorNamesForKey(key: string): string[] {
    if (key === "cpu:temp") {
        return ["temp"];
    }
    if (key.startsWith("gpu:")) {
        // a gpu:N:* key doesn't say which vendor collector produced it
        return GpuCollectorNames;
    }
    if (key.startsWith("mem:")) {
        return ["mem"];
    }
    if (key === "cpu" || key.startsWith("cpu:")) {
        return ["cpu"];
    }
    return [];
}

export function errorForMetric(key: string, errors: Record<string, string>): string | undefined {
    if (errors == null) {
        return undefined;
    }
    for (const name of collectorNamesForKey(key)) {
        if (errors[name]) {
            return errors[name];
        }
    }
    return undefined;
}

export function metricMetaToTimeSeriesMeta(key: string, meta: MetricMeta): TimeSeriesMeta {
    const gpuIdx = gpuIndexFromKey(key);
    let maxy: string | number = meta.maxykey || meta.maxy;
    if (!meta.maxykey && !(meta.maxy > meta.miny)) {
        // e.g. mem:total has no fixed ceiling; bounding by its own value keeps the line in view
        maxy = key;
    }
    return {
        name: meta.label,
        label: meta.unit,
        color: gpuIdx != null ? getGpuColor(gpuIdx) : meta.color,
        miny: meta.miny,
        maxy: maxy,
        decimalPlaces: meta.decimalplaces,
    };
}

export function buildMetricsMenu(
    availableMeta: Record<string, TimeSeriesMeta>,
    selected: string[],
    onToggle: (key: string) => void
): ContextMenuItem[] {
    const selectedSet = new Set(selected);
    const gpuGroups = new Map<number, string[]>();
    const flatKeys: string[] = [];

    for (const key of Object.keys(availableMeta)) {
        const gpuIdx = gpuIndexFromKey(key);
        if (gpuIdx == null) {
            flatKeys.push(key);
            continue;
        }
        if (!gpuGroups.has(gpuIdx)) {
            gpuGroups.set(gpuIdx, []);
        }
        gpuGroups.get(gpuIdx).push(key);
    }

    const menu: ContextMenuItem[] = flatKeys.map((key) => ({
        label: key,
        type: "checkbox",
        checked: selectedSet.has(key),
        click: () => onToggle(key),
    }));

    const sortedGpuIndices = Array.from(gpuGroups.keys()).sort((a, b) => a - b);
    for (const gpuIdx of sortedGpuIndices) {
        menu.push({
            label: `GPU ${gpuIdx}`,
            submenu: gpuGroups.get(gpuIdx).map((key) => ({
                label: availableMeta[key]?.name ?? key,
                type: "checkbox",
                checked: selectedSet.has(key),
                click: () => onToggle(key),
            })),
        });
    }

    return menu;
}

class SysinfoViewModel implements ViewModel {
    viewType: string;
    termMode: jotai.Atom<string>;
    htmlElemFocusRef: React.RefObject<HTMLInputElement>;
    blockId: string;
    viewIcon: jotai.Atom<string>;
    viewText: jotai.Atom<string>;
    viewName: jotai.Atom<string>;
    dataAtom: jotai.PrimitiveAtom<Array<DataItem>>;
    addInitialDataAtom: jotai.WritableAtom<unknown, [DataItem[]], void>;
    addContinuousDataAtom: jotai.WritableAtom<unknown, [DataItem], void>;
    incrementCount: jotai.WritableAtom<unknown, [], Promise<void>>;
    loadingAtom: jotai.PrimitiveAtom<boolean>;
    numPoints: jotai.Atom<number>;
    metricsAtom: jotai.Atom<string[]>;
    connection: jotai.Atom<string>;
    manageConnection: jotai.Atom<boolean>;
    filterOutNowsh: jotai.Atom<boolean>;
    connStatus: jotai.Atom<ConnStatus>;
    availableMetaAtom: jotai.PrimitiveAtom<Record<string, TimeSeriesMeta>>;
    errorsAtom: jotai.PrimitiveAtom<Record<string, string>>;
    metricsRefetchInFlight = false;
    endIconButtons: jotai.Atom<IconButtonDecl[]>;
    env: SysinfoEnv;

    constructor({ blockId, waveEnv }: ViewModelInitType) {
        this.viewType = "sysinfo";
        this.blockId = blockId;
        this.env = waveEnv;
        this.addInitialDataAtom = jotai.atom(null, (get, set, points) => {
            const targetLen = get(this.numPoints) + 1;
            try {
                const newDataRaw = [...points];
                if (newDataRaw.length == 0) {
                    return;
                }
                const latestItemTs = newDataRaw[newDataRaw.length - 1]?.ts ?? 0;
                const cutoffTs = latestItemTs - 1000 * targetLen;
                const blankItemTemplate = { ...newDataRaw[newDataRaw.length - 1] };
                for (const key in blankItemTemplate) {
                    blankItemTemplate[key] = NaN;
                }

                const newDataFiltered = newDataRaw.filter((dataItem) => dataItem.ts >= cutoffTs);
                if (newDataFiltered.length == 0) {
                    return;
                }
                const newDataWithGaps: Array<DataItem> = [];
                if (newDataFiltered[0].ts > cutoffTs) {
                    const blankItemStart = { ...blankItemTemplate, ts: cutoffTs };
                    const blankItemEnd = { ...blankItemTemplate, ts: newDataFiltered[0].ts - 1 };
                    newDataWithGaps.push(blankItemStart);
                    newDataWithGaps.push(blankItemEnd);
                }
                newDataWithGaps.push(newDataFiltered[0]);
                for (let i = 1; i < newDataFiltered.length; i++) {
                    const prevIdxItem = newDataFiltered[i - 1];
                    const curIdxItem = newDataFiltered[i];
                    const timeDiff = curIdxItem.ts - prevIdxItem.ts;
                    if (timeDiff > 2000) {
                        const blankItemStart = { ...blankItemTemplate, ts: prevIdxItem.ts + 1, blank: 1 };
                        const blankItemEnd = { ...blankItemTemplate, ts: curIdxItem.ts - 1, blank: 1 };
                        newDataWithGaps.push(blankItemStart);
                        newDataWithGaps.push(blankItemEnd);
                    }
                    newDataWithGaps.push(curIdxItem);
                }
                set(this.dataAtom, newDataWithGaps);
            } catch (e) {
                console.log("Error adding data to sysinfo", e);
            }
        });
        this.addContinuousDataAtom = jotai.atom(null, (get, set, newPoint) => {
            const targetLen = get(this.numPoints) + 1;
            const data = get(this.dataAtom);
            try {
                const latestItemTs = newPoint?.ts ?? 0;
                const cutoffTs = latestItemTs - 1000 * targetLen;
                data.push(newPoint);
                const newData = data.filter((dataItem) => dataItem.ts >= cutoffTs);
                set(this.dataAtom, newData);
            } catch (e) {
                console.log("Error adding data to sysinfo", e);
            }
        });
        this.availableMetaAtom = jotai.atom({});
        this.errorsAtom = jotai.atom({});
        this.manageConnection = jotai.atom(true);
        this.filterOutNowsh = jotai.atom(true);
        this.loadingAtom = jotai.atom(true);
        this.numPoints = jotai.atom((get) => {
            const metaNumPoints = get(this.env.getBlockMetaKeyAtom(blockId, "graph:numpoints"));
            if (metaNumPoints == null || metaNumPoints <= 0) {
                return DefaultNumPoints;
            }
            return metaNumPoints;
        });
        this.metricsAtom = jotai.atom((get) => {
            const metrics = get(this.env.getBlockMetaKeyAtom(blockId, "graph:metrics"));
            if (!Array.isArray(metrics) || metrics.length === 0) {
                return DefaultMetrics;
            }
            return metrics;
        });
        this.viewIcon = jotai.atom((get) => {
            return "chart-line"; // should not be hardcoded
        });
        this.viewName = jotai.atom("Sysinfo");
        this.incrementCount = jotai.atom(null, async (get, _set) => {
            const count = get(this.env.getBlockMetaKeyAtom(blockId, "count")) ?? 0;
            await this.env.rpc.SetMetaCommand(TabRpcClient, {
                oref: makeORef("block", this.blockId),
                meta: { count: count + 1 },
            });
        });
        this.connection = jotai.atom((get) => {
            const connValue = get(this.env.getBlockMetaKeyAtom(blockId, "connection"));
            if (util.isBlank(connValue)) {
                return "local";
            }
            return connValue;
        });
        this.dataAtom = jotai.atom([]);
        this.loadInitialData();
        this.connStatus = jotai.atom((get) => {
            const connName = get(this.env.getBlockMetaKeyAtom(blockId, "connection"));
            const connAtom = this.env.getConnStatusAtom(connName);
            return get(connAtom);
        });
    }

    get viewComponent(): ViewComponent {
        return SysinfoView;
    }

    // Both sysinfo RPCs are served by the connection's own process (wavesrv or its wsh connserver),
    // so they need an explicit route; connname and route must come from the same connName or the
    // call silently no-ops against the wrong loop.
    async loadAvailableMetrics() {
        const connName = globalStore.get(this.connection);
        try {
            const meta = await this.env.rpc.GetSysInfoMetricsCommand(
                TabRpcClient,
                { connname: connName },
                { route: util.makeConnRoute(connName) }
            );
            if (globalStore.get(this.connection) !== connName) {
                return;
            }
            const converted: Record<string, TimeSeriesMeta> = {};
            for (const [key, metricMeta] of Object.entries(meta ?? {})) {
                converted[key] = metricMetaToTimeSeriesMeta(key, metricMeta);
            }
            globalStore.set(this.availableMetaAtom, converted);
        } catch (e) {
            console.log("Error loading sysinfo metric metadata", e);
        }
    }

    // The backend registers its loop only after the first probe (which includes a ~1s intel_gpu_top
    // sample), so discovery at connect time can return {}; a live event proves registration.
    refetchMetricsIfEmpty() {
        if (this.metricsRefetchInFlight || Object.keys(globalStore.get(this.availableMetaAtom)).length > 0) {
            return;
        }
        this.metricsRefetchInFlight = true;
        this.loadAvailableMetrics().finally(() => {
            this.metricsRefetchInFlight = false;
        });
    }

    handleSysinfoEvent(event: Extract<WaveEvent, { event: "sysinfo" }>) {
        this.refetchMetricsIfEmpty();
        if (globalStore.get(this.loadingAtom)) {
            return;
        }
        globalStore.set(this.errorsAtom, event.data?.errors ?? {});
        const dataItem = convertWaveEventToDataItem(event);
        const prevData = globalStore.get(this.dataAtom);
        const prevLastTs = prevData[prevData.length - 1]?.ts ?? 0;
        if (dataItem.ts - prevLastTs > 2000) {
            this.loadInitialData();
        } else {
            globalStore.set(this.addContinuousDataAtom, dataItem);
        }
    }

    resetConnectionState() {
        globalStore.set(this.errorsAtom, {});
        globalStore.set(this.availableMetaAtom, {});
    }

    async reprobe() {
        const connName = globalStore.get(this.connection);
        try {
            await this.env.rpc.SysInfoReprobeCommand(
                TabRpcClient,
                { connname: connName },
                { route: util.makeConnRoute(connName), timeout: ReprobeTimeoutMs }
            );
            await this.loadAvailableMetrics();
        } catch (e) {
            console.log("Error reprobing sysinfo collectors", e);
        }
    }

    async toggleMetric(key: string) {
        const current = globalStore.get(this.metricsAtom);
        const next = current.includes(key) ? current.filter((k) => k !== key) : [...current, key];
        await this.env.rpc.SetMetaCommand(TabRpcClient, {
            oref: makeORef("block", this.blockId),
            meta: { "graph:metrics": next },
        });
    }

    async loadInitialData() {
        globalStore.set(this.loadingAtom, true);
        try {
            const numPoints = globalStore.get(this.numPoints);
            const connName = globalStore.get(this.connection);
            const initialData = await this.env.rpc.EventReadHistoryCommand(TabRpcClient, {
                event: "sysinfo",
                scope: connName,
                maxitems: numPoints,
            });
            if (initialData == null) {
                return;
            }
            this.getDefaultData();
            const initialDataItems: DataItem[] = initialData.map(convertWaveEventToDataItem);
            // splice the initial data into the default data (replacing the newest points)
            //newData.splice(newData.length - initialDataItems.length, initialDataItems.length, ...initialDataItems);
            globalStore.set(this.addInitialDataAtom, initialDataItems);
            const lastData = initialData[initialData.length - 1]?.data as TimeSeriesData;
            globalStore.set(this.errorsAtom, lastData?.errors ?? {});
        } catch (e) {
            console.log("Error loading initial data for sysinfo", e);
        } finally {
            globalStore.set(this.loadingAtom, false);
        }
    }

    getSettingsMenuItems(): ContextMenuItem[] {
        const availableMeta = globalStore.get(this.availableMetaAtom);
        const selected = globalStore.get(this.metricsAtom);
        const fullMenu: ContextMenuItem[] = [];
        fullMenu.push({
            label: "Metrics",
            submenu: buildMetricsMenu(availableMeta, selected, (key) => this.toggleMetric(key)),
        });
        fullMenu.push({
            label: "Re-detect GPU",
            click: () => this.reprobe(),
        });
        fullMenu.push({ type: "separator" });
        return fullMenu;
    }

    getDefaultData(): DataItem[] {
        // set it back one to avoid backwards line being possible
        const numPoints = globalStore.get(this.numPoints);
        const currentTime = Date.now() - 1000;
        const points: DataItem[] = [];
        for (let i = numPoints; i > -1; i--) {
            points.push({ ts: currentTime - i * 1000 });
        }
        return points;
    }
}

type SysinfoViewProps = {
    blockId: string;
    model: SysinfoViewModel;
};

/**
 * A plot only needs a full Plot.plot() rebuild when something it renders has visibly changed.
 * Data is append-only, so the rendered content is determined by the newest point (value and
 * domain bounds), the x-domain [maxX - targetLen s, maxX], dimensions, and display meta. The
 * x-domain slides with every new row even when the value is constant (older points and tick
 * labels scroll), so maxX is keyed at one-pixel resolution: rebuilds are skipped only while the
 * axis has moved less than a pixel since the last one.
 */
export function plotMemoKey(
    plotData: DataItem[],
    yval: string,
    yvalMeta: TimeSeriesMeta,
    defaultColor: string,
    plotWidth: number,
    plotHeight: number,
    targetLen: number
): readonly unknown[] {
    const latestItem = plotData[plotData.length - 1];
    const latestValue = latestItem?.[yval];
    const maxX = latestItem?.ts;
    const msPerPixel = plotWidth > 0 ? (targetLen * 1000) / plotWidth : 0;
    const axisPosition = msPerPixel > 0 && maxX != null ? Math.floor(maxX / msPerPixel) : maxX;
    const color = yvalMeta?.color ?? defaultColor;
    const maxY = resolveDomainBound(yvalMeta?.maxy, latestItem) ?? 100;
    const minY = resolveDomainBound(yvalMeta?.miny, latestItem) ?? 0;
    return [
        latestValue,
        axisPosition,
        yvalMeta?.name,
        plotWidth,
        plotHeight,
        color,
        yvalMeta?.decimalPlaces ?? 0,
        yvalMeta?.label ?? "?",
        maxY,
        minY,
        targetLen,
    ];
}

function resolveDomainBound(value: number | string, dataItem: DataItem): number | undefined {
    if (typeof value == "number") {
        return value;
    } else if (typeof value == "string") {
        return dataItem?.[value];
    } else {
        return undefined;
    }
}

function SysinfoView({ model, blockId }: SysinfoViewProps) {
    const connName = jotai.useAtomValue(model.connection);
    const lastConnName = React.useRef(connName);
    const connStatus = jotai.useAtomValue(model.connStatus);
    const loading = jotai.useAtomValue(model.loadingAtom);

    React.useEffect(() => {
        if (connStatus?.status != "connected") {
            return;
        }
        if (lastConnName.current !== connName) {
            lastConnName.current = connName;
            model.resetConnectionState();
            model.loadInitialData();
        }
    }, [connStatus.status, connName]);
    React.useEffect(() => {
        if (connStatus?.status != "connected") {
            return;
        }
        model.loadAvailableMetrics();
    }, [connStatus.status, connName]);
    React.useEffect(() => {
        const unsubFn = waveEventSubscribeSingle({
            eventType: "sysinfo",
            scope: connName,
            handler: (event) => model.handleSysinfoEvent(event),
        });
        return () => {
            unsubFn();
        };
    }, [connName]);
    if (connStatus?.status != "connected") {
        return null;
    }
    if (loading) {
        return null;
    }
    return <SysinfoViewInner key={connStatus?.connection ?? "local"} blockId={blockId} model={model} />;
}

type SingleLinePlotProps = {
    plotData: Array<DataItem>;
    yval: string;
    yvalMeta: TimeSeriesMeta;
    blockId: string;
    defaultColor: string;
    title?: boolean;
    sparkline?: boolean;
    targetLen: number;
    errorMessage?: string;
};

function SingleLinePlot({
    plotData,
    yval,
    yvalMeta,
    blockId,
    defaultColor,
    title = false,
    sparkline = false,
    targetLen,
    errorMessage,
}: SingleLinePlotProps) {
    const containerRef = React.useRef<HTMLInputElement>(null);
    const domRect = useDimensionsWithExistingRef(containerRef, 300);
    const plotHeight = domRect?.height ?? 0;
    const plotWidth = domRect?.width ?? 0;

    // Memoized on plotMemoKey's primitives rather than plotData's identity, so ticks that leave
    // the plot visually unchanged (sub-pixel axis travel, same newest value) skip the full
    // Plot.plot() rebuild and DOM swap.
    const plot = React.useMemo(() => {
        const marks: Plot.Markish[] = [];
        const decimalPlaces = yvalMeta?.decimalPlaces ?? 0;
        let color = yvalMeta?.color;
        if (!color) {
            color = defaultColor;
        }
        marks.push(
            () => htl.svg`<defs>
      <linearGradient id="gradient-${blockId}-${yval}" gradientTransform="rotate(90)">
        <stop offset="0%" stop-color="${color}" stop-opacity="0.7" />
        <stop offset="100%" stop-color="${color}" stop-opacity="0" />
      </linearGradient>
	      </defs>`
        );

        marks.push(
            Plot.lineY(plotData, {
                stroke: color,
                strokeWidth: 2,
                x: "ts",
                y: yval,
            })
        );

        // only add the gradient for single items
        marks.push(
            Plot.areaY(plotData, {
                fill: `url(#gradient-${blockId}-${yval})`,
                x: "ts",
                y: yval,
            })
        );
        if (title) {
            marks.push(
                Plot.text([yvalMeta?.name], {
                    frameAnchor: "top-left",
                    dx: 4,
                    fill: "var(--grey-text-color)",
                })
            );
        }
        const labelY = yvalMeta?.label ?? "?";
        marks.push(
            Plot.ruleX(
                plotData,
                Plot.pointerX({
                    x: "ts",
                    py: yval,
                    stroke: "var(--grey-text-color)",
                    strokeWidth: 1,
                    strokeDasharray: 2,
                })
            )
        );
        marks.push(
            Plot.ruleY(
                plotData,
                Plot.pointerX({
                    px: "ts",
                    y: yval,
                    stroke: "var(--grey-text-color)",
                    strokeWidth: 1,
                    strokeDasharray: 2,
                })
            )
        );
        marks.push(
            Plot.tip(
                plotData,
                Plot.pointerX({
                    x: "ts",
                    y: yval,
                    fill: "var(--main-bg-color)",
                    anchor: "middle",
                    dy: -30,
                    title: (d) =>
                        `${dayjs.unix(d.ts / 1000).format("HH:mm:ss")} ${Number(d[yval]).toFixed(decimalPlaces)}${labelY}`,
                    textPadding: 3,
                })
            )
        );
        marks.push(
            Plot.dot(
                plotData,
                Plot.pointerX({
                    x: "ts",
                    y: yval,
                    fill: color,
                    r: 3,
                    stroke: "var(--main-text-color)",
                    strokeWidth: 1,
                })
            )
        );
        const maxY = resolveDomainBound(yvalMeta?.maxy, plotData[plotData.length - 1]) ?? 100;
        const minY = resolveDomainBound(yvalMeta?.miny, plotData[plotData.length - 1]) ?? 0;
        const maxX = plotData[plotData.length - 1].ts;
        const minX = maxX - targetLen * 1000;
        return Plot.plot({
            axis: !sparkline,
            x: {
                grid: true,
                label: "time",
                tickFormat: (d) => `${dayjs.unix(d / 1000).format("HH:mm:ss")}`,
                domain: [minX, maxX],
            },
            y: { label: labelY, domain: [minY, maxY] },
            width: plotWidth,
            height: plotHeight,
            marks: marks,
        });
    }, [...plotMemoKey(plotData, yval, yvalMeta, defaultColor, plotWidth, plotHeight, targetLen), title, sparkline]);

    React.useEffect(() => {
        containerRef.current.append(plot);

        return () => {
            plot.remove();
        };
    }, [plot]);

    return (
        <div className="relative min-h-[100px]">
            <div ref={containerRef} className="min-h-[100px]" />
            {errorMessage && (
                <div className="absolute top-1 right-1 z-10" title={errorMessage}>
                    <i aria-hidden="true" className="fa-sharp fa-solid fa-triangle-exclamation text-warning text-xs" />
                    <span className="sr-only">Metric error: {errorMessage}</span>
                </div>
            )}
        </div>
    );
}

const SysinfoViewInner = React.memo(({ model }: SysinfoViewProps) => {
    const plotData = jotai.useAtomValue(model.dataAtom);
    const yvals = jotai.useAtomValue(model.metricsAtom);
    const plotMeta = jotai.useAtomValue(model.availableMetaAtom);
    const errors = jotai.useAtomValue(model.errorsAtom);
    const osRef = React.useRef<OverlayScrollbarsComponentRef>(null);
    const targetLen = jotai.useAtomValue(model.numPoints) + 1;
    let title = false;
    let cols2 = false;
    if (yvals.length > 1) {
        title = true;
    }
    if (yvals.length > 2) {
        cols2 = true;
    }

    return (
        <OverlayScrollbarsComponent
            ref={osRef}
            className="flex flex-col flex-grow mb-0 overflow-y-auto"
            options={{ scrollbars: { autoHide: "leave" } }}
        >
            <div
                className={clsx("w-full h-full grid grid-rows-[repeat(auto-fit,minmax(100px,1fr))] gap-[10px]", {
                    "grid-cols-2": cols2,
                })}
            >
                {plotData &&
                    plotData.length > 0 &&
                    yvals.map((yval, _idx) => {
                        return (
                            <SingleLinePlot
                                key={`plot-${model.blockId}-${yval}`}
                                plotData={plotData}
                                yval={yval}
                                yvalMeta={plotMeta[yval]}
                                blockId={model.blockId}
                                defaultColor={"var(--accent-color)"}
                                title={title}
                                targetLen={targetLen}
                                errorMessage={errorForMetric(yval, errors)}
                            />
                        );
                    })}
            </div>
        </OverlayScrollbarsComponent>
    );
});
SysinfoViewInner.displayName = "SysinfoViewInner";

export { SysinfoViewModel };
