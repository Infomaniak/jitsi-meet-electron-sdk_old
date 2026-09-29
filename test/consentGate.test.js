const assert = require('assert');
const os = require('os');

const { windowsEnableScreenProtection } = require('../helpers/functions');

/**
 * Regression tests for the main-process consent gate of the v10 setup
 * factories `setupRemoteControlMain` (remotecontrol/main.js) and
 * `setupRemoteDrawMain` (remotedraw/main.js) (YWH-PGM7461-3062).
 *
 * The v10 modules export factory functions (`setupRemoteControlMain(window,
 * options)`, `setupRemoteDrawMain(window, options)`); the consent-gating
 * classes are internal. The factories register their start routes through
 * helpers/ipcRouter, which installs a single `ipcMain.handle` per channel, so
 * the tests drive sessions through that public IPC surface instead of the
 * private `_handleStart`.
 *
 * Verifies that:
 *   1. The factories register `ipcMain.handle` routes on setup and remove
 *      them on cleanup.
 *   2. With the default native dialog, sessions are denied unless the user
 *      accepts (fail-closed; dialog response 0 = Deny, 1 = Allow).
 *   3. With a `requestConsent` callback, sessions start only when it resolves
 *      to true, and are denied when it resolves to false or throws.
 *   4. Concurrent start requests while consent is pending are rejected
 *      (remote control).
 *   5. An error is returned when the meeting window is destroyed while
 *      consent is pending (remote control).
 *   6. `requestConsent: false` disables the gate (legacy/unsafe mode) and a
 *      warning is logged.
 *   7. The remote draw overlay window is created on an allowed start and is
 *      excluded from screen capture where the platform supports it.
 *
 * On the success shape: v10 replies `{ result: true }` WITHOUT a display
 * payload (display metrics now live in the main process, see
 * remotecontrol/main.js `_handleStart` and remotedraw/main.js
 * `_handleStart`). The v9 `result.display` assertion therefore no longer
 * applies; these tests assert the exact v10 success shape instead, which is
 * strictly stronger than the old truthiness checks.
 *
 * Electron is mocked so the tests run outside an Electron process.
 */

// --- Mock Electron -----------------------------------------------------------

const ipcState = {
    handlers: {},
    onHandlers: {}
};

// Response of the mocked native consent dialog, read at call time.
// 0 = "Deny" (also the cancel button, so the fail-closed default), 1 = "Allow".
const dialogState = {
    response: 0
};

// BrowserWindow instances created by the modules under test, so tests can
// assert on them (e.g. that the draw overlay is excluded from capture).
let createdWindows = [];

const mockApp = {
    whenReady() { return Promise.resolve(); }
};

const mockIpcMain = {
    on(channel, handler) { ipcState.onHandlers[channel] = handler; },
    removeListener(channel) { delete ipcState.onHandlers[channel]; },
    handle(channel, handler) { ipcState.handlers[channel] = handler; },
    removeHandler(channel) { delete ipcState.handlers[channel]; }
};

const mockScreen = {
    on() {},
    removeListener() {},
    getAllDisplays() {
        return [ { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 } ];
    }
};

/**
 * Mock of the BrowserWindows the modules under test create (the remote draw
 * overlay). Stubs every method the modules call so a successful start can run
 * to completion outside Electron, and records the content-protection flag so
 * tests can assert the overlay is hidden from screen captures.
 *
 * @returns {Object} A mock BrowserWindow instance.
 */
function MockBrowserWindow() {
    const win = {
        contentProtection: undefined,
        on() {},
        close() {},
        loadURL() {
            return Promise.resolve();
        },
        setContentProtection(enabled) {
            win.contentProtection = enabled;
        },
        setVisibleOnAllWorkspaces() {},
        setIgnoreMouseEvents() {},
        setFocusable() {},
        webContents: {
            send() {},
            on() {}
        }
    };

    createdWindows.push(win);

    return win;
}

const electronMock = {
    app: mockApp,
    ipcMain: mockIpcMain,
    screen: mockScreen,
    BrowserWindow: MockBrowserWindow,
    dialog: {
        showMessageBox() {
            return Promise.resolve({ response: dialogState.response });
        }
    }
};

// Override Module._resolveFilename so `require('electron')` resolves to our
// mock. This must be in place before any require of the SDK modules.
const Module = require('module');
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function(request, ...args) {
    if (request === 'electron') {
        return 'electron-mock-consent';
    }

    return originalResolveFilename.call(this, request, ...args);
};

Module._cache['electron-mock-consent'] = {
    id: 'electron-mock-consent',
    filename: 'electron-mock-consent',
    loaded: true,
    exports: electronMock
};

after(() => {
    Module._resolveFilename = originalResolveFilename;
    delete Module._cache['electron-mock-consent'];
});

// --- Helpers -----------------------------------------------------------------

/**
 * Creates a mock Jitsi Meet window.
 *
 * @returns {Object} A mock BrowserWindow hosting Jitsi Meet.
 */
function makeMockWindow() {
    return {
        isDestroyed() { return false; },
        on() {},
        webContents: { send() {} }
    };
}

/**
 * Starts a session through the public IPC surface: resolves the invoke
 * handler the factory under test registered for `channel` and calls it the
 * way ipcMain would, with an event whose sender matches the owning window's
 * webContents (the router rejects unpaired senders).
 *
 * @param {string} channel - The start channel (RC_START or RD_START).
 * @param {BrowserWindow} win - The mock window the factory was set up with.
 * @param {string} sourceId - The source id of the shared desktop.
 * @returns {Promise<Object>} The handler's reply (`{ result: true }` or
 * `{ error }`).
 */
function invokeStart(channel, win, sourceId) {
    const handler = ipcState.handlers[channel];

    assert.ok(handler, `Expected an ipcMain.handle route for ${channel}`);

    return handler({ sender: win.webContents }, sourceId);
}

/**
 * Wipes the state one test iteration depends on: the mocked ipcMain
 * registrations and the module cache of the module under test and of the IPC
 * router (the router keeps process-wide route tables, so a stale instance
 * would leak routes across tests).
 *
 * @param {string} mainPath - Resolved path of the module under test.
 * @returns {void}
 */
function resetModules(mainPath) {
    ipcState.handlers = {};
    ipcState.onHandlers = {};
    dialogState.response = 0;
    createdWindows = [];

    delete Module._cache[mainPath];
    delete Module._cache[require.resolve('../helpers/ipcRouter.js')];
}

// --- Tests -------------------------------------------------------------------

describe('RemoteControlMain consent gate', () => {
    const RC_MAIN_PATH = require.resolve('../remotecontrol/main.js');
    const RC_START = 'jitsi-remotecontrol-start';

    let setupRemoteControlMain;

    beforeEach(() => {
        resetModules(RC_MAIN_PATH);

        setupRemoteControlMain = require('../remotecontrol/main.js');
    });

    it('registers ipcMain.handle for RC_START on setup', () => {
        setupRemoteControlMain(makeMockWindow(), { requestConsent: () => true });

        assert.ok(ipcState.handlers[RC_START],
            'RC_START ipcMain.handle must be registered');
    });

    it('removes RC_START handler on cleanup', () => {
        const rc = setupRemoteControlMain(makeMockWindow(), { requestConsent: () => true });

        rc.cleanup();

        assert.ok(!ipcState.handlers[RC_START],
            'RC_START handler must be removed after cleanup');
    });

    it('denies session via the default dialog when the user declines', async () => {
        const win = makeMockWindow();

        // No requestConsent option: the factory falls back to the native
        // consent dialog, mocked here. 0 = "Deny" (the default/cancel button).
        setupRemoteControlMain(win);

        const result = await invokeStart(RC_START, win, 'screen:0');

        assert.ok(result.error, 'Must return an error when the user declines');
        assert.ok(result.error.includes('denied'),
            `Error must mention denial, got: ${result.error}`);
    });

    it('starts session via the default dialog when the user allows', async () => {
        const win = makeMockWindow();

        setupRemoteControlMain(win);

        dialogState.response = 1; // "Allow"

        const result = await invokeStart(RC_START, win, 'screen:0');

        // v10 replies `{ result: true }` without a display payload (display
        // metrics live in the main process); the exact-shape assertion keeps
        // this strict where the v9 suite checked `result.display`.
        assert.deepStrictEqual(result, { result: true },
            'Must reply { result: true } when the native dialog allows');
    });

    it('starts session when requestConsent resolves to true', async () => {
        const win = makeMockWindow();
        let receivedSourceId;

        setupRemoteControlMain(win, {
            requestConsent: ({ sourceId }) => {
                receivedSourceId = sourceId;

                return Promise.resolve(true);
            }
        });

        const result = await invokeStart(RC_START, win, 'screen:0');

        assert.strictEqual(receivedSourceId, 'screen:0',
            'requestConsent must receive the requested { sourceId }');
        assert.deepStrictEqual(result, { result: true },
            'Must reply { result: true } when consent is granted');
    });

    it('denies session when requestConsent resolves to false', async () => {
        const win = makeMockWindow();

        setupRemoteControlMain(win, {
            requestConsent: () => Promise.resolve(false)
        });

        const result = await invokeStart(RC_START, win, 'screen:0');

        assert.ok(result.error, 'Must return an error when consent is denied');
        assert.ok(result.error.includes('denied'),
            `Error must mention denial, got: ${result.error}`);
    });

    it('denies session when requestConsent throws', async () => {
        const win = makeMockWindow();

        setupRemoteControlMain(win, {
            requestConsent: () => Promise.reject(new Error('user closed dialog'))
        });

        const result = await invokeStart(RC_START, win, 'screen:0');

        assert.ok(result.error, 'Must return an error when consent throws');
        assert.ok(result.error.includes('denied'),
            `Error must mention denial, got: ${result.error}`);
    });

    it('rejects concurrent start requests while consent is pending', async () => {
        let resolveConsent;
        const win = makeMockWindow();

        setupRemoteControlMain(win, {
            requestConsent: () => new Promise(resolve => {
                resolveConsent = resolve;
            })
        });

        const firstPromise = invokeStart(RC_START, win, 'screen:0');
        const secondPromise = invokeStart(RC_START, win, 'screen:0');

        resolveConsent(true);

        const firstResult = await firstPromise;
        const secondResult = await secondPromise;

        assert.deepStrictEqual(firstResult, { result: true },
            'First request must succeed');
        assert.ok(secondResult.error, 'Second concurrent request must be rejected');
        assert.ok(secondResult.error.includes('pending'),
            `Error must mention pending, got: ${secondResult.error}`);
    });

    it('returns error when window is destroyed during consent', async () => {
        const win = makeMockWindow();

        setupRemoteControlMain(win, {
            requestConsent: () => {
                win.isDestroyed = () => true;

                return Promise.resolve(true);
            }
        });

        const result = await invokeStart(RC_START, win, 'screen:0');

        assert.ok(result.error, 'Must return error when window is destroyed');
        assert.ok(result.error.includes('gone'),
            `Error must mention window gone, got: ${result.error}`);
    });

    it('requestConsent: false disables the gate and warns', async () => {
        const warnings = [];
        const originalWarn = console.warn;
        const win = makeMockWindow();

        console.warn = message => warnings.push(message);

        try {
            setupRemoteControlMain(win, { requestConsent: false });

            const result = await invokeStart(RC_START, win, 'screen:0');

            assert.deepStrictEqual(result, { result: true },
                'Must start without consent when gate is disabled');
        } finally {
            console.warn = originalWarn;
        }

        assert.ok(warnings.some(message => message.includes('consent gate is disabled')),
            'Must warn that the consent gate is disabled');
    });
});

describe('RemoteDraw consent gate', () => {
    const RD_MAIN_PATH = require.resolve('../remotedraw/main.js');
    const RD_START = 'jitsi-remotedraw-start';
    const RD_GET_DISPLAY = 'jitsi-remotedraw-get-display';

    let setupRemoteDrawMain;

    beforeEach(() => {
        resetModules(RD_MAIN_PATH);

        setupRemoteDrawMain = require('../remotedraw/main.js');
    });

    it('registers ipcMain.handle for RD_START and RD_GET_DISPLAY on setup', () => {
        setupRemoteDrawMain(makeMockWindow(), { requestConsent: () => true });

        assert.ok(ipcState.handlers[RD_START],
            'RD_START ipcMain.handle must be registered');
        assert.ok(ipcState.handlers[RD_GET_DISPLAY],
            'RD_GET_DISPLAY ipcMain.handle must be registered');
    });

    it('removes RD handlers on cleanup', () => {
        const rd = setupRemoteDrawMain(makeMockWindow(), { requestConsent: () => true });

        rd.cleanup();

        assert.ok(!ipcState.handlers[RD_START],
            'RD_START handler must be removed after cleanup');
        assert.ok(!ipcState.handlers[RD_GET_DISPLAY],
            'RD_GET_DISPLAY handler must be removed after cleanup');
    });

    it('denies session via the default dialog when the user declines', async () => {
        const win = makeMockWindow();

        // No requestConsent option: the factory falls back to the native
        // consent dialog, mocked here. 0 = "Deny" (the default/cancel button).
        setupRemoteDrawMain(win);

        const result = await invokeStart(RD_START, win, 'screen:0');

        assert.ok(result.error, 'Must return an error when the user declines');
        assert.ok(result.error.includes('denied'),
            `Error must mention denial, got: ${result.error}`);
    });

    it('starts session via the default dialog when the user allows', async () => {
        const win = makeMockWindow();

        setupRemoteDrawMain(win);

        dialogState.response = 1; // "Allow"

        const result = await invokeStart(RD_START, win, 'screen:0');

        // v10 replies `{ result: true }` without a display payload (mirrored
        // from remotecontrol); the exact-shape assertion keeps this strict
        // where the v9 suite checked `result.display`.
        assert.deepStrictEqual(result, { result: true },
            'Must reply { result: true } when the native dialog allows');
        assert.strictEqual(createdWindows.length, 1,
            'The draw overlay window must be created');
    });

    it('starts session when requestConsent resolves to true', async () => {
        const win = makeMockWindow();
        let receivedSourceId;

        setupRemoteDrawMain(win, {
            requestConsent: ({ sourceId }) => {
                receivedSourceId = sourceId;

                return Promise.resolve(true);
            }
        });

        const result = await invokeStart(RD_START, win, 'screen:0');

        assert.strictEqual(receivedSourceId, 'screen:0',
            'requestConsent must receive the requested { sourceId }');
        assert.deepStrictEqual(result, { result: true },
            'Must reply { result: true } when consent is granted');
        assert.strictEqual(createdWindows.length, 1,
            'The draw overlay window must be created');
    });

    it('excludes the draw overlay from screen capture where supported', async () => {
        const win = makeMockWindow();

        setupRemoteDrawMain(win, { requestConsent: () => true });

        await invokeStart(RD_START, win, 'screen:0');

        assert.strictEqual(createdWindows.length, 1,
            'The draw overlay window must be created');

        // The overlay must set content protection so it is invisible in
        // captures; on Windows the module only does so for builds that
        // support WDA_EXCLUDEFROMCAPTURE (Windows 10 2004+), elsewhere always.
        if (os.platform() !== 'win32' || windowsEnableScreenProtection(os.release())) {
            assert.strictEqual(createdWindows[0].contentProtection, true,
                'Draw overlay must be excluded from screen capture');
        }
    });

    it('denies session when requestConsent resolves to false', async () => {
        const win = makeMockWindow();

        setupRemoteDrawMain(win, {
            requestConsent: () => Promise.resolve(false)
        });

        const result = await invokeStart(RD_START, win, 'screen:0');

        assert.ok(result.error, 'Must return an error when consent is denied');
        assert.ok(result.error.includes('denied'),
            `Error must mention denial, got: ${result.error}`);
    });

    it('requestConsent: false disables the gate and warns', async () => {
        const warnings = [];
        const originalWarn = console.warn;
        const win = makeMockWindow();

        console.warn = message => warnings.push(message);

        try {
            setupRemoteDrawMain(win, { requestConsent: false });

            const result = await invokeStart(RD_START, win, 'screen:0');

            assert.deepStrictEqual(result, { result: true },
                'Must start without consent when gate is disabled');
        } finally {
            console.warn = originalWarn;
        }

        assert.ok(warnings.some(message => message.includes('consent gate is disabled')),
            'Must warn that the consent gate is disabled');
        assert.strictEqual(createdWindows.length, 1,
            'The draw overlay window must be created without consent');
    });
});
