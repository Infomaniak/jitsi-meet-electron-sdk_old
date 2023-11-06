/* global __dirname */
const {
    app,
    ipcMain,
    screen,
    BrowserWindow
} = require('electron');
const process = require('process');
const os = require('os');
const path = require('path');
const { SCREEN_SHARE_EVENTS } = require('../screensharing/constants');
const { SCREEN_SHARE_EVENTS_CHANNEL } = require('../screensharing/constants');
const {
    DISPLAY_METRICS_CHANGED, GET_DISPLAY_EVENT,
    SCREEN_SHARE_DRAW_EVENTS_CHANNEL,
    REQUESTS,
    EVENTS
} = require('./constants');
const { windowsEnableScreenProtection } = require('../helpers/functions');

/**
 * Parses the remote draw events and executes them via robotjs.
 */
class RemoteDraw {
    constructor(jitsiMeetWindow) {
        this._jitsiMeetWindow = jitsiMeetWindow;

        this.cleanup = this.cleanup.bind(this);

        // this._onScreenSharingEvent = this._onScreenSharingEvent.bind(this);
        this._onDrawEvent = this._onDrawEvent.bind(this);

        this._handleDisplayMetricsChanged = this._handleDisplayMetricsChanged.bind(this);
        this._handleGetDisplayEvent = this._handleGetDisplayEvent.bind(this);
        this._createScreenDraw = this._createScreenDraw.bind(this);

        ipcMain.on(GET_DISPLAY_EVENT, this._handleGetDisplayEvent);

        app.whenReady().then(() => {
            screen.on(DISPLAY_METRICS_CHANGED, this._handleDisplayMetricsChanged);
        });

        ipcMain.on(SCREEN_SHARE_DRAW_EVENTS_CHANNEL, this._onDrawEvent);
        // ipcMain.on(SCREEN_SHARE_EVENTS_CHANNEL, this._onScreenSharingEvent);

        this._jitsiMeetWindow.on('closed', this.cleanup);
    }

    /**
     * Cleanup any handlers
     */
    cleanup() {
        ipcMain.removeListener(GET_DISPLAY_EVENT, this._handleGetDisplayEvent);
        // ipcMain.removeListener(SCREEN_SHARE_EVENTS_CHANNEL, this._onScreenSharingEvent);
        ipcMain.removeListener(SCREEN_SHARE_DRAW_EVENTS_CHANNEL, this._onDrawEvent);
        screen.removeListener(DISPLAY_METRICS_CHANGED, this._handleDisplayMetricsChanged);
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
            this._jitsiMeetWindow.webContents.send('jitsi-remotedraw-displays-changed');
        }
    }

    /**
     * Returns the display metrics(x, y, width, height, scaleFactor, etc...) of the display that will be used for the
     * remote draw.
     *
     * @param {string} sourceId - The source id of the desktop sharing stream.
     * @returns {Object} bounds and scaleFactor of display matching sourceId.
     */
     /**
     * Returns the display metrics(x, y, width, height, scaleFactor, etc...) of the display that will be used for the
     * remote control.
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

    _onDrawEvent(event, datas) {
        const { data } = datas;
        switch (data.name) {
            case REQUESTS.start: {
                this._display = data.display;
                this._createScreenDraw();
                break;
            }
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
            closable: false,
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

module.exports = RemoteDraw;
