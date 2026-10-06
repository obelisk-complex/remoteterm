// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// @vitest-environment happy-dom

import { beforeEach, describe, expect, test, vi } from "vitest";

const fetchMock = vi.fn();

vi.mock("@/util/fetchutil", () => ({ fetch: (...a: any[]) => fetchMock(...a) }));
vi.mock("@/util/endpoints", () => ({ getWebServerEndpoint: () => "http://127.0.0.1:1234" }));
vi.mock("@/app/store/windowtype", () => ({ isPreviewWindow: () => false }));
vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: vi.fn() }));
vi.mock("./services", () => ({ ObjectService: {} }));

import { callBackendService } from "./wos";

describe("callBackendService request body", () => {
    beforeEach(() => {
        fetchMock.mockReset();
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: null }) });
    });

    // A large string body is copied into Blink's buffer partition and stays there until a major GC;
    // a Blob hands the bytes to the browser process instead.
    test("sends the JSON call as a Blob with the same bytes as the string body", async () => {
        const args = ["block-1", "state é╭─╮\x1b[31m".repeat(1000), "full", 0, { rows: 25, cols: 80 }, ""];
        await callBackendService("block", "SaveTerminalState", args, true);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe("http://127.0.0.1:1234/wave/service?service=block&method=SaveTerminalState");
        expect(init.method).toBe("POST");
        expect(init.body).toBeInstanceOf(Blob);

        const expected = JSON.stringify({ service: "block", method: "SaveTerminalState", args, uicontext: null });
        expect(init.body.size).toBe(new TextEncoder().encode(expected).length);
        expect(await init.body.text()).toBe(expected);
    });
});
