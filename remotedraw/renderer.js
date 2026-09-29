const postis = require('postis');
const {
    EVENTS,
    MOUSE_ACTIONS_FROM_EVENT_TYPE,
    REMOTE_DRAW_MESSAGE_NAME,
    REQUESTS
} = require('./constants');

/**
 * Renderer process component that sets up the remote draw functionality in the
 * page ("main world") hosting the Jitsi Meet iframe. It relays remote draw
 * messages between the iframe (postis) and the main process, scaling the
 * incoming coordinates to the shared display's metrics. This module is
 * browser-safe: it never requires `electron` or `os` and talks to the main
 * process only through the `window.jitsiElectronSDK.remoteDraw` bridge exposed
 * by the SDK preload.
 * {@link RemoteDraw} needs to be initialized in the main process to work.
 */
class RemoteDrawRenderHook {
    /**
     * Constructs a new instance and initializes the remote draw functionality.
     *
     * @param {JitsiIFrameApi} api - The Jitsi Meet iframe api object.
     */
    constructor(api) {
        this._api = api;
        this._bridge = window.jitsiElectronSDK?.remoteDraw;
        this._iframe = this._api.getIFrame();

        this._onScreenSharingStatusChanged = this._onScreenSharingStatusChanged.bind(this);

        this._iframe.addEventListener('load', () => this._onIFrameLoad());

        /**
         * The status ("up"/"down") of the mouse button.
         * FIXME: Assuming that one button at a time can be pressed. Haven't
         * noticed any issues but maybe we should store the status for every
         * mouse button that we are processing.
         */
        this._mouseButtonStatus = 'up';
    }

    /**
     * Disposes the remote draw functionality.
     */
    dispose() {
        if (this._channel) {
            this._channel.destroy();
            this._channel = null;
        }
        this._stop();
    }

    /**
     * Returns the scale factor for the current display used to calculate the resolution of the display.
     *
     * NOTE: On Mac OS this._display.scaleFactor will always be 2 for some reason. But the values returned from
     * this._display.bounds will already take into account the scale factor. That's why we are returning 1 for Mac OS.
     *
     * @returns {number} The scale factor.
     */
    _getDisplayScaleFactor() {
        return this._bridge.platform === 'darwin' ? 1 : this._display.scaleFactor || 1;
    }

    /**
     * Sets the display metrics(x, y, width, height, scaleFactor, etc...) of the display that will be used for the
     * remote draw.
     *
     * @param {string} sourceId - The source id of the desktop sharing stream.
     * @returns {void}
     */
    _setDisplayMetrics(sourceId) {
        this._bridge.getDisplay(sourceId)
            .then(display => {
                this._display = display;
            })
            .catch(() => {
                this._display = undefined;
            });
    }

    /**
     * Handles remote draw start messages.
     *
     * The main process owns the consent gate: {@link RemoteDraw} asks the user
     * before resolving the display and opening the draw overlay, and replies
     * on the start request.
     *
     * @param {number} id - the id of the request that will be used for the
     * response.
     * @param {string} sourceId - The source id of the desktop sharing stream.
     */
    async _start(id, sourceId) {
        const response = {
            id,
            type: 'response'
        };

        let startResult;

        try {
            startResult = await this._bridge.start(sourceId);
        } catch (error) {
            startResult = { error: `Error: ${error && error.message}` };
        }

        if (startResult && startResult.result) {
            // Keep the display metrics in sync while the session is active:
            // the main process pushes a payload-less notification whenever the
            // displays change.
            this._unsubscribeDisplaysChanged = this._bridge.onDisplaysChanged(
                () => this._setDisplayMetrics(sourceId));

            this._display = await this._bridge.getDisplay(sourceId).catch(() => undefined);

            if (this._display) {
                response.result = true;
            } else {
                response.error
                    = 'Error: Can\'t detect the display that is currently shared';
            }
        } else {
            response.error = (startResult && startResult.error)
                || 'Error: remote draw denied by the user';
        }

        this._sendMessage(response);
    }

    /**
     * Stops processing the events.
     */
    _stop() {
        this._display = undefined;

        if (this._unsubscribeDisplaysChanged) {
            this._unsubscribeDisplaysChanged();
            this._unsubscribeDisplaysChanged = undefined;
        }

        this._bridge.sendEvent({ type: EVENTS.stop });
    }

    /**
     * Handles iframe load events.
     */
    _onIFrameLoad() {
        this._iframe.contentWindow.addEventListener(
            'unload',
            () => this.dispose()
        );
        this._channel = postis({
            window: this._iframe.contentWindow,
            windowForEventListening: window,
            scope: 'jitsi-remote-draw'
        });
        this._channel.ready(() => {
            this._channel.listen('message', message => {
                const { name } = message.data;

                if (name === REMOTE_DRAW_MESSAGE_NAME) {
                    this._onRemoteDrawMessage(message);
                }
            });
            this._sendEvent({ type: EVENTS.supported });
        });

        this._api.on('screenSharingStatusChanged', this._onScreenSharingStatusChanged);
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
        } else {
            this._isScreenSharing = false;

            this._bridge.sendEvent({ type: EVENTS.stop });
        }
    }

    /**
     * Executes the passed message.
     * @param {Object} message the remote draw message.
     */
    _onRemoteDrawMessage(message) {
        const { id, data } = message;

        // If we haven't set the display prop. We haven't received the remote
        // draw start message or there was an error associating a display.
        if (!this._display
            && data.type !== REQUESTS.start) {
            return;
        }
        switch (data.type) {
        case EVENTS.mousemove: {
            const { width, height } = this._display.bounds;
            const scaleFactor = this._getDisplayScaleFactor();
            const destX = data.x * width * scaleFactor;
            const destY = data.y * height * scaleFactor;

            this._bridge.sendEvent({
                type: data.type,
                destX,
                destY,
                color: data.color,
                participantId: data.participantId,
                nameLabel: data.nameLabel
            }, this._display);

            break;
        }
        case EVENTS.mousedown:
        case EVENTS.mouseup: {
            this._mouseButtonStatus
                    = MOUSE_ACTIONS_FROM_EVENT_TYPE[data.type];

            this._bridge.sendEvent({
                type: data.type,
                status: this._mouseButtonStatus,
                color: data.color,
                participantId: data.participantId,
                nameLabel: data.nameLabel
            }, this._display);

            break;
        }
        case REQUESTS.start: {
            this._start(id, data.sourceId);
            break;
        }
        case EVENTS.stop: {
            this._stop();
            break;
        }
        default:
            console.error('Unknown event type!');
        }
    }

    /**
     * Sends remote draw event to the controlled participant.
     *
     * @param {Object} event the remote draw event.
     */
    _sendEvent(event) {
        const remoteDrawEvent = Object.assign(
            { name: REMOTE_DRAW_MESSAGE_NAME },
            event
        );

        this._sendMessage({ data: remoteDrawEvent });
    }

    /**
     * Sends a message to Jitsi Meet.
     *
     * @param {Object} message the message to be sent.
     */
    _sendMessage(message) {
        this._channel.send({
            method: 'message',
            params: message
        });
    }
}

/**
 * Initializes the remote draw functionality in the renderer process containing the
 * jitsi meet iframe.
 *
 * @param {JitsiIFrameApi} api - The Jitsi Meet iframe api object.
 * @returns {RemoteDrawRenderHook} The remote draw render hook instance.
 */
module.exports = function setupRemoteDrawRender(api) {
    return new RemoteDrawRenderHook(api);
};
