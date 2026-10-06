// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

let isJetBrainsMonoLoaded = false;
let hackRegularLoad: Promise<unknown> = null;
let interLoad: Promise<unknown> = null;
let isHackNerdFontLoaded = false;

function addToFontFaceSet(fontFaceSet: FontFaceSet, fontFace: FontFace) {
    // any cast to work around typing issue
    (fontFaceSet as any).add(fontFace);
}

// A failed load must not reject into the caller: the window-ready gate waits on these.
function addAndLoadFace(fontFace: FontFace): Promise<unknown> {
    addToFontFaceSet(document.fonts, fontFace);
    return Promise.resolve(fontFace.load()).catch((e) => {
        console.log("font load failed", fontFace.family, fontFace.style, fontFace.weight, e);
    });
}

function loadJetBrainsMonoFont() {
    if (isJetBrainsMonoLoaded) {
        return;
    }
    isJetBrainsMonoLoaded = true;
    const jbmFontNormal = new FontFace("JetBrains Mono", "url('fonts/jetbrains-mono-v13-latin-regular.woff2')", {
        style: "normal",
        weight: "400",
    });
    const jbmFont200 = new FontFace("JetBrains Mono", "url('fonts/jetbrains-mono-v13-latin-200.woff2')", {
        style: "normal",
        weight: "200",
    });
    const jbmFont700 = new FontFace("JetBrains Mono", "url('fonts/jetbrains-mono-v13-latin-700.woff2')", {
        style: "normal",
        weight: "700",
    });
    addAndLoadFace(jbmFontNormal);
    addAndLoadFace(jbmFont200);
    addAndLoadFace(jbmFont700);
}

// Returns the load of the regular face only, the one terminal cell measurement needs. Bold and
// italic share its metrics and load in the background.
function loadHackNerdFont(): Promise<unknown> {
    if (isHackNerdFontLoaded) {
        return hackRegularLoad;
    }
    isHackNerdFontLoaded = true;
    const hackRegular = new FontFace("Hack", "url('fonts/hacknerdmono-regular.ttf')", {
        style: "normal",
        weight: "400",
    });
    const hackBold = new FontFace("Hack", "url('fonts/hacknerdmono-bold.ttf')", {
        style: "normal",
        weight: "700",
    });
    const hackItalic = new FontFace("Hack", "url('fonts/hacknerdmono-italic.ttf')", {
        style: "italic",
        weight: "400",
    });
    const hackBoldItalic = new FontFace("Hack", "url('fonts/hacknerdmono-bolditalic.ttf')", {
        style: "italic",
        weight: "700",
    });
    hackRegularLoad = addAndLoadFace(hackRegular);
    addAndLoadFace(hackBold);
    addAndLoadFace(hackItalic);
    addAndLoadFace(hackBoldItalic);
    return hackRegularLoad;
}

function loadInterFont(): Promise<unknown> {
    if (interLoad != null) {
        return interLoad;
    }
    const interFont = new FontFace("Inter", "url('fonts/inter-variable.woff2')", {
        style: "normal",
        weight: "100 900",
    });
    interLoad = addAndLoadFace(interFont);
    return interLoad;
}

// Starts every face loading and resolves once Hack regular and Inter have settled (loaded or
// failed). Everything else keeps loading after this resolves.
function loadFonts(): Promise<void> {
    const inter = loadInterFont();
    loadJetBrainsMonoFont();
    const hack = loadHackNerdFont();
    return Promise.all([inter, hack]).then(() => {});
}

export { loadFonts };
