/* global __dirname */
const {
    app,
    dialog,
    screen,
    BrowserWindow
} = require('electron');
const process = require('process');
const os = require('os');
const path = require('path');
const {
    DISPLAYS_CHANGED_EVENT,
    DISPLAY_METRICS_CHANGED,
    GET_DISPLAY_EVENT,
    RD_START,
    SCREEN_SHARE_DRAW_EVENTS_CHANNEL,
    EVENTS
} = require('./constants');
const { addInvokeRoute, addSendRoute, removeInvokeRoute, removeSendRoute } = require('../helpers/ipcRouter');
const { windowsEnableScreenProtection } = require('../helpers/functions');

/**
 * Module to run on the main process. It owns the remote draw session: it
 * asks the user for consent, resolves the shared display, hosts the
 * transparent draw overlay window and forwards the draw marker events to it.
 * Keeping the consent gate and the overlay in the trusted main process is
 * what lets the Jitsi Meet window run with context isolation enabled.
 */
class RemoteDraw {
    /**
     * Constructs a new instance and wires up the IPC handlers.
     *
     * @param {BrowserWindow} jitsiMeetWindow - the BrowserWindow object which displays the meeting.
     * @param {Object} [options] - Optional configuration.
     * @param {function(Object): Promise<boolean>|boolean|false} [options.requestConsent] - Asks the
     * user whether a remote draw session may start, receiving `{ sourceId }`. It must resolve to
     * true only when the user explicitly allowed it. Defaults to a native message box parented to
     * `jitsiMeetWindow`. Embedders should supply this to provide their own (e.g. localized) wording,
     * but whatever they supply MUST NOT be renderable or dismissable by web content. Pass `false` to
     * disable the gate entirely and start every session that is requested - see
     * {@link _resolveRequestConsent} for when that is (and is not) defensible.
     */
    constructor(jitsiMeetWindow, options = {}) {
        this._jitsiMeetWindow = jitsiMeetWindow;
        this._webContents = jitsiMeetWindow.webContents;
        this._requestConsent = this._resolveRequestConsent(options.requestConsent);

        // Whether a consent request is currently on screen. Guards against a
        // hostile - or merely repeating - renderer stacking up dialogs.
        this._consentPending = false;

        // The display metrics of the currently shared desktop, kept so the
        // draw overlay can be positioned on it.
        this._display = undefined;

        this.cleanup = this.cleanup.bind(this);

        // this._onScreenSharingEvent = this._onScreenSharingEvent.bind(this);
        this._onDrawEvent = this._onDrawEvent.bind(this);

        this._handleDisplayMetricsChanged = this._handleDisplayMetricsChanged.bind(this);
        this._handleGetDisplayEvent = this._handleGetDisplayEvent.bind(this);
        this._handleStart = this._handleStart.bind(this);
        this._createScreenDraw = this._createScreenDraw.bind(this);

        // Route by sender so only the window this session belongs to can drive
        // it, and so several windows can each run remote draw without the
        // process-wide ipcMain registrations colliding.
        addInvokeRoute(RD_START, { owner: this._webContents, handler: this._handleStart });
        addInvokeRoute(GET_DISPLAY_EVENT, {
            owner: this._webContents,
            handler: this._handleGetDisplayEvent
        });
        addSendRoute(SCREEN_SHARE_DRAW_EVENTS_CHANNEL, { owner: this._webContents, handler: this._onDrawEvent });

        app.whenReady().then(() => {
            screen.on(DISPLAY_METRICS_CHANGED, this._handleDisplayMetricsChanged);
        });

        // Clean up handlers to avoid leaks.
        this._jitsiMeetWindow.on('closed', this.cleanup);
    }

    /**
     * Cleanup any handlers.
     */
    cleanup() {
        removeInvokeRoute(RD_START, this._webContents);
        removeInvokeRoute(GET_DISPLAY_EVENT, this._webContents);
        removeSendRoute(SCREEN_SHARE_DRAW_EVENTS_CHANNEL, this._webContents);
        screen.removeListener(DISPLAY_METRICS_CHANGED, this._handleDisplayMetricsChanged);
    }

    /**
     * Resolves the `requestConsent` option into the function `_handleStart`
     * calls.
     *
     * `false` opts out of the gate: every requested session starts without
     * asking. That is only defensible when the embedder can guarantee that a
     * start request cannot originate from untrusted web content - for instance
     * a kiosk or support appliance that loads a single deployment it controls,
     * and that has already obtained consent out of band. It is NOT defensible
     * for a general purpose client whose server URL the user (or an attacker)
     * can point anywhere: the request arrives as an iframe -> top frame
     * postMessage, so with the gate off any page loaded in the meeting iframe
     * can open the draw overlay with no interaction at all.
     *
     * @param {function(Object): Promise<boolean>|boolean|false|undefined} requestConsent - The
     * option as passed by the embedder.
     * @returns {function(Object): Promise<boolean>|boolean} The consent function.
     */
    _resolveRequestConsent(requestConsent) {
        if (requestConsent === false) {
            console.warn('[remotedraw] The user consent gate is disabled: remote draw sessions '
                + 'will start without asking.');

            return () => true;
        }

        return requestConsent || this._showConsentDialog.bind(this);
    }

    /**
     * Shows the default consent dialog: a native, modal message box parented to
     * the meeting window. Web content can neither render, click nor dismiss it,
     * which is the point - it holds even if both the Jitsi Meet iframe and the
     * renderer hosting it are fully compromised.
     *
     * @returns {Promise<boolean>} Whether the user allowed the session.
     */
    async _showConsentDialog() {
        const { response } = await dialog.showMessageBox(this._jitsiMeetWindow, {
            type: 'warning',
            buttons: [ 'Deny', 'Allow' ],
            defaultId: 0,
            cancelId: 0,
            message: 'Allow remote drawing on this computer?',
            detail: 'A meeting participant is requesting to draw on your screen.'
        });

        return response === 1;
    }

    /**
     * Handles the RD_START request: asks the user for consent, then resolves
     * and stores the display for the shared sourceId and opens the draw
     * overlay on it.
     *
     * The consent gate lives here rather than in the renderer on purpose. The
     * start request reaches the renderer as an iframe -> top frame postMessage,
     * a channel that carries no trustworthy identity, so the only consent that
     * cannot be forged by the page is one collected by the main process.
     *
     * @param {IpcMainInvokeEvent} event - The electron event.
     * @param {string} sourceId - The source id of the desktop sharing stream.
     * @returns {Promise<Object>} `{ result: true }` on success, otherwise `{ error }`.
     */
    async _handleStart(event, sourceId) {
        if (this._consentPending) {
            return { error: 'Error: a remote draw request is already pending' };
        }

        this._consentPending = true;

        let granted;

        try {
            granted = await this._requestConsent({ sourceId });
        } catch (error) {
            console.error('Error requesting remote draw consent:', error && error.message);
            granted = false;
        } finally {
            this._consentPending = false;
        }

        if (!granted) {
            return { error: 'Error: remote draw denied by the user' };
        }

        // The window may have gone away while the dialog was up, in which case
        // the session (and its IPC routes) no longer exist.
        if (this._jitsiMeetWindow.isDestroyed()) {
            return { error: 'Error: the meeting window is gone' };
        }

        this._display = this._getDisplay(sourceId);

        if (this._display) {
            this._createScreenDraw();

            return { result: true };
        }

        return { error: 'Error: Can\'t detect the display that is currently shared' };
    }

    /**
     * Handles the GET_DISPLAY_EVENT request.
     *
     * @param {IpcMainInvokeEvent} event - The electron event.
     * @param {string} sourceId - The source id of the desktop sharing stream.
     * @returns {Object|undefined} The display matching the sourceId, or
     * undefined when it cannot be resolved.
     */
    _handleGetDisplayEvent(event, sourceId) {
        return this._getDisplay(sourceId);
    }

    /**
     * Handles DISPLAY_METRICS_CHANGED event
     */
    _handleDisplayMetricsChanged() {
        if (!this._jitsiMeetWindow.isDestroyed()) {
            this._jitsiMeetWindow.webContents.send(DISPLAYS_CHANGED_EVENT);
        }
    }

    /**
     * Returns the display metrics(x, y, width, height, scaleFactor, etc...) of the display that will be used for the
     * remote draw.
     *
     * @param {string} sourceId - The source id of the desktop sharing stream.
     * @returns {Object} bounds and scaleFactor of display matching sourceId.
     */
     _getDisplay(sourceId) {
        const displays = screen.getAllDisplays();

        switch(displays.length) {
            case 0:
                return undefined;
            case 1:
                // On Linux probably we'll end up here even if there are
                // multiple monitors.
                return displays[0];
            // eslint-disable-next-line no-case-declarations
            default: { // > 1 display
                // Remove the type part from the sourceId
                const parsedSourceId = sourceId.replace('screen:', '');

                // Currently native code sourceId2Coordinates is only necessary for windows.
                if (process.platform === 'win32') {
                    const sourceId2Coordinates = require("../node_addons/sourceId2Coordinates");
                    const coordinates = sourceId2Coordinates(parsedSourceId);
                    if(coordinates) {
                        const { x, y } = coordinates;
                        const display
                            = screen.getDisplayNearestPoint({
                                x: x + 1,
                                y: y + 1
                            });

                        if (typeof display !== 'undefined') {
                            // We need to use x and y returned from sourceId2Coordinates because the ones returned from
                            // Electron don't seem to respect the scale factors of the other displays.
                            const { width, height } = display.bounds;

                            return {
                                bounds: {
                                    x,
                                    y,
                                    width,
                                    height
                                },
                                scaleFactor: display.scaleFactor
                            };
                        } else {
                            return undefined;
                        }
                    }
                } else if (process.platform === 'darwin') {
                    // On Mac OS the sourceId = 'screen' + displayId.
                    // Try to match displayId with sourceId.
                    let displayId = Number(parsedSourceId);

                    if (isNaN(displayId)) {
                        // The source id may have the following format "desktop_id:0".

                        const idArr = parsedSourceId.split(":");

                        if (idArr.length <= 1) {
                            return;
                        }

                        displayId = Number(idArr[0]);
                    }
                    return displays.find(display => display.id === displayId);
                } else {
                    return undefined;
                }
            }
        }
    }

    /**
     * Handles the draw marker events coming from the renderer process:
     * stops the remote drawing session, or forwards the event to the overlay
     * window.
     *
     * @param {IpcMainEvent} event - The electron event.
     * @param {Object} datas - Channel specific data.
     */
    _onDrawEvent(event, datas) {
        const { data } = datas;
        switch (data.name) {
            case EVENTS.stop: {
                this._stop();
                break;
            }
            default:
                if (this._screenShareDrawer) {
                    this._screenShareDrawer.webContents.send(SCREEN_SHARE_DRAW_EVENTS_CHANNEL, datas);
                }
        }
    }

    /**
     * Listen for events coming on the screen sharing event channel.
     *
     * @param {Object} event - Electron event data.
     * @param {Object} data - Channel specific data.
     */
    // _onScreenSharingEvent(event, { data }) {
    //     switch (data.name) {
    //     case SCREEN_SHARE_EVENTS.CLOSE_TRACKER:
    //         if (this._screenShareDrawer) {
    //             this._screenShareDrawer.close();
    //             this._screenShareDrawer = undefined;
    //         }
    //         break;
    //     case SCREEN_SHARE_EVENTS.STOP_SCREEN_SHARE:
    //         if (this._screenShareDrawer) {
    //             this._screenShareDrawer.close();
    //             this._screenShareDrawer = undefined;
    //         }
    //         break;
    //     default:
    //         console.warn(`Unhandled ${SCREEN_SHARE_EVENTS_CHANNEL}: ${data}`);
    //     }
    // }

    /**
     * Closes the draw overlay window, if any.
     */
    _stop() {
        if (this._screenShareDrawer) {
            // this._screenShareDrawer.webContents.close();
            this._screenShareDrawer.close();
            this._screenShareDrawer = undefined;
        }
    }

    /**
     * Opens an always on top window, in the bottom center of the screen, that lets a user know
     * a content sharing session is currently active.
     *
     * @return {void}
     */
    _createScreenDraw() {
        if (this._screenShareDrawer) {
            return;
        }

        // Make the window transparent only if the platform supports it.
        // if (process.platform === 'win32' && !systemPreferences.isAeroGlassEnabled()) {
        //     return;
        // }
        const width = this._display.size ? this._display.size.width : this._display.width;
        const height = this._display.size ? this._display.size.height : this._display.height;
        const x = this._display.workArea ? this._display.workArea.x : this._display.x;
        const y = this._display.workArea ? this._display.workArea.y : this._display.y;

        this._screenShareDrawer = new BrowserWindow({
            width,
            height,
            x,
            y,
            transparent: true,
            frame: false,
            fullscreen: false,
            simpleFullscreen: true,
            fullscreenable: true,
            enableLargerThanScreen: true,
            backgroundColor: '#00FFFFFF',
            hasShadow: false,
            resizable: false,
            alwaysOnTop: true,
            movable: false,
            minimizable: false,
            maximizable: false,
            closable: true,
            focusable: false,
            skipTaskbar: true,
            // FOR TESTING
            // transparent: false,
            // frame: true,
            // fullscreen: false,
            // // simpleFullscreen: true,
            // fullscreenable: false,
            // enableLargerThanScreen: true,
            // backgroundColor: '#00FFFFFF',
            // // hasShadow: false,
            // alwaysOnTop: true,
            // resizable: true,
            // movable: true,
            // minimizable: true,
            // maximizable: false,
            // closable: true,
            // focusable: true,
            // skipTaskbar: false,
            webPreferences: {
                contextIsolation: false,
                nodeIntegration: true,
                preload: path.resolve(__dirname, './preload.js'),
                sandbox: false
            }
        });

        // for Windows OS, only enable protection for builds higher or equal to Windows 10 Version 2004
        // which have the flag WDA_EXCLUDEFROMCAPTURE(which makes the window completely invisible on capture)
        // For older Windows versions, we leave the window completely visible, including content, on capture,
        // otherwise we'll have a black content window on share.
        if (os.platform() !== 'win32' || windowsEnableScreenProtection(os.release())) {
            // Avoid this window from being captured.
            this._screenShareDrawer.setContentProtection(true);
        }


        // this._screenShareDrawer.setAlwaysOnTop(true, 'screen-saver');

        // comment for testing with devtools
        this._screenShareDrawer.setVisibleOnAllWorkspaces(true);
        this._screenShareDrawer.setIgnoreMouseEvents(true);
        this._screenShareDrawer.setFocusable(false);

        this._screenShareDrawer.on('closed', () => {
            this._screenShareDrawer = undefined;
        });

        this._screenShareDrawer.webContents.on('render-process-gone', (event, details) => {
            console.log('close draw local canvas because renderer crashed', details);
            this._screenShareDrawer.close();
        });

        this._screenShareDrawer.loadURL(`file://${__dirname}/remoteDraw.html`);


        // ipcMain.on(SCREEN_SHARE_DRAW_EVENTS_CHANNEL, (event, datas) => {
        //     if (datas.data.name === 'stop') {
        //         this._stop();

        //         return;
        //     }
        //     try {
        //         this._screenShareDrawer.webContents.send(SCREEN_SHARE_DRAW_EVENTS_CHANNEL, datas);
        //     } catch (e) {
        //         console.warn(e);
        //     }
        // });
    }
}

/**
 * Initializes the remote draw functionality in the main electron process.
 *
 * @param {BrowserWindow} jitsiMeetWindow - the BrowserWindow object which displays the meeting.
 * @param {Object} [options] - Optional configuration.
 * @param {function(Object): Promise<boolean>|boolean|false} [options.requestConsent] - Asks the
 * user whether a remote draw session may start, receiving `{ sourceId }`. Defaults to a native
 * message box parented to `jitsiMeetWindow`. Pass `false` to disable the gate entirely, which is
 * only safe when a start request cannot come from untrusted web content.
 * @returns {RemoteDraw} - the remote draw object.
 */
module.exports = function setupRemoteDrawMain(jitsiMeetWindow, options) {
    return new RemoteDraw(jitsiMeetWindow, options);
};
