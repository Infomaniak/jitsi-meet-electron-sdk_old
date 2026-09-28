const process = require('process');
const {
    EVENTS,
    GET_DISPLAY_EVENT,
    MOUSE_ACTIONS_FROM_EVENT_TYPE,
    RD_START,
    SCREEN_SHARE_DRAW_EVENTS_CHANNEL
} = require('./constants');

/**
 * Copies a `{ x, y, width, height }` rectangle when all its values are finite
 * numbers, dropping anything else.
 *
 * @param {Object} rect - The rectangle to sanitize.
 * @returns {Object|undefined} A cloneable rectangle, or undefined when invalid.
 */
function sanitizeRect(rect) {
    if (!rect || typeof rect !== 'object') {
        return undefined;
    }

    const { height, width, x, y } = rect;

    if (!Number.isFinite(x) || !Number.isFinite(y)
            || !Number.isFinite(width) || !Number.isFinite(height)) {
        return undefined;
    }

    return { height, width, x, y };
}

/**
 * Whitelists the display metrics that travel in a draw event envelope. Only
 * the known rectangles and the scale factor are kept, as defense-in-depth
 * against a compromised main world and against non-cloneable values throwing
 * inside `ipcRenderer.send`.
 *
 * @param {Object} display - The display metrics from the main world.
 * @returns {Object|null} A sanitized display, or null when unusable.
 */
function sanitizeDisplay(display) {
    if (!display || typeof display !== 'object') {
        return null;
    }

    const safe = {};
    const bounds = sanitizeRect(display.bounds);
    const workArea = sanitizeRect(display.workArea);

    if (bounds) {
        safe.bounds = bounds;
    }
    if (workArea) {
        safe.workArea = workArea;
    }
    if (Number.isFinite(display.scaleFactor)) {
        safe.scaleFactor = display.scaleFactor;
    }

    // The overlay window offsets its strokes by `workArea.y`, so a draw event
    // without usable work area metrics is guaranteed to throw in the overlay
    // renderer. Drop it instead of forwarding it partially.
    return workArea ? safe : null;
}

/**
 * Copies the string-valued draw event fields that are present, omitting the
 * missing or non-string ones. They are echoed to the overlay window as-is.
 *
 * @param {Object} data - The event payload from the main world.
 * @param {Array<string>} keys - The string fields to copy.
 * @returns {Object} The copied fields.
 */
function pickStrings(data, keys) {
    const picked = {};

    for (const key of keys) {
        if (typeof data[key] === 'string') {
            picked[key] = data[key];
        }
    }

    return picked;
}

/**
 * Whitelists an outgoing remote draw event before it is sent to the main
 * process. Only known event types and the recognized, cloneable fields are
 * kept; anything else is dropped rather than partially forwarded.
 *
 * @param {Object} data - The event payload from the main world.
 * @returns {Object|null} A sanitized payload, or null when the event is invalid.
 */
function sanitizeDrawEvent(data) {
    if (!data || typeof data !== 'object') {
        return null;
    }

    const { type } = data;

    switch (type) {
    case EVENTS.mousemove: {
        const { destX, destY } = data;

        // NOTE: Number.isFinite rather than typeof: NaN and Infinity are both
        // 'number' and would flow straight into the overlay's canvas math.
        if (!Number.isFinite(destX) || !Number.isFinite(destY)) {
            return null;
        }

        return {
            type,
            destX,
            destY,
            ...pickStrings(data, [ 'color', 'nameLabel', 'participantId' ])
        };
    }
    case EVENTS.mousedown:
    case EVENTS.mouseup: {
        const { status } = data;

        if (typeof status !== 'undefined'
                && !Object.values(MOUSE_ACTIONS_FROM_EVENT_TYPE).includes(status)) {
            return null;
        }

        const sanitized = {
            type,
            ...pickStrings(data, [ 'color', 'nameLabel', 'participantId' ])
        };

        if (typeof status !== 'undefined') {
            sanitized.status = status;
        }

        return sanitized;
    }
    case EVENTS.stop:
        // Session stop travels under `name`: the main process switches
        // start/stop on `data.name` (legacy envelope), while draw events are
        // forwarded to the overlay window and keyed on `data.type`.
        return { type: EVENTS.stop, name: EVENTS.stop };
    default:
        return null;
    }
}

/**
 * Builds the remote draw fragment of the `window.jitsiElectronSDK` bridge.
 * The renderer never touches `ipcRenderer`: it starts a session, reads the
 * shared display and forwards sanitized draw events; the main process owns the
 * consent gate, the display resolution and the draw overlay window.
 *
 * @param {Object} context - Preload helpers.
 * @param {Electron.IpcRenderer} context.ipcRenderer - The ipcRenderer instance.
 * @param {Function} context.subscribe - Channel subscription helper.
 * @returns {Object} The remote draw bridge API.
 */
module.exports = function createRemoteDrawBridge({ ipcRenderer, subscribe }) {
    return {
        /**
         * The platform the preload runs on, as a static, cloneable string.
         * Lets the page compute display scale factors without an `os`
         * dependency.
         *
         * @type {string}
         */
        platform: process.platform,

        /**
         * Starts a remote draw session for the shared desktop. The main
         * process collects the user's consent before resolving the display
         * and opening the draw overlay, then replies with the result.
         *
         * @param {string} sourceId - The source id of the desktop sharing stream.
         * @returns {Promise<Object>|undefined} `{ result: true }` on success,
         * else `{ error }`; undefined when sourceId is not a string.
         */
        start: sourceId => (typeof sourceId === 'string'
            ? ipcRenderer.invoke(RD_START, sourceId)
            : undefined),

        /**
         * Fetches the display metrics (bounds, work area, scale factor) of the
         * display backing the shared desktop stream.
         *
         * @param {string} sourceId - The source id of the desktop sharing stream.
         * @returns {Promise<Object>|undefined} The display, or undefined when
         * it cannot be resolved; undefined when sourceId is not a string.
         */
        getDisplay: sourceId => (typeof sourceId === 'string'
            ? ipcRenderer.invoke(GET_DISPLAY_EVENT, sourceId)
            : undefined),

        /**
         * Forwards a single remote draw event to the main process. Draw
         * events (mousemove/mousedown/mouseup) are forwarded to the draw
         * overlay window together with the display metrics the overlay needs
         * to place its strokes; a stop event closes the overlay session.
         *
         * @param {Object} data - The remote draw event.
         * @param {Object} [display] - The display metrics of the shared
         * desktop, as returned by {@link getDisplay}.
         * @returns {void}
         */
        sendEvent: (data, display) => {
            const sanitized = sanitizeDrawEvent(data);

            if (!sanitized) {
                return;
            }

            if (sanitized.type === EVENTS.stop) {
                ipcRenderer.send(SCREEN_SHARE_DRAW_EVENTS_CHANNEL, { data: sanitized });

                return;
            }

            const safeDisplay = sanitizeDisplay(display);

            if (!safeDisplay) {
                return;
            }

            ipcRenderer.send(SCREEN_SHARE_DRAW_EVENTS_CHANNEL, {
                data: sanitized,
                display: safeDisplay
            });
        },

        /**
         * Subscribes to remote draw events pushed back from the main process.
         *
         * @param {Function} callback - Invoked with the event payload.
         * @returns {Function} An unsubscribe function.
         */
        onDrawEvent: callback => subscribe(SCREEN_SHARE_DRAW_EVENTS_CHANNEL, callback),

        /**
         * Subscribes to display change notifications pushed from the main
         * process (no payload): the shared display's metrics should be
         * re-fetched.
         *
         * @param {Function} callback - Invoked with no payload.
         * @returns {Function} An unsubscribe function.
         */
        onDisplaysChanged: callback => subscribe('jitsi-remotedraw-displays-changed', callback)
    };
};
