// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { CurrentOnboardingVersion } from "@/app/onboarding/onboarding-common";
import { ClientModel } from "@/app/store/client-model";
import { globalStore } from "@/app/store/jotaiStore";
import { atoms, globalPrimaryTabStartup } from "@/store/global";
import { modalsModel } from "@/store/modalmodel";
import * as jotai from "jotai";
import { Suspense, useEffect } from "react";
import * as semver from "semver";
import { getModalComponent, NewInstallOnboardingModal, UpgradeOnboardingModal } from "./modalregistry";

const ModalsRenderer = () => {
    const clientData = jotai.useAtomValue(ClientModel.getInstance().clientAtom);
    const [newInstallOnboardingOpen, setNewInstallOnboardingOpen] = jotai.useAtom(modalsModel.newInstallOnboardingOpen);
    const [upgradeOnboardingOpen, setUpgradeOnboardingOpen] = jotai.useAtom(modalsModel.upgradeOnboardingOpen);
    const [modals] = jotai.useAtom(modalsModel.modalsAtom);

    const rtn: React.ReactElement[] = [];
    for (const modal of modals) {
        const ModalComponent = getModalComponent(modal.displayName);
        if (ModalComponent) {
            rtn.push(
                <Suspense key={modal.displayName} fallback={null}>
                    <ModalComponent {...modal.props} />
                </Suspense>
            );
        }
    }
    // User input prompts are now rendered per-block in UserInputPromptOverlay
    if (newInstallOnboardingOpen) {
        rtn.push(
            <Suspense key="NewInstallOnboardingModal" fallback={null}>
                <NewInstallOnboardingModal />
            </Suspense>
        );
    }
    if (upgradeOnboardingOpen) {
        rtn.push(
            <Suspense key="UpgradeOnboardingModal" fallback={null}>
                <UpgradeOnboardingModal />
            </Suspense>
        );
    }
    useEffect(() => {
        if (!clientData.tosagreed) {
            setNewInstallOnboardingOpen(true);
        }
    }, [clientData]);

    useEffect(() => {
        if (!globalPrimaryTabStartup) {
            return;
        }
        if (!clientData.tosagreed) {
            return;
        }
        const lastVersion = clientData.meta?.["onboarding:lastversion"] ?? "v0.0.0";
        if (semver.lt(lastVersion, CurrentOnboardingVersion)) {
            setUpgradeOnboardingOpen(true);
        }
    }, []);
    useEffect(() => {
        const hasBlockingModals = rtn.length > 0;
        globalStore.set(atoms.modalOpen, hasBlockingModals);
    }, [rtn]);

    return <>{rtn}</>;
};

export { ModalsRenderer };
