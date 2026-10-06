// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { fireAndForget } from "@/util/util";
import { execFileSync } from "child_process";
import { app, dialog, ipcMain, shell } from "electron";
import envPaths from "env-paths";
import {
    Dirent,
    existsSync,
    mkdirSync,
    readdirSync,
    readlinkSync,
    renameSync,
    rmdirSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "fs";
import os from "os";
import path from "path";
import { RemoteTermDevVarName, RemoteTermDevViteVarName } from "../frontend/util/isdev";
import * as keyutil from "../frontend/util/keyutil";

// ElectronUserDataPath does NOT determine where Electron's own runtime data (userData) actually
// lives — see getElectronUserDataDir's doc comment below for why this app.setName() call is
// superseded by the later app.setName(isDev ? "RemoteTerm (Dev)" : "RemoteTerm") call and has no
// effect on userData path resolution. This constant is read only by performDataDirMigration().
const ElectronUserDataPath = ["remoteterm", "electron"];
app.setName(ElectronUserDataPath.join("/"));

const isDev = !app.isPackaged;
const isDevVite = isDev && process.env.ELECTRON_RENDERER_URL;
console.log(`Running in ${isDev ? "development" : "production"} mode`);
if (isDev) {
    process.env[RemoteTermDevVarName] = "1";
}
if (isDevVite) {
    process.env[RemoteTermDevViteVarName] = "1";
}

const remoteTermDirNamePrefix = "remoteterm";
const remoteTermDirNameSuffix = isDev ? "dev" : "";
const remoteTermDirName = `${remoteTermDirNamePrefix}${remoteTermDirNameSuffix ? `-${remoteTermDirNameSuffix}` : ""}`;

// Frozen forever: this is the real pre-rename legacy directory prefix on disk, independent of
// whatever the product is branded as today. Never derive this from remoteTermDirNamePrefix.
const legacyRemoteTermDirNamePrefix = "waveterm";
const legacyRemoteTermDirName = `${legacyRemoteTermDirNamePrefix}${remoteTermDirNameSuffix ? `-${remoteTermDirNameSuffix}` : ""}`;
// Upstream derived the combined-home dir from the dev-suffixed dir name (".waveterm-dev" in dev,
// ".waveterm" in prod) and never fell back from one to the other, so a dev build must not touch
// the production ".waveterm".
const LegacyRemoteTermHomeDirNameSuffixed = `.${legacyRemoteTermDirName}`;

const paths = envPaths("remoteterm", { suffix: remoteTermDirNameSuffix });
const legacyPaths = envPaths("waveterm", { suffix: remoteTermDirNameSuffix });

app.setName(isDev ? "RemoteTerm (Dev)" : "RemoteTerm");
const unamePlatform = process.platform;
const unameArch: string = process.arch;
keyutil.setKeyUtilPlatform(unamePlatform);

const RemoteTermConfigHomeVarName = "REMOTETERM_CONFIG_HOME";
const LegacyRemoteTermConfigHomeVarName = "WAVETERM_CONFIG_HOME";
const RemoteTermDataHomeVarName = "REMOTETERM_DATA_HOME";
const LegacyRemoteTermDataHomeVarName = "WAVETERM_DATA_HOME";
const RemoteTermHomeVarName = "REMOTETERM_HOME";
const LegacyRemoteTermHomeVarName = "WAVETERM_HOME";
// Explicit opt-in only isolated dev/test launch scripts should set. Unlike the three overrides
// above, this one has no legacy fallback and no persistent-shell-profile use case: it exists
// solely so an isolated launch can be told apart from a real user who has had e.g.
// WAVETERM_CONFIG_HOME set in their shell profile since before the rebrand (readOverrideEnvVar's
// vars are legitimately user-settable that way, so inferring "isolated" from their presence alone
// silently relocated a real user's Chromium profile on upgrade — see isRemoteTermIsolatedProfileActive).
const RemoteTermIsolatedProfileVarName = "REMOTETERM_ISOLATED_PROFILE";

const alreadyWarnedLegacyVars = new Set<string>();

/**
 * Reads a user-settable override var, preferring the new name but falling back to the
 * deprecated old name (with a one-time warning) so existing shell-profile overrides don't
 * silently stop working when this var is renamed.
 */
function readOverrideEnvVar(newName: string, legacyName: string): string {
    const newVal = process.env[newName];
    if (newVal) {
        return newVal;
    }
    const legacyVal = process.env[legacyName];
    if (legacyVal) {
        if (!alreadyWarnedLegacyVars.has(legacyName)) {
            alreadyWarnedLegacyVars.add(legacyName);
            console.log(`${legacyName} is deprecated, please use ${newName} instead`);
        }
        return legacyVal;
    }
    return null;
}

/**
 * One-time, synchronous local data-dir migration from the old "waveterm"-prefixed paths to the
 * new "remoteterm"-prefixed paths. Must run as a top-level statement in this module (not
 * exported/called from elsewhere) so it completes before any importer of this module's getters
 * (getRemoteTermConfigDir/getRemoteTermDataDir) can call them and side-effect-create the new directories
 * first. See RENAME_PLAN.md Phase 2 step 7 for why this exact placement is required.
 */
type MigrationRootSpec = {
    name: string;
    source: string;
    dest: string;
    overridden: boolean;
    // Returns why the existing source is not a real legacy root to migrate, or null if it is.
    sourceSkipReason?: () => string;
    // Given a non-empty destination's top-level entries, whether to merge into it instead of
    // aborting. An earlier build that skipped the legacy root, or a launch blocked by a running
    // legacy instance, may already have created the destination; without a merge that state
    // aborts on every launch.
    canMergeIntoDest?: (destEntries: string[]) => boolean;
};

// Written into the data dir by emain-log at module load, including on a launch that is blocked
// by a running legacy instance and quits before the server starts.
const EmainDataEntryNames = new Set(["logs", "rtapp.log"]);

const MigrationMarkerFileName = ".migrated-from-waveterm";
// Present in a destination while a merge into it is unfinished. Once some entries have moved, the
// destination no longer passes canMergeIntoDest and the source may have lost the file that
// qualified it (wave.lock), so this marker alone lets a later launch finish the merge.
const MigrationInProgressFileName = ".migrating-from-waveterm";
const LegacyLockFileName = "wave.lock";
// pkg/secretstore keeps the encrypted secret store in the config root.
const LegacySecretsFileName = "secrets.enc";

// Most failures recorded here don't stop startup (the app can still run against whatever it can
// resolve), but they leave data unmigrated/orphaned and the failure becomes sticky (the next
// launch's "destination already exists and is unmarked" abort branch fires permanently), so a
// console.log alone isn't enough. getMigrationFailures() lets emain.ts surface these to the
// user once Electron is actually ready to show a dialog (this module's own top level runs
// before `app` is ready, so it can only log, not show UI).
const migrationFailures: string[] = [];
// Set when a root's legacy data was left unmoved or half-merged. Starting the server then would
// create a fresh database in the destination that a later launch can no longer merge past.
let migrationIncomplete = false;

function recordMigrationFailure(message: string, err?: unknown) {
    migrationFailures.push(message);
    if (err !== undefined) {
        console.error(`[migration] ${message}`, err);
    } else {
        console.error(`[migration] ${message}`);
    }
}

function recordIncompleteMigration(message: string, err?: unknown) {
    migrationIncomplete = true;
    recordMigrationFailure(message, err);
}

export function getMigrationFailures(): string[] {
    return [...migrationFailures];
}

/**
 * Must be awaited before the server starts, after resolveLegacyInstanceBlock(). When a root's
 * migration failed part-way, shows the failures and resolves false so this launch quits and the
 * next one resumes against the destination as this one left it.
 */
export async function resolveIncompleteMigrationBlock(): Promise<boolean> {
    if (!migrationIncomplete) {
        return true;
    }
    await app.whenReady();
    dialog.showErrorBox(
        "RemoteTerm Data Migration Issue",
        "RemoteTerm could not finish moving your existing data to its new storage location, so it will quit " +
            "without opening it. Fix the problem below and relaunch RemoteTerm; the migration continues where it stopped.\n\n" +
            migrationFailures.join("\n")
    );
    return false;
}

// The pre-rename app set its name to "waveterm/electron" in both dev and prod builds, so its
// Electron userData (and Chromium's SingletonLock) is at <appData>/waveterm/electron. The lock's
// holder is told apart by its executable (LegacyExecutableNames).
const LegacyElectronUserDataPath = ["waveterm", "electron"];
const SingletonLockFileName = "SingletonLock";
// Basename of the legacy app's main-process executable. electron-builder named the Linux binary
// after package.json "name" and the macOS one after "productName"; dev builds ran stock Electron.
const LegacyExecutableNames: Record<string, { prod: string; dev: string }> = {
    linux: { prod: "waveterm", dev: "electron" },
    darwin: { prod: "Wave", dev: "Electron" },
};

type LegacyInstanceState = {
    // True only for a live pid on this host; otherwise liveness could not be determined.
    confirmedRunning: boolean;
    // The holder is the other legacy flavour, which shares only the Electron profile with this one.
    otherFlavour?: boolean;
    reason: string;
};

let legacyInstanceChecked = false;
let legacyInstanceState: LegacyInstanceState = null;
let blockingLegacyInstance: LegacyInstanceState = null;
let ignoreLegacyInstance = false;

// Returns null when the executable cannot be read (another uid, exited, unsupported platform).
function readProcessExecutable(pid: number): string {
    try {
        if (process.platform === "linux") {
            return readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, "");
        }
        if (process.platform === "darwin") {
            const out = execFileSync("ps", ["-p", String(pid), "-o", "comm="], {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
                timeout: 2000,
            });
            return out.trim() || null;
        }
    } catch (e) {
        console.log(`[migration] could not read the executable of pid ${pid} (${e?.code ?? e})`);
    }
    return null;
}

// Node has no portable flock, so liveness comes from the legacy Electron process instead: Chromium
// keeps SingletonLock as a symlink to "<hostname>-<pid>" for as long as that app runs. A lock left
// by a crash can name a pid the OS has since given to an unrelated process, so a live pid counts
// as the legacy app only if its executable is the legacy app's. Windows is not checked: renaming
// a root fails there while the legacy app holds files open in it.
function checkLegacyInstanceRunning(): LegacyInstanceState {
    if (process.platform === "win32") {
        return null;
    }
    const lockPath = path.join(app.getPath("appData"), ...LegacyElectronUserDataPath, SingletonLockFileName);
    let target: string;
    try {
        target = readlinkSync(lockPath);
    } catch (e) {
        if (e?.code === "ENOENT") {
            return null;
        }
        return { confirmedRunning: false, reason: `could not read ${lockPath} (${e?.code ?? e})` };
    }
    const sepIdx = target.lastIndexOf("-");
    const hostname = target.slice(0, sepIdx);
    const pid = parseInt(target.slice(sepIdx + 1), 10);
    if (sepIdx <= 0 || !Number.isInteger(pid) || pid <= 0) {
        return { confirmedRunning: false, reason: `${lockPath} has an unrecognised target "${target}"` };
    }
    if (hostname !== os.hostname()) {
        return { confirmedRunning: false, reason: `${lockPath} was written by host "${hostname}"` };
    }
    try {
        process.kill(pid, 0);
    } catch (e) {
        if (e?.code === "ESRCH") {
            return null;
        }
    }
    const exe = readProcessExecutable(pid);
    if (exe == null) {
        return { confirmedRunning: false, reason: `pid ${pid} in ${lockPath} is running but could not be identified` };
    }
    const exeNames = LegacyExecutableNames[process.platform];
    const exeName = path.basename(exe);
    if (exeName !== exeNames?.prod && exeName !== exeNames?.dev) {
        return { confirmedRunning: false, reason: `pid ${pid} in ${lockPath} is running ${exe}` };
    }
    const holderIsDev = exeName === exeNames.dev;
    // Both flavours of the legacy app shared one userData dir and so one SingletonLock: the other
    // flavour holding it means this flavour is not running, but that profile (and its live lock)
    // still sits inside some production roots (see legacyInstanceBlocksRoot).
    const otherFlavour = holderIsDev !== isDev;
    // Stock Electron is shared by every `electron .` process, so a reused pid would match too.
    if (holderIsDev) {
        return {
            confirmedRunning: false,
            otherFlavour,
            reason: `pid ${pid} in ${lockPath} is running ${exe}, which could be the pre-rename dev build or any other Electron app`,
        };
    }
    return { confirmedRunning: true, otherFlavour, reason: `pid ${pid} (${exe}) holds ${lockPath}` };
}

// The shared legacy profile is inside the Linux config root and the macOS data root; moving either
// would move a running other-flavour app's profile and live SingletonLock into this build's userData.
function legacyInstanceBlocksRoot(state: LegacyInstanceState, source: string): boolean {
    if (!state.otherFlavour) {
        return true;
    }
    const profileDir = path.join(app.getPath("appData"), ...LegacyElectronUserDataPath);
    const rel = path.relative(source, profileDir);
    if (rel === "" || (rel.split(path.sep)[0] !== ".." && !path.isAbsolute(rel))) {
        return true;
    }
    console.log(`[migration] the lock is held by the other legacy build, whose profile is not in ${source}`);
    return false;
}

function getLegacyInstanceState(): LegacyInstanceState {
    if (!legacyInstanceChecked) {
        legacyInstanceChecked = true;
        legacyInstanceState = checkLegacyInstanceRunning();
    }
    return legacyInstanceState;
}

/**
 * Must be awaited before the server starts. When a pending migration was held back because a
 * pre-rename instance is (or may be) running, asks the user and resolves false if this launch
 * must quit: starting the server would create the new roots next to the live legacy ones.
 */
export async function resolveLegacyInstanceBlock(): Promise<boolean> {
    const block = blockingLegacyInstance;
    if (block == null) {
        return true;
    }
    await app.whenReady();
    if (block.confirmedRunning) {
        await dialog.showMessageBox({
            type: "warning",
            buttons: ["Quit"],
            title: "Wave Terminal Is Still Running",
            message: "Quit Wave Terminal, then relaunch RemoteTerm.",
            detail:
                "RemoteTerm needs to move your Wave Terminal data to its new location and cannot do that while Wave Terminal is running.\n\n" +
                `${block.reason}.`,
        });
        return false;
    }
    const { response } = await dialog.showMessageBox({
        type: "warning",
        buttons: ["Quit", "Migrate anyway"],
        defaultId: 0,
        cancelId: 0,
        title: "Wave Terminal May Still Be Running",
        message: "RemoteTerm could not confirm that Wave Terminal has quit.",
        detail:
            `${block.reason}.\n\n` +
            "If Wave Terminal is running, quit it and relaunch RemoteTerm: moving its data while it runs can break it. " +
            "If you are sure Wave Terminal is not running (for example after a crash), choose Migrate anyway.",
    });
    if (response !== 1) {
        return false;
    }
    console.log("[migration] user chose to migrate despite a possibly running WaveTerm");
    blockingLegacyInstance = null;
    ignoreLegacyInstance = true;
    performDataDirMigration();
    return true;
}

function migrateDataRoot(spec: MigrationRootSpec) {
    if (spec.overridden) {
        return;
    }
    const markerFile = path.join(spec.dest, MigrationMarkerFileName);
    if (existsSync(markerFile)) {
        return;
    }
    if (!existsSync(spec.source)) {
        console.log(`[migration] skipping ${spec.name} root: ${spec.source} does not exist`);
        return;
    }
    const resumeMerge = existsSync(path.join(spec.dest, MigrationInProgressFileName));
    const skipReason = resumeMerge ? null : spec.sourceSkipReason?.();
    if (skipReason) {
        console.log(`[migration] skipping ${spec.name} root: ${spec.source} ${skipReason}`);
        return;
    }
    const legacyInstance = ignoreLegacyInstance ? null : getLegacyInstanceState();
    if (legacyInstance && legacyInstanceBlocksRoot(legacyInstance, spec.source)) {
        blockingLegacyInstance = legacyInstance;
        console.log(
            `[migration] not migrating ${spec.name} root this launch: ${legacyInstance.reason}; will retry next launch`
        );
        return;
    }
    if (existsSync(spec.dest)) {
        let destEntries: string[];
        try {
            destEntries = readdirSync(spec.dest);
        } catch (e) {
            recordIncompleteMigration(`could not inspect existing destination ${spec.dest} for ${spec.name} root`, e);
            return;
        }
        if (destEntries.length === 0) {
            try {
                rmdirSync(spec.dest);
            } catch (e) {
                recordIncompleteMigration(`could not remove empty destination ${spec.dest} for ${spec.name} root`, e);
                return;
            }
        } else if (resumeMerge || spec.canMergeIntoDest?.(destEntries)) {
            mergeDataRoot(spec);
            return;
        } else {
            recordMigrationFailure(
                `${spec.name} root migration aborted: ${spec.dest} already exists and is not empty. Please merge ${spec.source} into ${spec.dest} manually.`
            );
            return;
        }
    }
    try {
        mkdirSync(path.dirname(spec.dest), { recursive: true });
        renameSync(spec.source, spec.dest);
        writeFileSync(
            path.join(spec.dest, MigrationMarkerFileName),
            `moved-from:${spec.source}\n${new Date().toISOString()}\n`
        );
        console.log(`[migration] migrated ${spec.name} root from ${spec.source} to ${spec.dest}`);
    } catch (e) {
        if (e && e.code === "ENOENT") {
            if (existsSync(markerFile)) {
                // another process already completed this root's migration
                return;
            }
            recordMigrationFailure(
                `${spec.name} root move failed with ENOENT and no completion marker was found (source: ${spec.source})`,
                e
            );
            return;
        }
        recordIncompleteMigration(`error migrating ${spec.name} root from ${spec.source} to ${spec.dest}`, e);
    }
}

// Electron's userData (Chromium profile) is kept whole on whichever side already has it: mixing
// files from two profiles is not a merge Chromium supports.
const UnmergeableDirNames = new Set(["electron"]);
const DatabaseDirName = "db";

type MergeResult = { merged: string[]; kept: string[] };

function mergeTree(source: string, dest: string, rel: string, result: MergeResult) {
    for (const ent of readdirSync(source, { withFileTypes: true })) {
        const relPath = rel ? path.join(rel, ent.name) : ent.name;
        const sourcePath = path.join(source, ent.name);
        const destPath = path.join(dest, ent.name);
        if (!existsSync(destPath)) {
            renameSync(sourcePath, destPath);
            result.merged.push(relPath);
            continue;
        }
        const destIsDir = statSync(destPath).isDirectory();
        if (ent.isDirectory() && destIsDir && !UnmergeableDirNames.has(relPath)) {
            mergeTree(sourcePath, destPath, relPath, result);
            continue;
        }
        result.kept.push(relPath);
    }
    if (rel && readdirSync(source).length === 0) {
        rmdirSync(source);
    }
}

// Moves every source entry the destination lacks into it and never overwrites a destination
// entry. Whatever cannot be moved stays in the source; the marker is written regardless so the
// state converges instead of re-reporting on every launch. A merge that throws part-way leaves
// the in-progress marker, and the next launch runs the same merge again over what is left.
function mergeDataRoot(spec: MigrationRootSpec) {
    const result: MergeResult = { merged: [], kept: [] };
    const inProgressFile = path.join(spec.dest, MigrationInProgressFileName);
    const sourceDb = path.join(spec.source, DatabaseDirName);
    const destDb = path.join(spec.dest, DatabaseDirName);
    // A database cannot be merged file by file, and the destination's may be the only copy of
    // work done since, so neither is touched.
    if (existsSync(sourceDb) && existsSync(destDb)) {
        recordIncompleteMigration(
            `${spec.name} root: ${destDb} already exists while your existing database is still in ${sourceDb}. ` +
                `RemoteTerm will not merge or delete either. If ${destDb} holds nothing you need (a failed earlier ` +
                `migration can leave an empty one), move it out of ${spec.dest} and relaunch RemoteTerm.`
        );
        return;
    }
    try {
        writeFileSync(inProgressFile, `merging-from:${spec.source}\n${new Date().toISOString()}\n`);
        mergeTree(spec.source, spec.dest, "", result);
        writeFileSync(
            path.join(spec.dest, MigrationMarkerFileName),
            `merged-from:${spec.source}\n${new Date().toISOString()}\n`
        );
    } catch (e) {
        recordIncompleteMigration(
            `error merging ${spec.name} root from ${spec.source} into ${spec.dest} (merged so far: ${result.merged.join(", ") || "nothing"})`,
            e
        );
        return;
    }
    try {
        unlinkSync(inProgressFile);
    } catch (e) {
        console.log(`[migration] could not remove ${inProgressFile} (${e?.code ?? e})`);
    }
    console.log(
        `[migration] merged ${spec.name} root from ${spec.source} into existing ${spec.dest}: ` +
            `merged [${result.merged.join(", ")}], kept destination copy of [${result.kept.join(", ")}]`
    );
    const keptUserFiles = result.kept.filter((p) => !UnmergeableDirNames.has(p));
    if (keptUserFiles.length > 0) {
        recordMigrationFailure(
            `${spec.name} root: ${spec.dest} already had ${keptUserFiles.join(", ")}; the older copies were left in ${spec.source}. Compare and merge them manually if needed.`
        );
    }
}

function lockFileSkipReason(dir: string): string {
    return existsSync(path.join(dir, LegacyLockFileName)) ? null : `has no ${LegacyLockFileName}`;
}

// The Linux legacy config root also holds Electron's userData ("electron/"), which moves along with
// a real config root but is not migrated on its own: it is cache and window state, and an
// Electron-only root would otherwise abort permanently once the new build has created its own.
function legacyConfigSkipReason(dir: string): string {
    let entries: Dirent[];
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
        return `could not be read (${e})`;
    }
    const hasConfig = entries.some(
        (ent) =>
            (ent.isFile() && (ent.name.endsWith(".json") || ent.name === LegacySecretsFileName)) ||
            (ent.isDirectory() && ent.name === "presets")
    );
    return hasConfig ? null : `has no config files (*.json, ${LegacySecretsFileName} or presets/)`;
}

function performDataDirMigration() {
    try {
        const homeDir = app.getPath("home");
        const xdgConfigHome = process.env.XDG_CONFIG_HOME;
        const xdgDataHome = process.env.XDG_DATA_HOME;

        const configOverride = readOverrideEnvVar(RemoteTermConfigHomeVarName, LegacyRemoteTermConfigHomeVarName);
        const configSource = xdgConfigHome
            ? path.join(xdgConfigHome, legacyRemoteTermDirName)
            : path.join(homeDir, ".config", legacyRemoteTermDirName);
        const configDest = xdgConfigHome
            ? path.join(xdgConfigHome, remoteTermDirName)
            : path.join(homeDir, ".config", remoteTermDirName);
        migrateDataRoot({
            name: "config",
            source: configOverride ?? configSource,
            dest: configOverride ?? configDest,
            overridden: configOverride != null,
            sourceSkipReason: () => legacyConfigSkipReason(configSource),
            // Config files are plain files the merge never overwrites, so any destination is safe.
            canMergeIntoDest: () => true,
        });

        const dataOverride = readOverrideEnvVar(RemoteTermDataHomeVarName, LegacyRemoteTermDataHomeVarName);
        const dataSource = xdgDataHome ? path.join(xdgDataHome, legacyRemoteTermDirName) : legacyPaths.data;
        const dataDest = xdgDataHome ? path.join(xdgDataHome, remoteTermDirName) : paths.data;
        // requestSingleInstanceLock() creates Electron's userData before a blocked launch quits; on
        // macOS (without XDG_DATA_HOME) that directory is inside the data root.
        const blockedLaunchDataEntryNames = new Set(EmainDataEntryNames);
        const electronUserData = path.join(app.getPath("appData"), ...ElectronUserDataPath);
        if (path.dirname(electronUserData) === dataDest) {
            blockedLaunchDataEntryNames.add(path.basename(electronUserData));
        }
        migrateDataRoot({
            name: "data",
            source: dataOverride ?? dataSource,
            dest: dataOverride ?? dataDest,
            overridden: dataOverride != null,
            sourceSkipReason: () => lockFileSkipReason(dataSource),
            // Never merge next to a database the new build already created.
            canMergeIntoDest: (destEntries) => destEntries.every((name) => blockedLaunchDataEntryNames.has(name)),
        });

        const homeOverride = readOverrideEnvVar(RemoteTermHomeVarName, LegacyRemoteTermHomeVarName);
        const legacyHomeSource = path.join(homeDir, LegacyRemoteTermHomeDirNameSuffixed);
        const legacyHomeDest = path.join(homeDir, `.${remoteTermDirName}`);
        migrateDataRoot({
            name: "legacy-home",
            source: homeOverride ?? legacyHomeSource,
            dest: homeOverride ?? legacyHomeDest,
            overridden: homeOverride != null,
            sourceSkipReason: () => lockFileSkipReason(legacyHomeSource),
        });

        // Best-effort fourth root: on Windows, Electron's own userData subtree (cookies, cache,
        // window state) resolves under %APPDATA% as a *sibling* of the config root, not a child
        // of any of the three roots above, so it needs its own explicit move. Unlike the roots
        // above, there is no per-root override var and no natural marker file inside Electron's
        // userData dir to validate against, so we validate on directory existence alone.
        if (process.platform === "win32" && process.env.APPDATA) {
            const winSource = path.join(process.env.APPDATA, "waveterm", "electron");
            const winDest = path.join(process.env.APPDATA, "remoteterm", "electron");
            migrateDataRoot({
                name: "windows-userdata",
                source: winSource,
                dest: winDest,
                overridden: false,
            });
        }
    } catch (e) {
        recordMigrationFailure("unexpected error during data-dir migration, continuing startup", e);
    }
}

performDataDirMigration();

export function checkIfRunningUnderARM64Translation(fullConfig: FullConfigType) {
    if (!fullConfig.settings["app:dismissarchitecturewarning"] && app.runningUnderARM64Translation) {
        console.log("Running under ARM64 translation, alerting user");
        const dialogOpts: Electron.MessageBoxOptions = {
            type: "warning",
            buttons: ["Dismiss", "Learn More"],
            title: "RemoteTerm has detected a performance issue",
            message: `RemoteTerm is running in ARM64 translation mode which may impact performance.\n\nRecommendation: Download the native ARM64 version from our website for optimal performance.`,
        };

        const choice = dialog.showMessageBoxSync(null, dialogOpts);
        if (choice === 1) {
            // Open the documentation URL
            console.log("User chose to learn more");
            fireAndForget(() =>
                shell.openExternal(
                    "https://docs.rterm.dev/faq#why-does-wave-warn-me-about-arm64-translation-when-it-launches"
                )
            );
            throw new Error("User redirected to docsite to learn more about ARM64 translation, exiting");
        } else {
            console.log("User dismissed the dialog");
        }
    }
}

function isCombinedHomeDir(dir: string): boolean {
    // If home exists and it has `wave.lock` in it, we know it has valid data from Wave >=v0.8. Otherwise, it could be for WaveLegacy (<v0.8)
    return existsSync(dir) && existsSync(path.join(dir, "wave.lock"));
}

/**
 * Gets the path to the combined RemoteTerm home directory (defaults to `~/.remoteterm`, falling back
 * to the legacy path `~/.waveterm`, or `-dev` suffixed variants of both in dev builds).
 * @returns The path to the directory if it exists and contains valid data for the current app, otherwise null.
 */
function getRemoteTermHomeDir(): string {
    const override = readOverrideEnvVar(RemoteTermHomeVarName, LegacyRemoteTermHomeVarName);
    if (override) {
        return isCombinedHomeDir(override) ? override : null;
    }
    const homeDir = app.getPath("home");
    if (!homeDir) {
        return null;
    }
    // Check the current (post-migration) default combined-home location first, then
    // fall back to the legacy location. The migration shim above moves a valid legacy home
    // dir from the latter to the former, but this function may be called before that
    // migration has a chance to run for a given process, or the migration may have been
    // skipped/failed, so both locations must be checked.
    const migratedHome = path.join(homeDir, `.${remoteTermDirName}`);
    if (isCombinedHomeDir(migratedHome)) {
        return migratedHome;
    }
    const legacySuffixedHome = path.join(homeDir, LegacyRemoteTermHomeDirNameSuffixed);
    if (isCombinedHomeDir(legacySuffixedHome)) {
        return legacySuffixedHome;
    }
    return null;
}

/**
 * Ensure the given path exists, creating it recursively if it doesn't.
 * @param path The path to ensure.
 * @returns The same path, for chaining.
 */
function ensurePathExists(path: string): string {
    if (!existsSync(path)) {
        mkdirSync(path, { recursive: true });
    }
    return path;
}

/**
 * Gets the path to the directory where RemoteTerm configurations are stored. Creates the directory if it does not exist.
 * Handles backwards compatibility with the old combined-home directory model, where configurations and data were stored together.
 * @returns The path where configurations should be stored.
 */
function getRemoteTermConfigDir(): string {
    // If wave home dir exists, use it for backwards compatibility
    const remoteTermHomeDir = getRemoteTermHomeDir();
    if (remoteTermHomeDir) {
        return path.join(remoteTermHomeDir, "config");
    }

    const override = readOverrideEnvVar(RemoteTermConfigHomeVarName, LegacyRemoteTermConfigHomeVarName);
    const xdgConfigHome = process.env.XDG_CONFIG_HOME;
    let retVal: string;
    if (override) {
        retVal = override;
    } else if (xdgConfigHome) {
        retVal = path.join(xdgConfigHome, remoteTermDirName);
    } else {
        retVal = path.join(app.getPath("home"), ".config", remoteTermDirName);
    }
    return ensurePathExists(retVal);
}

/**
 * Gets the path to the directory where RemoteTerm data is stored. Creates the directory if it does not exist.
 * Handles backwards compatibility with the old combined-home directory model, where configurations and data were stored together.
 * @returns The path where data should be stored.
 */
function getRemoteTermDataDir(): string {
    // If wave home dir exists, use it for backwards compatibility
    const remoteTermHomeDir = getRemoteTermHomeDir();
    if (remoteTermHomeDir) {
        return remoteTermHomeDir;
    }

    const override = readOverrideEnvVar(RemoteTermDataHomeVarName, LegacyRemoteTermDataHomeVarName);
    const xdgDataHome = process.env.XDG_DATA_HOME;
    let retVal: string;
    if (override) {
        retVal = override;
    } else if (xdgDataHome) {
        retVal = path.join(xdgDataHome, remoteTermDirName);
    } else {
        retVal = paths.data;
    }
    return ensurePathExists(retVal);
}

/**
 * True only when the launch explicitly opted in via REMOTETERM_ISOLATED_PROFILE=1 (exact match,
 * not merely truthy — REMOTETERM_ISOLATED_PROFILE=0 or any other non-empty value must NOT
 * activate it) AND REMOTETERM_CONFIG_HOME (or legacy WAVETERM_CONFIG_HOME) is also set. Used to
 * decide whether it's safe to relocate Electron's userData dir (see getElectronUserDataDir): a
 * real, non-overridden launch must keep using Electron's own OS-default userData path (keyed off
 * app.getName(), e.g. ~/.config/RemoteTerm), since that's where an existing install's real
 * Chromium profile (cookies, web-block logins, IndexedDB) already lives — relocating it
 * unconditionally would silently start every upgrading user with an empty profile and orphan the
 * old one with no migration.
 *
 * The config-dir-override requirement exists because getElectronUserDataDir() lands inside
 * getRemoteTermConfigDir(), which falls back to the real default config dir when no override is
 * set: REMOTETERM_ISOLATED_PROFILE=1 alone would relocate Electron's profile into the REAL config
 * dir's "electron" subfolder, not a scratch one — still not isolated (two such launches collide
 * with each other there) and not where the real profile already lives either. Warn and fall back
 * to Electron's own default (rather than refuse/quit) since this is a launch-script misconfiguration,
 * not a state a user should be blocked over; falling back keeps the launch usable while making the
 * gap visible in the log instead of silently landing in the wrong directory.
 *
 * Deliberately does NOT infer "isolated" from REMOTETERM_CONFIG_HOME/REMOTETERM_DATA_HOME/
 * REMOTETERM_HOME (or their legacy WAVETERM_*_HOME equivalents) being set: readOverrideEnvVar's
 * own contract is that those three are legitimately user-settable in a persistent shell profile
 * too, kept for backward compat with old shell-profile overrides. A real user who's had e.g.
 * WAVETERM_CONFIG_HOME set since before the rebrand would, under that inference, get their real
 * Chromium profile silently relocated with no migration on upgrade — the same failure class this
 * function exists to avoid. An isolated dev/test launch must set all three together:
 * REMOTETERM_ISOLATED_PROFILE=1 + REMOTETERM_CONFIG_HOME + REMOTETERM_DATA_HOME.
 */
function isRemoteTermIsolatedProfileActive(): boolean {
    if (process.env[RemoteTermIsolatedProfileVarName] !== "1") {
        return false;
    }
    const configOverride = readOverrideEnvVar(RemoteTermConfigHomeVarName, LegacyRemoteTermConfigHomeVarName);
    if (configOverride == null) {
        console.log(
            `${RemoteTermIsolatedProfileVarName}=1 was set without ${RemoteTermConfigHomeVarName} (or legacy ` +
                `${LegacyRemoteTermConfigHomeVarName}) also set; refusing to relocate Electron's userData into the ` +
                "real config dir and falling back to Electron's default profile path instead. Isolated dev/test " +
                "launches must set both together."
        );
        return false;
    }
    // getRemoteTermConfigDir() checks getRemoteTermHomeDir() FIRST and ignores REMOTETERM_CONFIG_HOME
    // entirely if a combined-home dir is found there — whether from an explicit REMOTETERM_HOME
    // override or one auto-detected at its default location (a real pre-fork Wave Terminal install's
    // migrated/legacy combined dir). Either way, our config override above would be silently ignored,
    // so getElectronUserDataDir() would resolve under that combined dir instead of the scratch one —
    // the same "isolation silently doesn't work" failure this function exists to prevent.
    if (getRemoteTermHomeDir() != null) {
        console.log(
            `${RemoteTermIsolatedProfileVarName}=1 was set, but a combined-home directory was found (explicit ` +
                `${RemoteTermHomeVarName} override or one auto-detected at its default location) that would cause ` +
                `${RemoteTermConfigHomeVarName} to be ignored; refusing to relocate Electron's userData and ` +
                "falling back to Electron's default profile path instead."
        );
        return false;
    }
    return true;
}

/**
 * Where Electron's own runtime profile (cookies, cache, IndexedDB, GPU cache, session storage,
 * and the SingletonLock the single-instance lock is keyed on) goes for an ISOLATED launch only.
 * Electron's own default userData path (keyed off app.getName(), i.e. the later app.setName(isDev
 * ? "RemoteTerm (Dev)" : "RemoteTerm") call, not the earlier app.setName("remoteterm/electron")
 * — that first name is unrelated to userData path resolution, but performDataDirMigration() DOES
 * separately read the same "remoteterm/electron" string, via the ElectronUserDataPath constant, to
 * locate Electron's userData dir for migration) ignores REMOTETERM_CONFIG_HOME/
 * REMOTETERM_DATA_HOME/REMOTETERM_HOME entirely: two isolated launches with different overrides
 * still resolved to the SAME userData dir and so the SAME lock, meaning a scratch dev/test
 * instance's second-instance event fired against an unrelated already-running instance instead of
 * its own. Callers must only use this path — via `app.setPath("userData", ...)` before requesting
 * the lock — when isRemoteTermIsolatedProfileActive() is true; otherwise leave Electron's default
 * alone.
 *
 * Known gap: this is keyed on the config dir only, so two launches with the SAME config dir but
 * DIFFERENT REMOTETERM_DATA_HOME still collide. Isolated launches must set REMOTETERM_ISOLATED_
 * PROFILE=1, REMOTETERM_CONFIG_HOME, and REMOTETERM_DATA_HOME together, so this covers the
 * documented case; a data-dir-only override is not fully isolated by this alone.
 */
function getElectronUserDataDir(): string {
    return path.join(getRemoteTermConfigDir(), "electron");
}

function getElectronAppBasePath(): string {
    // import.meta.dirname in dev points to waveterm/dist/main
    return path.dirname(import.meta.dirname);
}

function getElectronAppUnpackedBasePath(): string {
    return getElectronAppBasePath().replace("app.asar", "app.asar.unpacked");
}

function getElectronAppResourcesPath(): string {
    if (isDev) {
        // import.meta.dirname in dev points to waveterm/dist/main
        return path.dirname(import.meta.dirname);
    }
    return process.resourcesPath;
}

const remoteTermSrvBinName = `remotetermsrv.${unameArch}`;

function getRemoteTermSrvPath(): string {
    if (process.platform === "win32") {
        const winBinName = `${remoteTermSrvBinName}.exe`;
        const appPath = path.join(getElectronAppUnpackedBasePath(), "bin", winBinName);
        return `${appPath}`;
    }
    return path.join(getElectronAppUnpackedBasePath(), "bin", remoteTermSrvBinName);
}

function getRemoteTermSrvCwd(): string {
    return getRemoteTermDataDir();
}

ipcMain.on("get-is-dev", (event) => {
    event.returnValue = isDev;
});
ipcMain.on("get-platform", (event, url) => {
    event.returnValue = unamePlatform;
});
ipcMain.on("get-user-name", (event) => {
    const userInfo = os.userInfo();
    event.returnValue = userInfo.username;
});
ipcMain.on("get-host-name", (event) => {
    event.returnValue = os.hostname();
});

export function getWebviewPreloadPath(): string {
    return path.join(getElectronAppBasePath(), "preload", "preload-webview.cjs");
}

ipcMain.on("get-webview-preload", (event) => {
    event.returnValue = getWebviewPreloadPath();
});
ipcMain.on("get-data-dir", (event) => {
    event.returnValue = getRemoteTermDataDir();
});
ipcMain.on("get-config-dir", (event) => {
    event.returnValue = getRemoteTermConfigDir();
});
ipcMain.on("get-home-dir", (event) => {
    event.returnValue = app.getPath("home");
});

/**
 * Gets the value of the XDG_CURRENT_DESKTOP environment variable. If ORIGINAL_XDG_CURRENT_DESKTOP is set, it will be returned instead.
 * This corrects for a strange behavior in Electron, where it sets its own value for XDG_CURRENT_DESKTOP to improve Chromium compatibility.
 * @see https://www.electronjs.org/docs/latest/api/environment-variables#original_xdg_current_desktop
 * @returns The value of the XDG_CURRENT_DESKTOP environment variable, or ORIGINAL_XDG_CURRENT_DESKTOP if set, or undefined if neither are set.
 */
function getXdgCurrentDesktop(): string {
    if (process.env.ORIGINAL_XDG_CURRENT_DESKTOP) {
        return process.env.ORIGINAL_XDG_CURRENT_DESKTOP;
    } else if (process.env.XDG_CURRENT_DESKTOP) {
        return process.env.XDG_CURRENT_DESKTOP;
    } else {
        return undefined;
    }
}

/**
 * Calls the given callback with the value of the XDG_CURRENT_DESKTOP environment variable set to ORIGINAL_XDG_CURRENT_DESKTOP if it is set.
 * @see https://www.electronjs.org/docs/latest/api/environment-variables#original_xdg_current_desktop
 * @param callback The callback to call.
 */
function callWithOriginalXdgCurrentDesktop(callback: () => void) {
    const currXdgCurrentDesktopDefined = "XDG_CURRENT_DESKTOP" in process.env;
    const currXdgCurrentDesktop = process.env.XDG_CURRENT_DESKTOP;
    const originalXdgCurrentDesktop = getXdgCurrentDesktop();
    if (originalXdgCurrentDesktop) {
        process.env.XDG_CURRENT_DESKTOP = originalXdgCurrentDesktop;
    }
    callback();
    if (originalXdgCurrentDesktop) {
        if (currXdgCurrentDesktopDefined) {
            process.env.XDG_CURRENT_DESKTOP = currXdgCurrentDesktop;
        } else {
            delete process.env.XDG_CURRENT_DESKTOP;
        }
    }
}

/**
 * Calls the given async callback with the value of the XDG_CURRENT_DESKTOP environment variable set to ORIGINAL_XDG_CURRENT_DESKTOP if it is set.
 * @see https://www.electronjs.org/docs/latest/api/environment-variables#original_xdg_current_desktop
 * @param callback The async callback to call.
 */
async function callWithOriginalXdgCurrentDesktopAsync(callback: () => Promise<void>) {
    const currXdgCurrentDesktopDefined = "XDG_CURRENT_DESKTOP" in process.env;
    const currXdgCurrentDesktop = process.env.XDG_CURRENT_DESKTOP;
    const originalXdgCurrentDesktop = getXdgCurrentDesktop();
    if (originalXdgCurrentDesktop) {
        process.env.XDG_CURRENT_DESKTOP = originalXdgCurrentDesktop;
    }
    await callback();
    if (originalXdgCurrentDesktop) {
        if (currXdgCurrentDesktopDefined) {
            process.env.XDG_CURRENT_DESKTOP = currXdgCurrentDesktop;
        } else {
            delete process.env.XDG_CURRENT_DESKTOP;
        }
    }
}

export {
    callWithOriginalXdgCurrentDesktop,
    callWithOriginalXdgCurrentDesktopAsync,
    getElectronAppBasePath,
    getElectronAppResourcesPath,
    getElectronAppUnpackedBasePath,
    getElectronUserDataDir,
    isRemoteTermIsolatedProfileActive,
    getRemoteTermConfigDir,
    getRemoteTermDataDir,
    getRemoteTermSrvCwd,
    getRemoteTermSrvPath,
    getXdgCurrentDesktop,
    isDev,
    isDevVite,
    RemoteTermConfigHomeVarName,
    RemoteTermDataHomeVarName,
    unameArch,
    unamePlatform,
};
