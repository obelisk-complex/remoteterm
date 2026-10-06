// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Deferred = { resolve: () => void; reject: (e: Error) => void };

let faces: { family: string; src: string; style: string; weight: string; deferred: Deferred }[];

class FakeFontFace {
    family: string;
    src: string;
    style: string;
    weight: string;
    deferred: Deferred;
    promise: Promise<void>;

    constructor(family: string, src: string, desc: { style: string; weight: string }) {
        this.family = family;
        this.src = src;
        this.style = desc.style;
        this.weight = desc.weight;
        this.promise = new Promise<void>((resolve, reject) => {
            this.deferred = { resolve, reject };
        });
        faces.push(this);
    }

    load() {
        return this.promise;
    }
}

function face(src: string) {
    const f = faces.find((x) => x.src.includes(src));
    expect(f, `no face loading ${src}`).toBeDefined();
    return f;
}

// Lets already-queued promise callbacks run.
async function flush() {
    for (let i = 0; i < 5; i++) {
        await Promise.resolve();
    }
}

async function freshLoadFonts() {
    vi.resetModules();
    return (await import("./fontutil")).loadFonts;
}

describe("loadFonts", () => {
    beforeEach(() => {
        faces = [];
        vi.stubGlobal("FontFace", FakeFontFace);
        vi.stubGlobal("document", { fonts: { add: vi.fn() } });
        vi.spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("starts loading every face", async () => {
        const loadFonts = await freshLoadFonts();
        void loadFonts();
        expect(faces.map((f) => f.src.replace(/^url\('fonts\/|'\)$/g, "")).sort()).toEqual([
            "hacknerdmono-bold.ttf",
            "hacknerdmono-bolditalic.ttf",
            "hacknerdmono-italic.ttf",
            "hacknerdmono-regular.ttf",
            "inter-variable.woff2",
            "jetbrains-mono-v13-latin-200.woff2",
            "jetbrains-mono-v13-latin-700.woff2",
            "jetbrains-mono-v13-latin-regular.woff2",
        ]);
    });

    it("resolves once Hack regular and Inter are loaded, without waiting for the other faces", async () => {
        const loadFonts = await freshLoadFonts();
        let done = false;
        void loadFonts().then(() => {
            done = true;
        });
        face("hacknerdmono-regular.ttf").deferred.resolve();
        await flush();
        expect(done).toBe(false);
        face("inter-variable.woff2").deferred.resolve();
        await flush();
        expect(done).toBe(true);
    });

    it.each(["hacknerdmono-regular.ttf", "inter-variable.woff2"])("stays pending while %s is loading", async (src) => {
        const loadFonts = await freshLoadFonts();
        let done = false;
        void loadFonts().then(() => {
            done = true;
        });
        for (const f of faces) {
            if (!f.src.includes(src)) {
                f.deferred.resolve();
            }
        }
        await flush();
        expect(done).toBe(false);
    });

    it("does not block on a failed gating font", async () => {
        const loadFonts = await freshLoadFonts();
        let done = false;
        void loadFonts().then(() => {
            done = true;
        });
        face("hacknerdmono-regular.ttf").deferred.reject(new Error("404"));
        face("inter-variable.woff2").deferred.resolve();
        await flush();
        expect(done).toBe(true);
    });

    it("is idempotent: a second call loads nothing new and resolves with the same gate", async () => {
        const loadFonts = await freshLoadFonts();
        const first = loadFonts();
        const count = faces.length;
        const second = loadFonts();
        expect(faces.length).toBe(count);
        face("hacknerdmono-regular.ttf").deferred.resolve();
        face("inter-variable.woff2").deferred.resolve();
        await Promise.all([first, second]);
    });
});
