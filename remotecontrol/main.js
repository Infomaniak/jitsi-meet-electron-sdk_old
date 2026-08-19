const {
    app,
    ipcMain,
    screen,
} = require('electron');
const process = require('process');

const { DISPLAY_METRICS_CHANGED, GET_DISPLAY_EVENT, RC_START } = require('./constants');

/**
 * Module to run on main process to get display dimensions for remote control.
 *
 * The constructor accepts an optional `options.requestConsent` callback that
 * is invoked before a remote control session starts. It must resolve to true
 * only when the user explicitly allowed it. When omitted, sessions are denied
 * by default (fail-closed). Pass `false` to disable the gate entirely, which
 * is only safe when a start request cannot originate from untrusted web
 * content.
 */
class RemoteControlMain {
    constructor(jitsiMeetWindow, options = {}) {
        this._jitsiMeetWindow = jitsiMeetWindow;
        this._requestConsent = this._resolveRequestConsent(options.requestConsent);
        this._consentPending = false;

        this.cleanup = this.cleanup.bind(this);
        this._handleDisplayMetricsChanged = this._handleDisplayMetricsChanged.bind(this);
        this._handleGetDisplayEvent = this._handleGetDisplayEvent.bind(this);
        this._handleStart = this._handleStart.bind(this);

        ipcMain.on(GET_DISPLAY_EVENT, this._handleGetDisplayEvent);
        ipcMain.handle(RC_START, this._handleStart);

        app.whenReady().then(() => {
            screen.on(DISPLAY_METRICS_CHANGED, this._handleDisplayMetricsChanged);
        });

        // Clean up ipcMain handlers to avoid leaks.
        this._jitsiMeetWindow.on('closed', this.cleanup);
    }

    /**
     * Resolves the requestConsent option into the function _handleStart calls.
     *
     * `false` opts out of the gate: every requested session starts without
     * asking. That is only defensible when the embedder can guarantee that a
     * start request cannot originate from untrusted web content. When no
     * callback is supplied, the default is to deny (fail-closed) so that an
     * embedder who forgets to pass a consent function does not silently expose
     * the machine.
     *
     * @param {Function|boolean|undefined} requestConsent
     * @returns {Function} The consent function.
     */
    _resolveRequestConsent(requestConsent) {
        if (requestConsent === false) {
            console.warn('[remotecontrol] The user consent gate is disabled: '
                + 'remote control sessions will start without asking.');
            return () => true;
        }
        if (typeof requestConsent === 'function') {
            return requestConsent;
        }
        console.warn('[remotecontrol] No requestConsent callback provided: '
            + 'remote control sessions will be denied by default.');
        return () => false;
    }

    /**
     * Cleanup any handlers
     */
     cleanup() {
        ipcMain.removeListener(GET_DISPLAY_EVENT, this._handleGetDisplayEvent);
        ipcMain.removeHandler(RC_START);
        screen.removeListener(DISPLAY_METRICS_CHANGED, this._handleDisplayMetricsChanged);
    }

    /**
     * Handles the RC_START request: asks the user for consent, then resolves
     * the shared display for the given sourceId.
     *
     * The consent gate lives in the main process on purpose. The start request
     * reaches the renderer as an iframe -> top frame postMessage, a channel
     * that carries no trustworthy identity, so the only consent that cannot be
     * forged by the page is one collected by the main process.
     *
     * @param {IpcMainInvokeEvent} event - The electron event.
     * @param {string} sourceId - The source id of the desktop sharing stream.
     * @returns {Promise<Object>} `{ result: true, display }` on success, else `{ error }`.
     */
    async _handleStart(event, sourceId) {
        if (this._consentPending) {
            return { error: 'Error: a remote control request is already pending' };
        }
        this._consentPending = true;

        let granted;
        try {
            granted = await this._requestConsent({ sourceId });
        } catch (error) {
            console.error('[remotecontrol] Error requesting consent:', error && error.message);
            granted = false;
        } finally {
            this._consentPending = false;
        }

        if (!granted) {
            return { error: 'Error: remote control denied by the user' };
        }

        if (this._jitsiMeetWindow.isDestroyed()) {
            return { error: 'Error: the meeting window is gone' };
        }

        const display = this._getDisplay(sourceId);

        if (display) {
            return { result: true, display };
        }

        return { error: 'Error: Can\'t detect the display that is currently shared' };
    }

    /**
     * Handles GET_DISPLAY_EVENT event
     * @param {IPCMainEvent} event - The electron event
     * @param {string} sourceId - The source id of the desktop sharing stream.
     */
    _handleGetDisplayEvent(event, sourceId) {
        event.returnValue = this._getDisplay(sourceId);
    }

    /**
     * Handles DISPLAY_METRICS_CHANGED event
     */
    _handleDisplayMetricsChanged() {
        if (!this._jitsiMeetWindow.isDestroyed()) {
            this._jitsiMeetWindow.webContents.send('jitsi-remotecontrol-displays-changed');
        }
    }

    /**
     * Returns the display metrics(x, y, width, height, scaleFactor, etc...) of the display that will be used for the
     * remote control.
     *
     * @param {string} sourceId - The source id of the desktop sharing stream.
     * @returns {Object} bounds and scaleFactor of display matching sourceId.
     */
     _getDisplay(sourceId) {
        const { screen } = require('electron');

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
}

module.exports = RemoteControlMain;