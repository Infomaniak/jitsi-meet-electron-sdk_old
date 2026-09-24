const assert = require('assert');

/**
 * Regression tests for the screen sharing source gate (YWH-PGM7461-3062).
 *
 * Verifies that:
 *   1. Source options are sanitized: types filtered to screen/window,
 *      thumbnail dimensions clamped to 320px, unknown fields dropped.
 *   2. getSources rejects senders other than the meeting window renderer.
 *   3. The JitsiMeetElectron helper is only exposed to pages served from
 *      the origins the embedding app declared (origin gate, port of the
 *      upstream v10.0.5 commit 144080fd to the legacy obtainDesktopStreams
 *      API).
 *   4. With no allowedOrigins configured the legacy behavior applies
 *      (documented fail-open) and the exposure is logged.
 *
 * Electron is mocked so the tests run outside an Electron process.
 */

// --- Mock Electron -----------------------------------------------------------

const ipcState = {
    handlers: {},
    onHandlers: {},
    invocations: []
};

const mockIpcMain = {
    on(channel, handler) { ipcState.onHandlers[channel] = handler; },
    removeListener(channel) { delete ipcState.onHandlers[channel]; },
    handle(channel, handler) { ipcState.handlers[channel] = handler; },
    removeHandler(channel) { delete ipcState.handlers[channel]; }
};

const mockIpcRenderer = {
    invoke(channel, payload) {
        ipcState.invocations.push({ channel, payload });

        return Promise.resolve([]);
    },
    on() {},
    send() {},
    removeListener() {}
};

let capturedSourcesArgs = null;

const electronMock = {
    ipcMain: mockIpcMain,
    ipcRenderer: mockIpcRenderer,
    desktopCapturer: {
        getSources(opts) {
            capturedSourcesArgs = opts;

            return Promise.resolve([ { id: 'source:1' } ]);
        }
    },
    systemPreferences: {
        getMediaAccessStatus: () => 'granted'
    },
    screen: { on() {}, removeListener() {} },
    BrowserWindow: function() {
        return { on() {}, close() {}, webContents: { send() {}, on() {} } };
    }
};

const Module = require('module');
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function(request, ...args) {
    if (request === 'electron') {
        return 'electron-mock-screenshare';
    }

    return originalResolveFilename.call(this, request, ...args);
};

Module._cache['electron-mock-screenshare'] = {
    id: 'electron-mock-screenshare',
    filename: 'electron-mock-screenshare',
    loaded: true,
    exports: electronMock
};

// Require the SDK modules under this file's mock, then restore the resolver
// immediately: other test files install their own mock and mocha loads every
// file in one process. The modules below keep referencing the mock objects
// through their own require, so restoring here is safe.
const { sanitizeSourceOptions, isOriginAllowed, clampDimension } = require('../screensharing/utils');
const setupScreenSharingMain = require('../screensharing/main');
const setupScreenSharingRender = require('../screensharing/render');

Module._resolveFilename = originalResolveFilename;
delete Module._cache['electron-mock-screenshare'];

const MEETING_WEBCONTENTS = { id: 42 };
const meetingWindow = { webContents: MEETING_WEBCONTENTS, on() {} };

// --- Fake iframe/api for the renderer hook -----------------------------------

function createFakeApi(iframeSrc) {
    const loadHandlers = [];
    const contentWindow = {};
    const iframe = {
        src: iframeSrc,
        contentWindow,
        addEventListener(type, handler) {
            if (type === 'load') {
                loadHandlers.push(handler);
            }
        },
        removeEventListener() {}
    };
    const api = {
        getIFrame: () => iframe,
        on() {},
        removeListener() {},
        executeCommand() {},
        _fireLoad: () => loadHandlers.forEach(handler => handler())
    };

    return { api, contentWindow };
}

describe('Screen sharing source gate', () => {
    describe('clampDimension', () => {
        it('clamps to 320 and floors fractions', () => {
            assert.strictEqual(clampDimension(10000), 320);
            assert.strictEqual(clampDimension(320), 320);
            assert.strictEqual(clampDimension(150.9), 150);
        });

        it('maps invalid values to 0', () => {
            assert.strictEqual(clampDimension(-5), 0);
            assert.strictEqual(clampDimension(0), 0);
            assert.strictEqual(clampDimension(Number.NaN), 0);
            assert.strictEqual(clampDimension('not-a-number'), 0);
            assert.strictEqual(clampDimension(undefined), 0);
        });
    });

    describe('sanitizeSourceOptions', () => {
        it('filters source types to screen/window', () => {
            assert.deepStrictEqual(
                sanitizeSourceOptions({ types: [ 'screen', 'document', 'window', 'screen' ] }),
                { types: [ 'screen', 'window', 'screen' ] });
        });

        it('drops a types array with no valid entry', () => {
            assert.deepStrictEqual(sanitizeSourceOptions({ types: [ 'document' ] }), {});
        });

        it('clamps thumbnailSize dimensions', () => {
            assert.deepStrictEqual(
                sanitizeSourceOptions({ thumbnailSize: { width: 10000, height: 150.9 } }),
                { thumbnailSize: { width: 320, height: 150 } });
        });

        it('passes fetchWindowIcons through and drops unknown fields', () => {
            assert.deepStrictEqual(
                sanitizeSourceOptions({
                    fetchWindowIcons: true,
                    fetchStrings: { badge: true },
                    unknown: 'x'
                }),
                { fetchWindowIcons: true });
        });

        it('is safe on garbage input', () => {
            assert.deepStrictEqual(sanitizeSourceOptions(undefined), {});
            assert.deepStrictEqual(sanitizeSourceOptions('string'), {});
            assert.deepStrictEqual(sanitizeSourceOptions(null), {});
        });
    });

    describe('isOriginAllowed', () => {
        it('matches exactly and only exactly', () => {
            assert.strictEqual(
                isOriginAllowed('https://kmeet.infomaniak.com', [ 'https://kmeet.infomaniak.com' ]),
                true);
            assert.strictEqual(
                isOriginAllowed('https://sub.kmeet.infomaniak.com', [ 'https://kmeet.infomaniak.com' ]),
                false);
            assert.strictEqual(
                isOriginAllowed('https://attacker.invalid', [ 'https://kmeet.infomaniak.com' ]),
                false);
        });

        it('fails closed on missing input', () => {
            assert.strictEqual(isOriginAllowed(null, [ 'https://kmeet.infomaniak.com' ]), false);
            assert.strictEqual(isOriginAllowed('https://kmeet.infomaniak.com', null), false);
            assert.strictEqual(isOriginAllowed('https://kmeet.infomaniak.com', []), false);
        });
    });

    describe('ScreenShareMainHook._onGetSourcesInvoke', () => {
        it('rejects senders other than the meeting window renderer', () => {
            const hook = setupScreenSharingMain(meetingWindow, 'kMeet', 'ch.infomaniak.meet');

            return hook
                ._onGetSourcesInvoke({ sender: { id: 'other-window' } }, { types: [ 'screen' ] })
                .then(
                    () => assert.fail('expected rejection'),
                    error => assert.strictEqual(error.message, 'Unauthorized getSources sender'))
                .then(() => hook.cleanup());
        });

        it('rejects a missing event', () => {
            const hook = setupScreenSharingMain(meetingWindow, 'kMeet', 'ch.infomaniak.meet');

            return hook
                ._onGetSourcesInvoke(undefined, {})
                .then(
                    () => assert.fail('expected rejection'),
                    error => assert.strictEqual(error.message, 'Unauthorized getSources sender'))
                .then(() => hook.cleanup());
        });

        it('serves the meeting window renderer with sanitized options', () => {
            const hook = setupScreenSharingMain(meetingWindow, 'kMeet', 'ch.infomaniak.meet');
            capturedSourcesArgs = null;

            return hook
                ._onGetSourcesInvoke(
                    { sender: MEETING_WEBCONTENTS },
                    { types: [ 'screen', 'document' ], thumbnailSize: { width: 9999, height: 150 } })
                .then(sources => {
                    assert.deepStrictEqual(sources, [ { id: 'source:1' } ]);
                    assert.deepStrictEqual(capturedSourcesArgs, {
                        types: [ 'screen' ],
                        thumbnailSize: { width: 320, height: 150 }
                    });
                })
                .then(() => hook.cleanup());
        });
    });

    describe('ScreenShareRenderHook origin gate', () => {
        const TRUSTED = [ 'https://kmeet.infomaniak.com', 'https://kmeet.preprod.dev.infomaniak.ch' ];

        it('exposes the helper for a trusted origin', () => {
            const { api, contentWindow } = createFakeApi('https://kmeet.infomaniak.com/room#x');

            setupScreenSharingRender(api, { allowedOrigins: TRUSTED });
            api._fireLoad();

            assert.ok(contentWindow.JitsiMeetElectron);
            assert.strictEqual(typeof contentWindow.JitsiMeetElectron.obtainDesktopStreams, 'function');
        });

        it('refuses the helper for an untrusted origin (allow-list bypass page)', () => {
            const { api, contentWindow } = createFakeApi('https://attacker.invalid/room#@kmeet.infomaniak.com/x');

            setupScreenSharingRender(api, { allowedOrigins: TRUSTED });
            api._fireLoad();

            assert.strictEqual(contentWindow.JitsiMeetElectron, undefined);
        });

        it('refuses the helper when the origin cannot be determined', () => {
            const { api, contentWindow } = createFakeApi('not-a-url');

            setupScreenSharingRender(api, { allowedOrigins: TRUSTED });
            api._fireLoad();

            assert.strictEqual(contentWindow.JitsiMeetElectron, undefined);
        });

        it('applies the legacy behavior (with warning) when no origins are configured', () => {
            const { api, contentWindow } = createFakeApi('https://attacker.invalid/room');

            setupScreenSharingRender(api);
            api._fireLoad();

            assert.ok(contentWindow.JitsiMeetElectron);
        });
    });
});
