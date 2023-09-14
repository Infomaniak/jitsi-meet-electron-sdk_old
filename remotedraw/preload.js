const { ipcRenderer } = require('electron');

const { SCREEN_SHARE_DRAW_EVENTS_CHANNEL, EVENTS } = require('./constants');

const whitelistedIpcChannels = [
    'jitsi-screen-sharing-draw-marker'
];

window.JitsiRemoteDraw = {
    EVENTS,
    ipc: {
        on: (channel, listener) => {
            // if (!whitelistedIpcChannels.includes(channel)) {
            //     return;
            // }

            return ipcRenderer.on(channel, listener);
        },
        send: ev => {
            if (Object.values(EVENTS).includes(ev)) {
                ipcRenderer.send(SCREEN_SHARE_DRAW_EVENTS_CHANNEL, ev);
            }
        },
        removeListener: (channel, listener) => {
            if (!whitelistedIpcChannels.includes(channel)) {
                return;
            }

            return ipcRenderer.removeListener(channel, listener);
        }
    }
};
