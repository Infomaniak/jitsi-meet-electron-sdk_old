
/* global */

/* eslint-disable eqeqeq */
/* eslint-disable no-mixed-operators */
const { ipcRenderer } = require('electron');
const os = require('os');
const postis = require('postis');
const constants = require('./constants');

// const robot = require('@jitsi/robotjs');

const {
    EVENTS,
    MOUSE_ACTIONS_FROM_EVENT_TYPE,
    REMOTE_DRAW_MESSAGE_NAME,
    REQUESTS
} = constants;

/**
 * Parses the remote draw events and executes them via robotjs.
 * {@link RemoteDrawMain} needs to be initialized in the main process.
 * to work.
 */
class RemoteDraw {
    /**
     * Constructs new instance and initializes the remote draw functionality.
     *
     * @param {HTMLElement} iframe the Jitsi Meet iframe.
     */
    constructor(iframe) {
        this._iframe = iframe;
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
        return os.type() === 'Darwin' ? 1 : this._display.scaleFactor || 1;
    }

    /**
     * Sets the display metrics(x, y, width, height, scaleFactor, etc...) of the display that will be used for the
     * remote draw.
     *
     * @param {string} sourceId - The source id of the desktop sharing stream.
     * @returns {void}
     */
    _setDisplayMetrics(sourceId) {
        this._display = ipcRenderer.sendSync('jitsi-remotedraw-get-display', sourceId);
    }

    /**
     * Handles remote draw start messages.
     *
     * @param {number} id - the id of the request that will be used for the
     * response.
     * @param {string} sourceId - The source id of the desktop sharing stream.
     */
    _start(id, sourceId) {
        this._displayMetricsChangeListener = () => {
            this._setDisplayMetrics(sourceId);
        };
        ipcRenderer.on('jitsi-remotedraw-displays-changed', this._displayMetricsChangeListener);
        this._setDisplayMetrics(sourceId);

        const response = {
            id,
            type: 'response'
        };

        if (this._display) {
            response.result = true;
            ipcRenderer.send(constants.SCREEN_SHARE_DRAW_EVENTS_CHANNEL, {
                data: {
                    name: 'start'
                },
            });
        } else {
            response.error
                = 'Error: Can\'t detect the display that is currently shared';
        }

        this._sendMessage(response);
    }

    /**
     * Stops processing the events.
     */
    _stop() {
        this._display = undefined;

        if (this._displayMetricsChangeListener) {
            ipcRenderer.removeListener('jitsi-remotedraw-displays-changed', this._displayMetricsChangeListener);
            this._displayMetricsChangeListener = undefined;
        }
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
            && data.type != REQUESTS.start) {
            return;
        }
        switch (data.type) {
        case EVENTS.mousemove: {
            const { width, height } = this._display.bounds;
            const scaleFactor = this._getDisplayScaleFactor();
            const destX = data.x * width * scaleFactor;
            const destY = data.y * height * scaleFactor;

            ipcRenderer.send(constants.SCREEN_SHARE_DRAW_EVENTS_CHANNEL, {
                data: {
                    type: data.type,
                    destX,
                    destY,
                    color: data.color,
                    participantId: data.participantId,
                    nameLabel: data.nameLabel
                },
                display: this._display
            });


            break;
        }
        case EVENTS.mousedown:
        case EVENTS.mouseup: {
            this._mouseButtonStatus
                    = MOUSE_ACTIONS_FROM_EVENT_TYPE[data.type];

            ipcRenderer.send(constants.SCREEN_SHARE_DRAW_EVENTS_CHANNEL, {
                data: {
                    type: data.type,
                    status: this._mouseButtonStatus,
                    color: data.color,
                    participantId: data.participantId,
                    nameLabel: data.nameLabel
                },
                display: this._display
            });

            break;
        }

        // case EVENTS.keydown:
        // case EVENTS.keyup: {
        //     if (data.key) {
        //         robot.keyToggle(
        //                 data.key,
        //                 KEY_ACTIONS_FROM_EVENT_TYPE[data.type],
        //                 data.modifiers);
        //     }
        //     break;
        // }
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

module.exports = RemoteDraw;
