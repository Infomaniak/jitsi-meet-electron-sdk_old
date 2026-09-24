/* global process */

const isMac = () => process.platform === 'darwin';

/**
 * Upper bound, in pixels, for a requested thumbnail dimension. A picker
 * preview never needs more than this, so anything larger is clamped down.
 * (Port of the upstream v10.0.5 sanitizer, commit 144080fd.)
 * @type {number}
 */
const MAX_THUMBNAIL_DIMENSION = 320;

/**
 * The desktopCapturer source types a screen share picker may request.
 * @type {string[]}
 */
const ALLOWED_SOURCE_TYPES = [ 'screen', 'window' ];

/**
 * Coerces one thumbnail dimension into a safe integer in
 * [0, MAX_THUMBNAIL_DIMENSION]. Non-finite or non-positive values become 0.
 *
 * @param {*} value - The raw width/height coming from the meeting page.
 * @returns {number} A bounded, integer pixel size.
 */
function clampDimension(value) {
    const n = Number(value);

    if (!Number.isFinite(n) || n <= 0) {
        return 0;
    }

    return Math.min(Math.floor(n), MAX_THUMBNAIL_DIMENSION);
}

/**
 * Restricts `desktopCapturer.getSources` options to the known, safe fields
 * before they reach the main process. Anything else is dropped, and
 * thumbnail dimensions are clamped so a page cannot inflate the captured
 * previews.
 *
 * @param {*} options - Raw options coming from the meeting page.
 * @returns {Object} Sanitized options safe to pass to desktopCapturer.
 */
function sanitizeSourceOptions(options) {
    const opts = options && typeof options === 'object' ? options : {};
    const safe = {};

    if (Array.isArray(opts.types)) {
        const types = opts.types.filter(type => ALLOWED_SOURCE_TYPES.includes(type));

        if (types.length > 0) {
            safe.types = types;
        }
    }

    if (opts.thumbnailSize && typeof opts.thumbnailSize === 'object') {
        safe.thumbnailSize = {
            height: clampDimension(opts.thumbnailSize.height),
            width: clampDimension(opts.thumbnailSize.width)
        };
    }

    if (typeof opts.fetchWindowIcons === 'boolean') {
        safe.fetchWindowIcons = opts.fetchWindowIcons;
    }

    return safe;
}

/**
 * Checks whether an origin is explicitly trusted for exposure of the
 * `JitsiMeetElectron` desktop capture helper. Comparison is exact: only the
 * origins the embedding app declares are served, subdomains are NOT implied.
 *
 * @param {string} origin - The origin of the page currently loaded in the
 * meeting iframe.
 * @param {string[]} allowedOrigins - Origins trusted by the embedding app.
 * @returns {boolean} True when the origin is trusted.
 */
function isOriginAllowed(origin, allowedOrigins) {
    if (!origin || !Array.isArray(allowedOrigins)) {
        return false;
    }

    return allowedOrigins.includes(origin);
}

module.exports = {
    ALLOWED_SOURCE_TYPES,
    MAX_THUMBNAIL_DIMENSION,
    clampDimension,
    isMac,
    isOriginAllowed,
    sanitizeSourceOptions
};
