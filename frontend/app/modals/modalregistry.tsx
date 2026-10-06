// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { MessageModal } from "@/app/modals/messagemodal";
import { DeleteFileModal, PublishAppModal, RenameFileModal } from "@/builder/builder-apppanel";
import { SetSecretDialog } from "@/builder/tabs/builder-secrettab";
import { lazy } from "react";
import { AboutModal } from "./about";
import { UserInputPrompt } from "./userinputprompt";

// The onboarding screens run once per install or release but pull in the markdown, syntax
// highlighting and editor libraries, so they load on first use. Render them inside their own <Suspense>.
export const NewInstallOnboardingModal = lazy(() =>
    import("@/app/onboarding/onboarding").then((m) => ({ default: m.NewInstallOnboardingModal }))
);
export const UpgradeOnboardingModal = lazy(() =>
    import("@/app/onboarding/onboarding-upgrade").then((m) => ({ default: m.UpgradeOnboardingModal }))
);
const UpgradeOnboardingPatch = lazy(() =>
    import("@/app/onboarding/onboarding-upgrade-patch").then((m) => ({ default: m.UpgradeOnboardingPatch }))
);

const modalRegistry: { [key: string]: React.ComponentType<any> } = {
    NewInstallOnboardingModal,
    UpgradeOnboardingModal,
    UpgradeOnboardingPatch,
    [UserInputPrompt.displayName || "UserInputPrompt"]: UserInputPrompt,
    [AboutModal.displayName || "AboutModal"]: AboutModal,
    [MessageModal.displayName || "MessageModal"]: MessageModal,
    [PublishAppModal.displayName || "PublishAppModal"]: PublishAppModal,
    [RenameFileModal.displayName || "RenameFileModal"]: RenameFileModal,
    [DeleteFileModal.displayName || "DeleteFileModal"]: DeleteFileModal,
    [SetSecretDialog.displayName || "SetSecretDialog"]: SetSecretDialog,
};

export const getModalComponent = (key: string): React.ComponentType<any> | undefined => {
    return modalRegistry[key];
};
