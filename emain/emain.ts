// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { RpcApi } from "@/app/store/wshclientapi";
import * as electron from "electron";
import { focusedBuilderWindow, getAllBuilderWindows } from "emain/emain-builder";
import { globalEvents } from "emain/emain-events";
import { sprintf } from "sprintf-js";
import * as services from "../frontend/app/store/services";
import { initElectronWshrpc, shutdownWshrpc } from "../frontend/app/store/wshrpcutil-base";
import { setElectronNet } from "../frontend/util/fetchutil";
import { fireAndForget } from "../frontend/util/util";
import { AuthKey, configureAuthKeyRequestInjection } from "./authkey";
import {
    getActivityState,
    getForceQuit,
    getGlobalIsRelaunching,
    getUserConfirmedQuit,
    setForceQuit,
    setGlobalIsQuitting,
    setGlobalIsStarting,
    setUserConfirmedQuit,
    setWasActive,
    setWasInFg,
} from "./emain-activity";
import { initIpcHandlers } from "./emain-ipc";
import { registerNativeThemeListener } from "./emain-native-theme";
import { log } from "./emain-log";
import { initMenuEventSubscriptions, makeAndSetAppMenu, makeDockTaskbar } from "./emain-menu";
import { formatRssSampleLine, summarizeProcessMetrics } from "./emain-rss-monitor";
import {
    checkIfRunningUnderARM64Translation,
    getElectronAppBasePath,
    getElectronAppUnpackedBasePath,
    getElectronUserDataDir,
    getMigrationFailures,
    getRemoteTermConfigDir,
    getRemoteTermDataDir,
    getWebviewPreloadPath,
    isDev,
    isRemoteTermIsolatedProfileActive,
    resolveIncompleteMigrationBlock,
    resolveLegacyInstanceBlock,
    unameArch,
    unamePlatform,
} from "./emain-platform";
import { ensureHotSpareTab, setMaxTabCacheSize } from "./emain-tabview";
import { hardenWebviewAttach, installPermissionHandlers, isAppWebContentsId } from "./emain-websecurity";
import { getIsRemoteTermSrvDead, getRemoteTermSrvProc, getRemoteTermSrvReady, runRemoteTermSrv } from "./emain-remotetermsrv";
import {
    createBrowserWindow,
    createNewRemoteTermWindow,
    focusedRemoteTermWindow,
    getAllRemoteTermWindows,
    getQuakeWindow,
    getRemoteTermWindowById,
    getRemoteTermWindowByWorkspaceId,
    initGlobalHotkeyEventSubscription,
    registerGlobalHotkey,
    relaunchBrowserWindows,
    RemoteTermBrowserWindow,
} from "./emain-window";
import { ElectronWshClient, initElectronWshClient } from "./emain-wsh";
import { getLaunchSettings } from "./launchsettings";


const electronApp = electron.app;
setElectronNet(electron.net);

let confirmQuit = true;

const remoteTermDataDir = getRemoteTermDataDir();
const remoteTermConfigDir = getRemoteTermConfigDir();

electron.nativeTheme.themeSource = "system";
registerNativeThemeListener();

console.log = log;
console.log(
    sprintf(
        "remoteterm-app starting, data_dir=%s, config_dir=%s electronpath=%s gopath=%s arch=%s/%s electron=%s",
        remoteTermDataDir,
        remoteTermConfigDir,
        getElectronAppBasePath(),
        getElectronAppUnpackedBasePath(),
        unamePlatform,
        unameArch,
        process.versions.electron
    )
);
if (isDev) {
    console.log("remoteterm-app REMOTETERM_DEV set");
}

function handleWSEvent(evtMsg: WSEventType) {
    fireAndForget(async () => {
        console.log("handleWSEvent", evtMsg?.eventtype);
        if (evtMsg.eventtype == "electron:newwindow") {
            console.log("electron:newwindow", evtMsg.data);
            const windowId: string = evtMsg.data;
            const windowData: WaveWindow = (await services.ObjectService.GetObject("window:" + windowId)) as WaveWindow;
            if (windowData == null) {
                return;
            }
            const fullConfig = await RpcApi.GetFullConfigCommand(ElectronWshClient);
            const newWin = await createBrowserWindow(windowData, fullConfig, {
                unamePlatform,
                isPrimaryStartupWindow: false,
            });
            newWin.show();
        } else if (evtMsg.eventtype == "electron:closewindow") {
            console.log("electron:closewindow", evtMsg.data);
            if (evtMsg.data === undefined) return;
            const ww = getRemoteTermWindowById(evtMsg.data);
            if (ww != null) {
                ww.destroy(); // bypass the "are you sure?" dialog
            }
        } else if (evtMsg.eventtype == "electron:updateactivetab") {
            const activeTabUpdate: { workspaceid: string; newactivetabid: string } = evtMsg.data;
            console.log("electron:updateactivetab", activeTabUpdate);
            const ww = getRemoteTermWindowByWorkspaceId(activeTabUpdate.workspaceid);
            if (ww == null) {
                return;
            }
            await ww.setActiveTab(activeTabUpdate.newactivetabid, false);
        } else {
            console.log("unhandled electron ws eventtype", evtMsg.eventtype);
        }
    });
}

// this isn't perfect, but gets the job done without being complicated
function runActiveTimer() {    setTimeout(runActiveTimer, 60000);
}

const RssSampleIntervalMs = 5 * 60 * 1000;

// Trend data for chasing renderer-death/OOM reports (see [render-process-gone] logging in
// emain-tab-lifecycle.ts) — a single manual `ps` snapshot can't distinguish "always been this
// high" from "grew over hours", this can.
function sampleRss() {
    const samples = summarizeProcessMetrics(electronApp.getAppMetrics());
    console.log(formatRssSampleLine(samples, Date.now()));
}

function startRssMonitor() {
    sampleRss();
    setInterval(sampleRss, RssSampleIntervalMs);
}

function hideWindowWithCatch(window: RemoteTermBrowserWindow) {
    if (window == null) {
        return;
    }
    try {
        if (window.isDestroyed()) {
            return;
        }
        window.hide();
    } catch (e) {
        console.log("error hiding window", e);
    }
}

electronApp.on("session-created", installPermissionHandlers);
electronApp.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (event, webPreferences, params) => {
        if (
            !isAppWebContentsId(contents.id) ||
            !hardenWebviewAttach(webPreferences, params, getWebviewPreloadPath())
        ) {
            event.preventDefault();
        }
    });
});

electronApp.on("window-all-closed", () => {
    if (getGlobalIsRelaunching()) {
        return;
    }
    if (unamePlatform !== "darwin") {
        setUserConfirmedQuit(true);
        electronApp.quit();
    }
});
electronApp.on("before-quit", (e) => {
    const allWindows = getAllRemoteTermWindows();
    const allBuilders = getAllBuilderWindows();
    if (
        confirmQuit &&
        !getForceQuit() &&
        !getUserConfirmedQuit() &&
        (allWindows.length > 0 || allBuilders.length > 0) &&
        !getIsRemoteTermSrvDead() &&
        !process.env.REMOTETERM_NOCONFIRMQUIT
    ) {
        e.preventDefault();
        const choice = electron.dialog.showMessageBoxSync(null, {
            type: "question",
            buttons: ["Cancel", "Quit"],
            title: "Confirm Quit",
            message: "Are you sure you want to quit RemoteTerm?",
            defaultId: 0,
            cancelId: 0,
        });
        if (choice === 0) {
            return;
        }
        setUserConfirmedQuit(true);
        electronApp.quit();
        return;
    }
    setGlobalIsQuitting(true);

    if (unamePlatform == "win32") {
        // win32 doesn't have a SIGINT, so we just let electron die, which
        // ends up killing remotetermsrv via closing it's stdin.
        return;
    }
    getRemoteTermSrvProc()?.kill("SIGINT");
    shutdownWshrpc();
    if (getForceQuit()) {
        return;
    }
    e.preventDefault();
    for (const window of allWindows) {
        hideWindowWithCatch(window);
    }
    for (const builder of allBuilders) {
        builder.hide();
    }
    if (getIsRemoteTermSrvDead()) {
        console.log("remotetermsrv is dead, quitting immediately");
        setForceQuit(true);
        electronApp.quit();
        return;
    }
    setTimeout(() => {
        console.log("waiting for remotetermsrv to exit...");
        setForceQuit(true);
        electronApp.quit();
    }, 3000);
});
process.on("SIGINT", () => {
    console.log("Caught SIGINT, shutting down");
    setUserConfirmedQuit(true);
    electronApp.quit();
});
process.on("SIGHUP", () => {
    console.log("Caught SIGHUP, shutting down");
    setUserConfirmedQuit(true);
    electronApp.quit();
});
process.on("SIGTERM", () => {
    console.log("Caught SIGTERM, shutting down");
    setUserConfirmedQuit(true);
    electronApp.quit();
});
let caughtException = false;
process.on("uncaughtException", (error) => {
    if (caughtException) {
        return;
    }

    // Check if the error is related to QUIC protocol, if so, ignore (can happen during network changes)
    if (error?.message?.includes("net::ERR_QUIC_PROTOCOL_ERROR")) {
        console.log("Ignoring QUIC protocol error:", error.message);
        console.log("Stack Trace:", error.stack);
        return;
    }

    caughtException = true;
    console.log("Uncaught Exception, shutting down: ", error);
    console.log("Stack Trace:", error.stack);
    // Optionally, handle cleanup or exit the app
    setUserConfirmedQuit(true);
    electronApp.quit();
});

let lastRemoteTermWindowCount = 0;
let lastIsBuilderWindowActive = false;
globalEvents.on("windows-updated", () => {
    const wwCount = getAllRemoteTermWindows().length;
    const isBuilderActive = focusedBuilderWindow != null;
    if (wwCount == lastRemoteTermWindowCount && isBuilderActive == lastIsBuilderWindowActive) {
        return;
    }
    lastRemoteTermWindowCount = wwCount;
    lastIsBuilderWindowActive = isBuilderActive;
    console.log("windows-updated", wwCount, "builder-active:", isBuilderActive);
    makeAndSetAppMenu();
});

async function appMain() {
    // Set disableHardwareAcceleration as early as possible, if required.
    const launchSettings = getLaunchSettings();
    if (launchSettings?.["window:disablehardwareacceleration"]) {
        console.log("disabling hardware acceleration, per launch settings");
        electronApp.disableHardwareAcceleration();
    }
    const startTs = Date.now();
    // Only relocate userData for a launch that explicitly opted in via REMOTETERM_ISOLATED_PROFILE=1:
    // the lock is keyed on Electron's userData path, which otherwise defaults to a fixed OS path
    // regardless of REMOTETERM_CONFIG_HOME/REMOTETERM_DATA_HOME, so an isolated dev/test launch's
    // lock collided with an unrelated already-running instance and spawned a phantom window in it
    // (see getElectronUserDataDir). A real launch — even one with REMOTETERM_CONFIG_HOME/_DATA_HOME/
    // _HOME left over in a persistent shell profile from before the rebrand — must NOT relocate:
    // that path is where an existing install's actual Chromium profile (cookies, web-block logins)
    // already lives, and there's no migration for it — moving it unconditionally would silently
    // reset every upgrading user's session with no warning. Isolated dev/test launch scripts must
    // set REMOTETERM_ISOLATED_PROFILE=1 together with REMOTETERM_CONFIG_HOME and REMOTETERM_DATA_HOME.
    if (isRemoteTermIsolatedProfileActive()) {
        electronApp.setPath("userData", getElectronUserDataDir());
    }
    const instanceLock = electronApp.requestSingleInstanceLock();
    if (!instanceLock) {
        console.log("remoteterm-app could not get single-instance-lock, shutting down");
        setUserConfirmedQuit(true);
        electronApp.quit();
        return;
    }
    // Must run before the server starts: the server would create the new data and config dirs
    // next to the live legacy ones; quitting leaves the migration to retry on the next launch.
    if (!(await resolveLegacyInstanceBlock())) {
        setUserConfirmedQuit(true);
        electronApp.quit();
        return;
    }
    if (!(await resolveIncompleteMigrationBlock())) {
        setUserConfirmedQuit(true);
        electronApp.quit();
        return;
    }
    electronApp.on("second-instance", (_event, argv, workingDirectory) => {
        console.log("second-instance event, argv:", argv, "workingDirectory:", workingDirectory);
        fireAndForget(createNewRemoteTermWindow);
    });
    try {
        await runRemoteTermSrv(handleWSEvent);
    } catch (e) {
        console.log(e.toString());
    }
    const ready = await getRemoteTermSrvReady();
    console.log("remotetermsrv ready signal received", ready, Date.now() - startTs, "ms");
    await electronApp.whenReady();
    const migrationFailures = getMigrationFailures();
    if (migrationFailures.length > 0) {
        electron.dialog.showErrorBox(
            "RemoteTerm Data Migration Issue",
            "RemoteTerm could not fully migrate your existing data to its new storage location. " +
                "Some data may be temporarily inaccessible until this is resolved manually.\n\n" +
                migrationFailures.join("\n")
        );
    }
    configureAuthKeyRequestInjection(electron.session.defaultSession);
    initIpcHandlers();

    try {
        initElectronWshClient();
        initElectronWshrpc(ElectronWshClient, { authKey: AuthKey });
    } catch (e) {
        console.log("error initializing wshrpc", e);
    }
    const fullConfig = await RpcApi.GetFullConfigCommand(ElectronWshClient);
    // After GetFullConfig, not before: a subscription made before the socket opens queues ahead of
    // it and the WS queue drains one message per 100 ms. The menu is first built below, after this.
    try {
        initMenuEventSubscriptions();
    } catch (e) {
        console.log("error initializing menu event subscriptions", e);
    }
    checkIfRunningUnderARM64Translation(fullConfig);
    if (fullConfig?.settings?.["app:confirmquit"] != null) {
        confirmQuit = fullConfig.settings["app:confirmquit"];
    }
    ensureHotSpareTab(fullConfig);
    await relaunchBrowserWindows(fullConfig);
    setTimeout(runActiveTimer, 5000); // start active timer, wait 5s just to be safe
    startRssMonitor();
    makeAndSetAppMenu();
    makeDockTaskbar();

    setGlobalIsStarting(false);
    if (fullConfig?.settings?.["window:maxtabcachesize"] != null) {
        setMaxTabCacheSize(fullConfig.settings["window:maxtabcachesize"]);
    }

    electronApp.on("activate", () => {
        const allWindows = getAllRemoteTermWindows();
        const anyVisible = allWindows.some((w) => !w.isDestroyed() && w.isVisible());
        if (anyVisible) {
            return;
        }
        const qw = getQuakeWindow();
        if (qw != null && !qw.isDestroyed()) {
            qw.show();
            qw.focus();
            return;
        }
        if (allWindows.length === 0) {
            fireAndForget(createNewRemoteTermWindow);
        }
    });
    // Sleep/wake detection across platforms:
    //
    //   macOS: powerMonitor.on('resume') fires reliably after system sleep/wake.
    //
    //   Linux:  powerMonitor.on('resume') may fire depending on the desktop
    //           environment (GNOME/KDE typically emit it; bare window managers
    //           and certain Wayland compositors may not). As a fallback,
    //           powerMonitor.on('unlock-screen') fires when the user unlocks
    //           the session after suspend-to-RAM (logind tracks this reliably).
    //
    //   Windows: powerMonitor.on('resume') fires after modern standby / S3
    //            sleep via WM_POWERBROADCAST. powerMonitor.on('unlock-screen')
    //            fires on session unlock (Win+L / sleep→unlock).
    //
    // Additional coverage: the frontend VisibilityReconnectHandler
    // (visibilityreconnect.tsx) runs on window focus and document visibility
    // change, providing an app-level safety net on all platforms.
    //
    electron.powerMonitor.on("resume", () => {
        console.log("system resumed from sleep, notifying server (powerMonitor resume)");
        fireAndForget(async () => {
            try {
                await RpcApi.NotifySystemResumeCommand(ElectronWshClient, { noresponse: true });
            } catch (e) {
                console.log("error calling NotifySystemResumeCommand", e);
            }
        });
    });
    // Non-macOS fallback: 'unlock-screen' fires on session unlock (Linux/Windows).
    // Redundant on macOS (where 'resume' covers it), but harmless.
    if (unamePlatform !== "darwin") {
        electron.powerMonitor.on("unlock-screen", () => {
            console.log("system unlocked, notifying server (unlock-screen fallback)");
            fireAndForget(async () => {
                try {
                    await RpcApi.NotifySystemResumeCommand(ElectronWshClient, { noresponse: true });
                } catch (e) {
                    console.log("error calling NotifySystemResumeCommand (unlock-screen)", e);
                }
            });
        });
    }
    const rawGlobalHotKey = launchSettings?.["app:globalhotkey"];
    if (rawGlobalHotKey) {
        registerGlobalHotkey(rawGlobalHotKey);
    }
    initGlobalHotkeyEventSubscription();
}

appMain().catch((e) => {
    console.log("appMain error", e);
    setUserConfirmedQuit(true);
    electronApp.quit();
});
