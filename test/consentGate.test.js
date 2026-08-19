const assert = require('assert');

/**
 * Regression tests for the consent gate on RemoteControlMain and RemoteDraw
 * (YWH-PGM7461-3062).
 *
 * Verifies that:
 *   1. Sessions are denied by default when no requestConsent callback is
 *      provided (fail-closed).
 *   2. Sessions start only after requestConsent resolves to true.
 *   3. Sessions are denied when requestConsent resolves to false or throws.
 *   4. Concurrent start requests while consent is pending are rejected.
 *   5. ipcMain.handle routes are registered on construction and removed on
 *      cleanup.
 *   6. requestConsent: false disables the gate (legacy/unsafe mode).
 *
 * Electron is mocked so the tests run outside an Electron process.
 */

// --- Mock Electron -----------------------------------------------------------

const ipcState = {
    handlers: {},
    onHandlers: {}
};

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

const electronMock = {
    app: mockApp,
    ipcMain: mockIpcMain,
    screen: mockScreen,
    BrowserWindow: function() {
        return { on() {}, close() {}, webContents: { send() {}, on() {} } };
    },
    dialog: {}
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

// --- Helpers ----------------------------------------------------------------

function makeMockWindow() {
    return {
        isDestroyed() { return false; },
        on() {},
        webContents: { send() {} }
    };
}

// --- Tests -------------------------------------------------------------------

describe('RemoteControlMain consent gate', () => {
    let RemoteControlMain;

    beforeEach(() => {
        ipcState.handlers = {};
        ipcState.onHandlers = {};

        const mainPath = require.resolve('../remotecontrol/main.js');
        delete Module._cache[mainPath];

        RemoteControlMain = require('../remotecontrol/main.js');
    });

    afterEach(() => {
        delete Module._cache[require.resolve('../remotecontrol/main.js')];
    });

    it('registers ipcMain.handle for RC_START on construction', () => {
        new RemoteControlMain(makeMockWindow(), { requestConsent: () => true });

        assert.ok(ipcState.handlers['jitsi-remotecontrol-start'],
            'RC_START ipcMain.handle must be registered');
    });

    it('removes RC_START handler on cleanup', () => {
        const rc = new RemoteControlMain(makeMockWindow(), { requestConsent: () => true });

        rc.cleanup();

        assert.ok(!ipcState.handlers['jitsi-remotecontrol-start'],
            'RC_START handler must be removed after cleanup');
    });

    it('denies session by default when no requestConsent is provided', async () => {
        const rc = new RemoteControlMain(makeMockWindow());

        const result = await rc._handleStart({}, 'screen:0');

        assert.ok(result.error, 'Must return an error when no consent callback');
        assert.ok(result.error.includes('denied'),
            `Error must mention denial, got: ${result.error}`);
    });

    it('starts session when requestConsent resolves to true', async () => {
        const rc = new RemoteControlMain(makeMockWindow(), {
            requestConsent: () => Promise.resolve(true)
        });

        const result = await rc._handleStart({}, 'screen:0');

        assert.ok(result.result, 'Must return result: true when consent is granted');
        assert.ok(result.display, 'Must return the resolved display');
    });

    it('denies session when requestConsent resolves to false', async () => {
        const rc = new RemoteControlMain(makeMockWindow(), {
            requestConsent: () => Promise.resolve(false)
        });

        const result = await rc._handleStart({}, 'screen:0');

        assert.ok(result.error, 'Must return an error when consent is denied');
        assert.ok(result.error.includes('denied'),
            `Error must mention denial, got: ${result.error}`);
    });

    it('denies session when requestConsent throws', async () => {
        const rc = new RemoteControlMain(makeMockWindow(), {
            requestConsent: () => Promise.reject(new Error('user closed dialog'))
        });

        const result = await rc._handleStart({}, 'screen:0');

        assert.ok(result.error, 'Must return an error when consent throws');
        assert.ok(result.error.includes('denied'),
            `Error must mention denial, got: ${result.error}`);
    });

    it('rejects concurrent start requests while consent is pending', async () => {
        let resolveConsent;
        const rc = new RemoteControlMain(makeMockWindow(), {
            requestConsent: () => new Promise(resolve => { resolveConsent = resolve; })
        });

        const firstPromise = rc._handleStart({}, 'screen:0');
        const secondPromise = rc._handleStart({}, 'screen:0');

        resolveConsent(true);

        const firstResult = await firstPromise;
        const secondResult = await secondPromise;

        assert.ok(firstResult.result, 'First request must succeed');
        assert.ok(secondResult.error, 'Second concurrent request must be rejected');
        assert.ok(secondResult.error.includes('pending'),
            `Error must mention pending, got: ${secondResult.error}`);
    });

    it('returns error when window is destroyed during consent', async () => {
        const win = makeMockWindow();
        const rc = new RemoteControlMain(win, {
            requestConsent: () => {
                win.isDestroyed = () => true;

                return Promise.resolve(true);
            }
        });

        const result = await rc._handleStart({}, 'screen:0');

        assert.ok(result.error, 'Must return error when window is destroyed');
        assert.ok(result.error.includes('gone'),
            `Error must mention window gone, got: ${result.error}`);
    });

    it('requestConsent: false disables the gate', async () => {
        const rc = new RemoteControlMain(makeMockWindow(), { requestConsent: false });

        const result = await rc._handleStart({}, 'screen:0');

        assert.ok(result.result,
            'Must start without consent when gate is disabled');
    });
});

describe('RemoteDraw consent gate', () => {
    let RemoteDraw;

    beforeEach(() => {
        ipcState.handlers = {};
        ipcState.onHandlers = {};

        const mainPath = require.resolve('../remotedraw/main.js');
        delete Module._cache[mainPath];

        RemoteDraw = require('../remotedraw/main.js');
    });

    afterEach(() => {
        delete Module._cache[require.resolve('../remotedraw/main.js')];
    });

    it('registers ipcMain.handle for RD_START on construction', () => {
        new RemoteDraw(makeMockWindow(), { requestConsent: () => true });

        assert.ok(ipcState.handlers['jitsi-remotedraw-start'],
            'RD_START ipcMain.handle must be registered');
    });

    it('removes RD_START handler on cleanup', () => {
        const rd = new RemoteDraw(makeMockWindow(), { requestConsent: () => true });

        rd.cleanup();

        assert.ok(!ipcState.handlers['jitsi-remotedraw-start'],
            'RD_START handler must be removed after cleanup');
    });

    it('denies session by default when no requestConsent is provided', async () => {
        const rd = new RemoteDraw(makeMockWindow());

        const result = await rd._handleStart({}, 'screen:0');

        assert.ok(result.error, 'Must return an error when no consent callback');
        assert.ok(result.error.includes('denied'),
            `Error must mention denial, got: ${result.error}`);
    });

    it('starts session when requestConsent resolves to true', async () => {
        const rd = new RemoteDraw(makeMockWindow(), {
            requestConsent: () => Promise.resolve(true)
        });

        const result = await rd._handleStart({}, 'screen:0');

        assert.ok(result.result, 'Must return result: true when consent is granted');
        assert.ok(result.display, 'Must return the resolved display');
    });

    it('denies session when requestConsent resolves to false', async () => {
        const rd = new RemoteDraw(makeMockWindow(), {
            requestConsent: () => Promise.resolve(false)
        });

        const result = await rd._handleStart({}, 'screen:0');

        assert.ok(result.error, 'Must return an error when consent is denied');
        assert.ok(result.error.includes('denied'),
            `Error must mention denial, got: ${result.error}`);
    });

    it('requestConsent: false disables the gate', async () => {
        const rd = new RemoteDraw(makeMockWindow(), { requestConsent: false });

        const result = await rd._handleStart({}, 'screen:0');

        assert.ok(result.result,
            'Must start without consent when gate is disabled');
    });
});
