const { RemoteControl, RemoteControlMain } = require('./remotecontrol');
const { RemoteDraw, RemoteDrawMain } = require('./remotedraw');
const { setupScreenSharingRender, setupScreenSharingMain } = require('./screensharing');
const {
    cleanupAlwaysOnTopMain,
    setupAlwaysOnTopRender,
    setupAlwaysOnTopMain
} = require('./alwaysontop');
const {
    cleanupPowerMonitorMain,
    setupPowerMonitorRender,
    setupPowerMonitorMain
} = require('./powermonitor');
const {
    popupsConfigRegistry,
    initPopupsConfigurationMain,
    initPopupsConfigurationRender,
    getPopupTarget
} = require('./popupsconfig');

module.exports = {
    RemoteControl,
    RemoteControlMain,
    RemoteDraw,
    RemoteDrawMain,
    cleanupAlwaysOnTopMain,
    cleanupPowerMonitorMain,
    setupScreenSharingRender,
    setupScreenSharingMain,
    setupAlwaysOnTopRender,
    setupAlwaysOnTopMain,
    setupPowerMonitorRender,
    setupPowerMonitorMain,
    popupsConfigRegistry,
    initPopupsConfigurationMain,
    initPopupsConfigurationRender,
    getPopupTarget
};
