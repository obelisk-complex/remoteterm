// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { makeMockWaveEnv } from "@/preview/mock/mockwaveenv";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { atom } from "jotai";
import { getWebPreviewDisplayUrl, safeIsDevToolsOpened, WebViewModel, WebViewPreviewFallback } from "./webview";

describe("safeIsDevToolsOpened", () => {
    it("returns false for a null/undefined webview", () => {
        expect(safeIsDevToolsOpened(null)).toBe(false);
        expect(safeIsDevToolsOpened(undefined)).toBe(false);
    });

    it("returns the underlying value when the guest WebContents is alive", () => {
        const webview = { isDevToolsOpened: () => true } as any;
        expect(safeIsDevToolsOpened(webview)).toBe(true);
    });

    it("returns false instead of throwing when the guest WebContents is already destroyed", () => {
        const webview = {
            isDevToolsOpened: () => {
                throw new Error("Invalid guestInstanceId: 6");
            },
        } as any;
        expect(safeIsDevToolsOpened(webview)).toBe(false);
    });
});

describe("webview preview fallback", () => {
    it("shows the requested URL", () => {
        const markup = renderToStaticMarkup(<WebViewPreviewFallback url="https://example.com/docs" />);

        expect(markup).toContain("electron webview unavailable");
        expect(markup).toContain("https://example.com/docs");
    });

    it("falls back to about:blank when no URL is available", () => {
        expect(getWebPreviewDisplayUrl("")).toBe("about:blank");
        expect(getWebPreviewDisplayUrl(null)).toBe("about:blank");
    });

    it("uses the supplied env for homepage atoms and config updates", async () => {
        const blockId = "webview-env-block";
        const env = makeMockWaveEnv({
            settings: {
                "web:defaulturl": "https://default.example",
            },
            mockWaveObjs: {
                [`block:${blockId}`]: {
                    otype: "block",
                    oid: blockId,
                    version: 1,
                    meta: {
                        pinnedurl: "https://block.example",
                    },
                } as Block,
            },
        });
        const model = new WebViewModel({
            blockId,
            nodeModel: {
                isFocused: atom(true),
                focusNode: () => {},
            } as any,
            tabModel: {} as any,
            waveEnv: env,
        });

        expect(globalStore.get(model.homepageUrl)).toBe("https://block.example");

        await model.setHomepageUrl("https://global.example", "global");

        expect(globalStore.get(model.homepageUrl)).toBe("https://global.example");
        expect(globalStore.get(env.getSettingsKeyAtom("web:defaulturl"))).toBe("https://global.example");
        expect(globalStore.get(env.wos.getWaveObjectAtom<Block>(`block:${blockId}`))?.meta?.pinnedurl).toBeUndefined();
    });
});
