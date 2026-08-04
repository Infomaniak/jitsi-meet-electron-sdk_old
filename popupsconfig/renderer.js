const { ipcRenderer } = require('electron');

let activePopups = {};

/**
 * Initializes the popup configuration module in the renderer process.
 *
 * @param {JitsiMeetExternalAPI} api - The iframe api instance.
 */
// eslint-disable-next-line no-unused-vars
function initPopupsConfiguration(api) {
    function _navigateListener(event, url, frameName, winId) {
        if (url.indexOf('/static/oauth.html#') !== -1) {
            const iframe = api.getIFrame();

            if (!iframe) {
                return;
            }
            // Track the active popup
            activePopups[winId] = true;

            const iframeWindow = iframe.contentWindow;
            if (iframeWindow
                && typeof iframeWindow.JitsiMeetJS !== 'undefined'
                && typeof iframeWindow.JitsiMeetJS.app !== 'undefined'
                && typeof iframeWindow.JitsiMeetJS.app.oauthCallbacks
                    !== 'undefined'
                && typeof iframeWindow.JitsiMeetJS.app.oauthCallbacks[frameName]
                    !== 'undefined') {
                iframeWindow.JitsiMeetJS.app.oauthCallbacks[frameName](url);
                if (activePopups[winId]) {
                    closePopup(winId);
                }
            }
        }
    }

    ipcRenderer.on('jitsi-popup-closed', (event, winId) => {
        delete activePopups[winId];
    });

    ipcRenderer.on('jitsi-popups-navigate', _navigateListener);

    api.on('_willDispose', () => {
        ipcRenderer.removeListener('jitsi-popups-navigate', _navigateListener);
    });
}

function closePopup(winId) {
    if (activePopups[winId]) {
        ipcRenderer.send('jitsi-popup-close', winId);
    }
}

module.exports = initPopupsConfiguration;
