
const { ipcRenderer } = require('electron');

const { SCREEN_SHARE_EVENTS_CHANNEL, SCREEN_SHARE_EVENTS, SCREEN_SHARE_GET_SOURCES } = require('./constants');
const { isOriginAllowed } = require('./utils');

/**
 * Renderer process component that sets up electron specific screen sharing functionality, like screen sharing
 * marker and window selection.
 * {@link ScreenShareMainHook} needs to be initialized in the main process for the always on top tracker window
 * to work.
 */
class ScreenShareRenderHook {
    /**
     * Creates a ScreenShareRenderHook hooked to jitsi meet iframe events.
     *
     * @param {JitsiIFrameApi} api - The Jitsi Meet iframe api object.
     * @param {Object} options - Hook configuration.
     * @param {string[]} options.allowedOrigins - The origins the embedding app
     * trusts for its meeting iframe (e.g. ["https://kmeet.infomaniak.com"]).
     * The JitsiMeetElectron helper is only exposed to pages served from these
     * origins. When omitted, the legacy behavior applies (the helper is
     * exposed to whatever page the iframe loads) and a warning is logged.
     */
    constructor(api, options = {}) {
        this._api = api;
        this._iframe = this._api.getIFrame();
        this._allowedOrigins = Array.isArray(options.allowedOrigins)
            ? options.allowedOrigins : null;

        this._onScreenSharingStatusChanged = this._onScreenSharingStatusChanged.bind(this);
        this._sendCloseTrackerEvent = this._sendCloseTrackerEvent.bind(this);
        this._onScreenSharingEvent = this._onScreenSharingEvent.bind(this);
        this._onIframeApiLoad = this._onIframeApiLoad.bind(this);
        this._cleanTrackerContext = this._cleanTrackerContext.bind(this);
        this._onApiDispose = this._onApiDispose.bind(this);

        this._api.on('_willDispose', this._onApiDispose);
        this._iframe.addEventListener('load', this._onIframeApiLoad);
    }

    /**
     * Make sure that even after reload/redirect the screensharing will be available
     */
    _onIframeApiLoad() {
        if (!this._isOriginTrusted()) {
            console.warn(`[screensharing] Refusing to expose desktop capture to untrusted origin: ${this._getIframeOrigin() || 'unknown'}`);

            return;
        }

        this._iframe.contentWindow.JitsiMeetElectron = {
            /**
             * Get sources available for screensharing. The callback is invoked
             * with an array of DesktopCapturerSources.
             *
             * @param {Function} callback - The success callback.
             * @param {Function} errorCallback - The callback for errors.
             * @param {Object} options - Configuration for getting sources.
             * @param {Array} options.types - Specify the desktop source types
             * to get, with valid sources being "window" and "screen".
             * @param {Object} options.thumbnailSize - Specify how big the
             * preview images for the sources should be. The valid keys are
             * height and width, e.g. { height: number, width: number}. By
             * default electron will return images with height and width of
             * 150px.
             */
            obtainDesktopStreams(callback, errorCallback, options = {}) {
                ipcRenderer.invoke(SCREEN_SHARE_GET_SOURCES, options)
                    .then((sources) => callback(sources))
                    .catch((error) => errorCallback(error));
            },
            getScreenPermissions(callback, errorCallback) {
                ipcRenderer.invoke('screen-share-permissions')
                    .then((permission) => callback(permission))
                    .catch((error) => errorCallback(error));
            },
            openMacScreenPermissionSettings(callback, errorCallback) {
                ipcRenderer.invoke('open-screen-permission-settings')
                    .then(() => callback())
                    .catch((error) => errorCallback(error));
            },
            openMacPermissionSettings(callback, errorCallback, anchor) {
                ipcRenderer.invoke('open-permission-settings', anchor)
                    .then(() => callback?.())
                    .catch((error) => errorCallback(error));
            }
        };

        ipcRenderer.on(SCREEN_SHARE_EVENTS_CHANNEL, this._onScreenSharingEvent);
        this._api.on('screenSharingStatusChanged', this._onScreenSharingStatusChanged);
        this._api.on('videoConferenceLeft', this._sendCloseTrackerEvent);
    }

    /**
     * Computes the origin of the page currently loaded in the meeting iframe.
     *
     * @returns {?string} The origin, or null when it cannot be determined.
     */
    _getIframeOrigin() {
        try {
            return new URL(this._iframe.src).origin || null;
        } catch (e) {
            return null;
        }
    }

    /**
     * Gates the exposure of the JitsiMeetElectron desktop capture helper on
     * the origin of the page loaded in the meeting iframe. This is the port
     * of the upstream v10.0.5 user-initiated share gate (commit 144080fd) to
     * the legacy obtainDesktopStreams API: that API has no getDisplayMedia
     * flow to correlate with, so the trust boundary is drawn at injection
     * time instead - only pages from the origins the embedding app declared
     * may ever see the helper, whatever page ended up in the iframe.
     *
     * @returns {boolean} True when the helper may be exposed.
     */
    _isOriginTrusted() {
        if (this._allowedOrigins === null) {
            // Legacy mode: the embedding app did not configure an origin
            // list. Keep the previous behavior but make it visible.
            console.warn('[screensharing] No allowedOrigins configured: the desktop capture helper is exposed to whatever page the iframe loads.');

            return true;
        }

        return isOriginAllowed(this._getIframeOrigin(), this._allowedOrigins);
    }

    /**
     * Listen for events coming on the screen sharing event channel.
     *
     * @param {Object} event - Electron event data.
     * @param {Object} data - Channel specific data.
     *
     * @returns {void}
     */
    _onScreenSharingEvent(event, { data }) {
        switch (data.name) {
            // Event send by the screen sharing tracker window when a user stops screen sharing from it.
            // Send appropriate command to jitsi meet api.
            case SCREEN_SHARE_EVENTS.STOP_SCREEN_SHARE:
                if (this._isScreenSharing) {
                    this._api.executeCommand('toggleShareScreen');
                }
                break;
            default:
                console.warn(`Unhandled ${SCREEN_SHARE_EVENTS_CHANNEL}: ${data}`);

        }
    }

    /**
     * React to screen sharing events coming from the jitsi meet api. There should be
     * a {@link ScreenShareMainHook} listening on the main process for the forwarded events.
     *
     * @param {Object} event
     *
     * @returns {void}
     */
    _onScreenSharingStatusChanged(event) {
        if (event.on) {
            this._isScreenSharing = true;
            // Send event which should open an always on top tracker window from the main process.
            ipcRenderer.send(SCREEN_SHARE_EVENTS_CHANNEL, {
                data: {
                    name: SCREEN_SHARE_EVENTS.OPEN_TRACKER
                }
            });
        } else {
            this._isScreenSharing = false;
            this._sendCloseTrackerEvent();
        }
    }

    /**
     * Send event which should close the always on top tracker window.
     *
     * @return {void}
     */
    _sendCloseTrackerEvent() {
        ipcRenderer.send(SCREEN_SHARE_EVENTS_CHANNEL, {
            data: {
                name: SCREEN_SHARE_EVENTS.CLOSE_TRACKER
            }
        });
    }

    /**
     * Clear all event handlers related to the tracker in order to avoid any potential leaks and closes it in the event
     * that it's currently being displayed.
     *
     * @returns {void}
     */
    _cleanTrackerContext() {
        ipcRenderer.removeListener(SCREEN_SHARE_EVENTS_CHANNEL, this._onScreenSharingEvent);
        this._api.removeListener('screenSharingStatusChanged', this._onScreenSharingStatusChanged);
        this._api.removeListener('videoConferenceLeft', this._sendCloseTrackerEvent);
        this._sendCloseTrackerEvent();
    }

    /**
     * Clear all event handlers in order to avoid any potential leaks.
     *
     * NOTE: It is very important to remove the load listener only when we are sure that the iframe won't be used
     * anymore. Otherwise if we use the videoConferenceLeft event for example, when the iframe is internally reloaded
     * because of an error and then loads again we won't initialize the screen sharing functionality.
     *
     * @returns {void}
     */
    _onApiDispose() {
        this._cleanTrackerContext();
        this._api.removeListener('_willDispose', this._onApiDispose);
        this._iframe.removeEventListener('load', this._onIframeApiLoad);
    }
}

/**
 * Initializes the screen sharing electron specific functionality in the renderer process containing the
 * jitsi meet iframe.
 *
 * @param {JitsiIFrameApi} api - The Jitsi Meet iframe api object.
 * @param {Object} options - Hook configuration, see {@link ScreenShareRenderHook}.
 */
module.exports = function setupScreenSharingRender(api, options = {}) {
    return new ScreenShareRenderHook(api, options);
};
