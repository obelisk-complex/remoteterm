// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// @vitest-environment happy-dom

import { globalStore } from "@/app/store/jotaiStore";
import { modalsModel } from "@/store/modalmodel";
import { act, cleanup, render, screen } from "@testing-library/react";
import { Provider } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ evaluated: [] as string[], clientAtom: null as any }));

vi.mock("@/app/store/client-model", async () => {
    const { atom } = await import("jotai");
    h.clientAtom = atom({ tosagreed: true, meta: { "onboarding:lastversion": "v99.0.0" } });
    return { ClientModel: { getInstance: () => ({ clientAtom: h.clientAtom }) } };
});
vi.mock("@/store/global", async () => {
    const { atom } = await import("jotai");
    return { atoms: { modalOpen: atom(false) }, globalPrimaryTabStartup: false };
});
vi.mock("@/app/onboarding/onboarding", async () => {
    h.evaluated.push("onboarding");
    await new Promise((r) => setTimeout(r, 30));
    return { NewInstallOnboardingModal: () => <div data-testid="new-install" /> };
});
vi.mock("@/app/onboarding/onboarding-upgrade", async () => {
    h.evaluated.push("onboarding-upgrade");
    return { UpgradeOnboardingModal: () => <div data-testid="upgrade" /> };
});
vi.mock("@/app/onboarding/onboarding-upgrade-patch", async () => {
    h.evaluated.push("onboarding-upgrade-patch");
    await new Promise((r) => setTimeout(r, 30));
    return { UpgradeOnboardingPatch: () => <div data-testid="patch" /> };
});
vi.mock("@/app/modals/messagemodal", () => ({ MessageModal: () => <div data-testid="message" /> }));
vi.mock("@/app/modals/about", () => ({ AboutModal: () => null }));
vi.mock("@/app/modals/userinputprompt", () => ({ UserInputPrompt: () => null }));
vi.mock("@/builder/builder-apppanel", () => ({
    DeleteFileModal: () => null,
    PublishAppModal: () => null,
    RenameFileModal: () => null,
}));
vi.mock("@/builder/tabs/builder-secrettab", () => ({ SetSecretDialog: () => null }));

import { ModalsRenderer } from "./modalsrenderer";

function renderModals() {
    return render(
        <Provider store={globalStore}>
            <ModalsRenderer />
        </Provider>
    );
}

beforeEach(() => {
    globalStore.set(h.clientAtom, { tosagreed: true, meta: { "onboarding:lastversion": "v99.0.0" } });
    globalStore.set(modalsModel.modalsAtom, []);
    globalStore.set(modalsModel.newInstallOnboardingOpen, false);
    globalStore.set(modalsModel.upgradeOnboardingOpen, false);
});

afterEach(() => {
    cleanup();
});

describe("ModalsRenderer lazy onboarding", () => {
    it("loads no onboarding module until an onboarding modal is shown", () => {
        // Importing the renderer and mounting it with nothing open must not touch the onboarding code.
        renderModals();
        expect(h.evaluated).toEqual([]);
    });

    it("shows the new-install onboarding after it has loaded", async () => {
        globalStore.set(h.clientAtom, { tosagreed: false, meta: {} });
        renderModals();
        expect(screen.queryByTestId("new-install")).toBeNull();
        expect(await screen.findByTestId("new-install")).toBeTruthy();
        expect(h.evaluated).toContain("onboarding");
    });

    it("shows the upgrade onboarding once it has loaded", async () => {
        renderModals();
        await act(async () => {
            globalStore.set(modalsModel.upgradeOnboardingOpen, true);
        });
        expect(await screen.findByTestId("upgrade")).toBeTruthy();
    });

    it("does not hide an already-available modal while a lazy one loads", async () => {
        renderModals();
        await act(async () => {
            modalsModel.pushModal("MessageModal");
            modalsModel.pushModal("UpgradeOnboardingPatch", { isReleaseNotes: true });
        });
        expect(screen.getByTestId("message")).toBeTruthy();
        expect(screen.queryByTestId("patch")).toBeNull();
        expect(await screen.findByTestId("patch")).toBeTruthy();
        expect(screen.getByTestId("message")).toBeTruthy();
    });
});
