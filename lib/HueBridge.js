// homebridge-hue/lib/HueBridge.js
// Copyright © 2016-2021 Erik Baauw. All rights reserved.
//
// Homebridge plugin for Philips Hue and/or deCONZ.

'use strict'

const homebridgeLib = require('homebridge-lib')
const semver = require('semver')
const util = require('util')

const HueAccessoryModule = require('./HueAccessory')
const HueScheduleModule = require('./HueSchedule')
const HueAccessory = HueAccessoryModule.HueAccessory
const HueClient = require('./HueClient')
const HueSchedule = HueScheduleModule.HueSchedule
const WsMonitor = require('./WsMonitor')

// Added by me: Arye Levin
const http = require('http')
const concat = require('concat-stream')
const fs = require('fs')

var longPressTimeoutIDs = {}
let savedStateFilesPath
// End of Added by me: Arye Levin

module.exports = {
  setHomebridge: setHomebridge,
  HueBridge: HueBridge
}

const formatError = homebridgeLib.formatError

// ===== Homebridge ============================================================

let Service
let Characteristic
let my

function setHomebridge (homebridge, _my, _eve) {
  HueAccessoryModule.setHomebridge(homebridge, _my, _eve)
  HueScheduleModule.setHomebridge(homebridge, _my)
  Service = homebridge.hap.Service
  Characteristic = homebridge.hap.Characteristic
  my = _my
  // Added by me: Arye Levin
  savedStateFilesPath = homebridge.user.storagePath() + '/homebridge-hue_states/'
  // End of Added by me: Arye Levin
}

// ===== HueBridge =============================================================

const repeaterTypes = [
  'Range extender', // Trådfri repeater, XBee
  'Configuration tool' // RaspBee, ConBee, ConBee II
]

function HueBridge (platform, host, bridge) {
  this.log = platform.log
  this.platform = platform
  this.host = host
  this.bridge = bridge
  this.hostname = host.split(':')[0]
  this.name = this.hostname
  this.type = 'bridge'
  this.defaultTransitiontime = 0.4
  this.state = {
    heartrate: this.platform.config.heartrate,
    transitiontime: this.defaultTransitiontime,
    bri: 1,
    request: 0,
    lights: 0,
    groups: 0,
    group0: 0,
    sensors: 0,
    schedules: 0,
    rules: 0
  }
  this.serviceList = []
  this.lights = {}
  this.groups = {}
  this.sensors = {}
  this.schedules = {}
  this.rules = {}

  this.whitelist = {
    groups: {},
    lights: {},
    sensors: {},
    schedules: {},
    rules: {}
  }
  this.blacklist = {
    groups: {},
    lights: {},
    sensors: {},
    schedules: {},
    rules: {}
  }
  this.multiclip = {}
  this.multilight = {}
  this.splitlight = {}
  this.outlet = {
    groups: {},
    lights: {}
  }
  this.switch = {
    groups: {},
    lights: {}
  }
  this.valve = {}
  this.wallswitch = {}
  
  // Added by me: Arye Levin
  // this.log.info(JSON.stringify(this.platform.configJson))
  const actionsConfigData = this.platform.configJson["actionsConfigData"]
  this.log.info('actionsConfigData contents: ' + JSON.stringify(actionsConfigData))
  if (actionsConfigData && Array.isArray(actionsConfigData) === false) {
    this.actionsConfigData = actionsConfigData

    let aqaraS1Panels = actionsConfigData.aqara_S1_panels
    if (aqaraS1Panels) {
      this.panelsToResources = {}
      this.resourcesToPanels = {}
      let panels = Object.keys(aqaraS1Panels)
      for (const panel of panels) {
        let panelData = aqaraS1Panels[panel]
        let panelControls = Object.keys(panelData)
        for (const panelControl of panelControls) {
          let controlData = panelData[panelControl]
          if (controlData.resources) {
            this.panelsToResources[panel + '/' + panelControl] = controlData.resources
            for (var i = controlData.resources.length - 1; i >= 0; i--) {
              var rid = controlData.resources[i];
              if (!this.resourcesToPanels[rid]) {
                this.resourcesToPanels[rid] = []
              }
              this.resourcesToPanels[rid].push(panel + '/' + panelControl)
            }
          }
        }
      }
      console.log(JSON.stringify(this.panelsToResources))
      console.log(JSON.stringify(this.resourcesToPanels))
    }
  }
  // Create http-server to trigger doorbell from outside: 
  // curl -X POST -d 'ding=dong&dong=ding' http://HOMEBRIDGEIP:PORT
  var webserverPort = this.platform.configJson.controlServerPort || 5007;
  var server = http.createServer(function (req, res) {
      req.pipe(concat(function (body) {
          // console.log(body.toString());
          var params = JSON.parse(body.toString());
          if (params.rid && !params.rids) {
              params.rids = [params.rid];
          }
          if (params.rids) {
              for (var i = params.rids.length - 1; i >= 0; i--) {
                  var rid = params.rids[i];
                  var pathComponents = rid.split( '/' );
                let a
                switch (pathComponents[1]) {
                  case 'lights':
                    a = this.lights[pathComponents[2]]
                    break
                  case 'groups':
                    a = this.groups[pathComponents[2]]
                    break
                  case 'sensors':
                    a = this.sensors[pathComponents[2]]
                    break
                  default:
                    break
                }
                if (a) {
                    var service = a.service;
                  if (params.action==='toggle') {
                          res.end(JSON.stringify(params) + '\n');
                          console.log("Hue %s toggle!", rid);
                          if (service) {
                              var characteristic = service.getCharacteristic(Characteristic.On);
                              var newPowerState = !characteristic.value;
                              characteristic.setValue(newPowerState > 0);
                              if (newPowerState) {
                                  characteristic = service.getCharacteristic(Characteristic.Brightness);
                                  if (characteristic.value !== 100) {
                                      characteristic.setValue(100);
                                  }
                              }
                              if (params.rids.length > 1) {
                                if (newPowerState) {
                                  params.action = 'turn_on';
                                } else {
                                  params.action = 'turn_off';
                                }
                              }
                          }
                      } else if (params.action==='turn_on') {
                          res.end(JSON.stringify(params) + '\n');
                          console.log("Hue %s turn_on!", rid);
                          if (service) {
                              if (!service.getCharacteristic(Characteristic.On).value) {
                                service.getCharacteristic(Characteristic.On).setValue(true);
                              }
                              var characteristic = service.getCharacteristic(Characteristic.Brightness);
                              if (characteristic.value !== 100) {
                                  characteristic.setValue(100);
                              }
                          }
                      } else if (params.action==='turn_off') {
                          res.end(JSON.stringify(params) + '\n');
                          console.log("Hue %s turn_off!", rid);
                          if (service) {
                              if (service.getCharacteristic(Characteristic.On).value) {
                                service.getCharacteristic(Characteristic.On).setValue(false);
                              }
                          }
                      } else if (params.action==='brighter') {
                          res.end(JSON.stringify(params) + '\n');
                          console.log("Hue %s brighter!", rid);
                          if (service) {
                              if (!service.getCharacteristic(Characteristic.On).value) {
                                service.getCharacteristic(Characteristic.Brightness).setValue(1);
                                service.getCharacteristic(Characteristic.On).setValue(true);
                              } else {
                                var characteristic = service.getCharacteristic(Characteristic.Brightness);
                                var newBrightnessState = Math.min(100, characteristic.value + 5);
                                characteristic.setValue(newBrightnessState);
                              }
                          }
                      } else if (params.action==='darker') {
                          res.end(JSON.stringify(params) + '\n');
                          console.log("Hue %s darker!", rid);
                          if (service) {
                              var characteristic = service.getCharacteristic(Characteristic.Brightness);
                              var newBrightnessState = Math.max(1, characteristic.value - 5);
                              characteristic.setValue(newBrightnessState);
                          }
                      } else if (params.action==='colder') {
                          res.end(JSON.stringify(params) + '\n');
                          console.log("Hue %s colder!", rid);
                          if (service) {
                              var characteristic = service.getCharacteristic(Characteristic.ColorTemperature);
                              var newColorTemperatureState = Math.max(153, characteristic.value - 32);
                              characteristic.setValue(newColorTemperatureState);
                          }
                      } else if (params.action==='warmer') {
                          res.end(JSON.stringify(params) + '\n');
                          console.log("Hue %s warmer!", rid);
                          if (service) {
                              var characteristic = service.getCharacteristic(Characteristic.ColorTemperature);
                              var newColorTemperatureState = Math.min(500, characteristic.value + 32);
                              characteristic.setValue(newColorTemperatureState);
                          }
                      } else if (params.action==='reset') {
                          res.end(JSON.stringify(params) + '\n');
                          console.log("Hue %s reset!", rid);
                          if (service) {
                          service.getCharacteristic(Characteristic.On).setValue(true);
                          service.getCharacteristic(Characteristic.Brightness).setValue(100);
                          service.getCharacteristic(Characteristic.ColorTemperature).setValue(363);
                          }
                      } else {
                          res.end(JSON.stringify(params) + '\n');
                          console.log('Unknown request to Hue %s.\nContent: %s', rid, JSON.stringify(params));
                      }
                  } else {
                      res.end(JSON.stringify(params) + '\n');
                      console.log('Unknown request to Hue %s, Bulb not found.\nContent: %s', rid, JSON.stringify(params));
                  }
              }
          } else {
              res.end(JSON.stringify(params) + '\n');
              console.log('Unknown request to Hue, Missing params.\nContent: %s', JSON.stringify(params));
          }
      }.bind(this)));
  }.bind(this));

  //var server = http.createServer(self.handleRequest.bind(this));
  server.listen(webserverPort, function () {
      console.log("Hue is listening on port %s", webserverPort);
  }.bind(this));

  server.on('error', function (err) {
      console.log("Hue Port %s Server %s ", webserverPort, err);
  }.bind(this));
  // End of Added by me: Arye Levin
}

HueBridge.prototype.getServices = function () {
  this.log.info('%s: %d services', this.name, this.serviceList.length)
  return this.serviceList
}

HueBridge.prototype.accessories = async function () {
  this.accessoryMap = {}
  this.accessoryList = []
  try {
    await this.exposeBridge()
    await this.createUser()
    const state = await this.getFullState()
    await this.exposeResources(state)
    this.platform.bridgeMap[this.bridge.bridgeid] = this
  } catch (error) {
    if (error.message !== 'unknown bridge') {
      this.log.warn('%s: %s - retrying in 15s', this.name, formatError(error))
      await homebridgeLib.timeout(15000)
      return this.accessories()
    }
  }
  this.log.info('%s: %d accessories', this.name, this.accessoryList.length)
  return this.accessoryList
}

HueBridge.prototype.getInfoService = function () {
  return this.infoService
}

HueBridge.prototype.exposeBridge = async function () {
  this.name = this.bridge.name
  this.serialNumber = this.bridge.bridgeid
  // jshint -W106
  this.uuid_base = this.serialNumber
  // jshint +W106
  this.username = this.platform.config.users[this.serialNumber] || ''
  this.config = {
    parallelRequests: 10,
    nativeHomeKitLights: this.platform.config.nativeHomeKitLights,
    nativeHomeKitSensors: this.platform.config.nativeHomeKitSensors
  }
  this.model = this.bridge.modelid
  if (
    this.model === 'BSB002' && !HueClient.isHueBridgeId(this.bridge.bridgeid)
  ) {
    this.model = 'HA-Bridge'
  }
  if (this.model == null) {
    this.model = 'Tasmota'
  }
  this.philips = 'Philips'
  const recommendedVersion = this.platform.packageJson.engines[this.bridge.modelid]
  switch (this.model) {
    case 'BSB001': // Philips Hue v1 (round) bridge;
      this.config.parallelRequests = 3
      this.config.nativeHomeKitLights = false
      this.config.nativeHomeKitSensors = false
      /* falls through */
    case 'BSB002': // Philips Hue v2 (square) bridge;
      this.isHue = true
      this.version = this.bridge.apiversion
      if (semver.gte(this.version, '1.36.0')) {
        this.philips = 'Signify Netherlands B.V.'
      }
      this.manufacturer = this.philips
      this.idString = util.format(
        '%s: %s %s %s v%s, api v%s', this.name, this.manufacturer,
        this.model, this.type, this.bridge.swversion, this.bridge.apiversion
      )
      this.log.info(this.idString)
      if (!semver.satisfies(this.version, recommendedVersion)) {
        this.log.warn(
          '%s: warning: not using recommended Hue bridge api version %s',
          this.name, recommendedVersion
        )
      }
      this.config.link = semver.lt(this.version, '1.31.0')
      break
    case 'deCONZ': // deCONZ rest api
      if (this.bridge.bridgeid === '0000000000000000') {
        this.log.info(
          '%s: RaspBee/ConBee not yet initialised - wait 1 minute', this.bridge.name
        )
        await homebridgeLib.timeout(60000)
        this.bridge = await this.platform.hueDiscovery.config(this.host)
        return this.exposeBridge()
      }
      this.isDeconz = true
      this.manufacturer = 'dresden elektronik'
      this.type = 'gateway'
      this.version = this.bridge.swversion
      this.config.nativeHomeKitLights = false
      this.config.nativeHomeKitSensors = false
      this.config.effects = this.platform.config.effects
      this.idString = util.format(
        '%s: %s %s %s v%s, api v%s', this.name, this.manufacturer,
        this.model, this.type, this.bridge.swversion, this.bridge.apiversion
      )
      this.log.info(this.idString)
      if (!semver.satisfies(this.version, recommendedVersion)) {
        this.log.warn(
          '%s: warning: not using recommended deCONZ gateway version %s',
          this.name, recommendedVersion
        )
      }
      break
    case 'HA-Bridge':
      this.manufacturer = 'HA-Bridge'
      this.idString = util.format(
        '%s: %s v%s, api v%s', this.name, this.model,
        this.bridge.swversion, this.bridge.apiversion
      )
      this.log.info(this.idString)
      this.version = this.bridge.apiversion
      this.config.nativeHomeKitLights = false
      this.config.nativeHomeKitSensors = false
      break
    case 'Tasmota':
      this.manufacturer = 'Sonoff'
      this.idString = util.format(
        '%s: %s %s v%s, api v%s', this.name, this.manufacturer,
        this.model, this.bridge.swversion, this.bridge.apiversion
      )
      this.version = this.bridge.apiversion
      this.config.nativeHomeKitLights = false
      this.config.nativeHomeKitSensors = false
      this.username = 'homebridgehue'
      break
    default:
      this.log.warn(
        '%s: warning: ignoring unknown bridge/gateway %j',
        this.name, this.bridge
      )
      throw new Error('unknown bridge')
  }
  this.config.linkButton = this.platform.config.linkButton == null
    ? this.config.link
    : this.platform.config.linkButton

  const options = {
    config: this.bridge,
    forceHttp: this.platform.config.forceHttp,
    host: this.host,
    keepAlive: true,
    maxSockets: this.platform.config.parallelRequests || this.config.parallelRequests,
    timeout: this.platform.config.timeout,
    waitTimePut: this.platform.config.waitTimePut,
    waitTimePutGroup: this.platform.config.waitTimePutGroup,
    waitTimeResend: this.platform.config.waitTimeResend
  }
  if (this.username !== '') {
    options.username = this.username
  }
  this.hueClient = new HueClient(options)
  this.hueClient
    .on('error', (error) => {
      if (error.request.id !== this.requestId) {
        if (error.request.body == null) {
          this.log(
            '%s: request %d: %s %s', this.name, error.request.id,
            error.request.method, error.request.resource
          )
        } else {
          this.log(
            '%s: request %d: %s %s %s', this.name, error.request.id,
            error.request.method, error.request.resource, error.request.body
          )
        }
        this.requestId = error.request.id
      }
      this.log.warn(
        '%s: request %d: %s', this.name, error.request.id, formatError(error)
      )
    })
    .on('request', (request) => {
      if (request.body == null) {
        this.log.debug(
          '%s: request %d: %s %s', this.name, request.id,
          request.method, request.resource
        )
      } else {
        this.log.debug(
          '%s: request %d: %s %s %s', this.name, request.id,
          request.method, request.resource, request.body
        )
      }
    })
    .on('response', (response) => {
      this.log.debug(
        '%s: request %d: %d %s', this.name, response.request.id,
        response.statusCode, response.statusMessage
      )
    })

  this.infoService = new Service.AccessoryInformation()
  this.serviceList.push(this.infoService)
  this.infoService
    .updateCharacteristic(Characteristic.Manufacturer, this.manufacturer)
    .updateCharacteristic(Characteristic.Model, this.model)
    .updateCharacteristic(Characteristic.SerialNumber, this.serialNumber)
    .updateCharacteristic(Characteristic.FirmwareRevision, this.version)

  this.service = new my.Services.HueBridge(this.name)
  this.serviceList.push(this.service)
  this.service.getCharacteristic(my.Characteristics.Heartrate)
    .updateValue(this.state.heartrate)
    .on('set', this.setHeartrate.bind(this))
  this.service.getCharacteristic(my.Characteristics.LastUpdated)
    .updateValue(String(new Date()).substring(0, 24))
  this.service.getCharacteristic(my.Characteristics.TransitionTime)
    .updateValue(this.state.transitiontime)
    .on('set', this.setTransitionTime.bind(this))
  // Added by me: Arye Levin
  this.service.addOptionalCharacteristic(Characteristic.Brightness)
  this.service.getCharacteristic(Characteristic.Brightness)
    .updateValue(100)
    .setProps({ minValue: 10 })
    .on('set', this.setBrightness.bind(this))
  // End of Added by me: Arye Levin
  if (this.isHue || this.isDeconz) {
    this.service.getCharacteristic(my.Characteristics.Restart)
      .updateValue(false)
      .on('set', this.setRestart.bind(this))
  }
  if (this.config.linkButton) {
    this.switchService = new Service.StatelessProgrammableSwitch(this.name)
    this.serviceList.push(this.switchService)
    this.switchService
      .getCharacteristic(Characteristic.ProgrammableSwitchEvent)
      .setProps({
        minValue: Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS,
        maxValue: Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS
      })
    if (this.config.link) {
      this.state.linkbutton = false
      this.state.hkLink = false
      this.service.getCharacteristic(my.Characteristics.Link)
        .updateValue(this.state.hkLink)
        .on('set', this.setLink.bind(this))
    }
  }
  this.accessoryList.push(this)

  // Added by me: Arye Levin
  try {
    if (!fs.existsSync(savedStateFilesPath)) {
      this.log('States folder is missing, going to create...')
      fs.mkdirSync(savedStateFilesPath)
    }
    let data = fs.readFileSync(savedStateFilesPath + "last_bridge_state", 'utf8')
    let parsedData = JSON.parse(data)
    this.state.remotesOn = parsedData['remotesOn']
    this.state.bri = parsedData['bri']
    if (this.state.bri) {
      this.service.getCharacteristic(Characteristic.Brightness).updateValue(this.state.bri * 100)
      this.platform.config.brightnessAdjustment = this.state.bri
    } else if (this.platform.config.brightnessAdjustment) {
      this.service.getCharacteristic(Characteristic.Brightness).setValue(this.platform.config.brightnessAdjustment * 100)
    }
    this.log("The bridge state file was loaded!")
  } catch (err) {
    // Here you get the error when the file was not found,
    // but you also get any other error
    if (err.code === 'ENOENT') {
      this.log('File not found!')
      // Check if there is a config for the brightness settings which configure the adaptive lighting factor.
      if (this.platform.config.brightnessAdjustment) {
        this.service.getCharacteristic(Characteristic.Brightness).setValue(this.platform.config.brightnessAdjustment * 100)
      }
    } else {
      this.log(err)
      // throw err
    }
    this.state.remotesOn = true
  }

  this.remotesAndServerEnabledStateService = new Service.Switch('Hue Control Enabled');
  this.remotesAndServerEnabledStateService.getCharacteristic(Characteristic.On)
                            .setValue(this.state.remotesOn)
                            // .on('get', this.getEnabledState.bind(this))
                            .on('set', this.setEnabledState.bind(this));
  this.serviceList.push(this.remotesAndServerEnabledStateService)
  // End of Added by me: Arye Levin
}

// Added by me: Arye Levin
// HueBridge.prototype.getEnabledState = function(callback) {
//   callback(this.state.remotesOn === true);
// }
// 
HueBridge.prototype.setEnabledState = function(on, callback) {
  this.log("Setting switch to " + on)
  this.state.remotesOn = on

  this.writeStateFile()

  callback()
}

HueBridge.prototype.writeStateFile = function() {
  let that = this
  fs.writeFile(savedStateFilesPath + "last_bridge_state", JSON.stringify(this.state), 'utf8', function(err) {
    if (err) {
      that.log.info(err)
    } else {
      that.log.info("The bridge state file was saved!")
    }
  })
}

HueBridge.prototype.setAqaraS1PanelsConfiguration = function() {
  // Now, go and set online/offline for all possible devices to know if they're set on the panel, and add/remove them on the reponse.
  if (this.actionsConfigData && Array.isArray(this.actionsConfigData) === false) {
    let aqaraS1Panels = this.actionsConfigData.aqara_S1_panels
    if (aqaraS1Panels) {
      let devicesSerial = ['6c69676874732f01', '6c69676874732f02', '6c69676874732f03', '6c69676874732f04', '6c69676874732f05', '6375727461696e01', '6375727461696e02', '6375727461696e03', '6169725f636f6e64'] // array of devices serial which is configured when setup is done
      let devicesControl = ['light_1', 'light_2' , 'light_3', 'light_4', 'light_5', 'curtain_1', 'curtain_2', 'curtain_3', 'ac'] // array of config names
      // | Temp Sensor | AC Page | Curtain 1 | Curtain 2 | Curtain 3 | Light 1 | Light 2 | Light 3 | Light 4 | Light 5 |
      // | ----------- | ------- | --------- | --------- | --------- | ------- | ------- | ------- | ------- | ------- |
      // | 01-02       | 03-08   | 09-0c     | 0f-12     | 15-18     | 1b-20   | 21-26   | 27-2c   | 2d-32   | 33-38   |
      let slotsRanges = {
        temperature_sensor: [0x01, 0x02],
        ac: [0x03, 0x04, 0x05, 0x06, 0x07, 0x08],
        curtain_1: [0x09, 0x0a, 0x0b, 0x0c],
        curtain_2: [0x0f, 0x10, 0x11, 0x12],
        curtain_3: [0x15, 0x16, 0x17, 0x18],
        light_1: [0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20],
        light_2: [0x21, 0x22, 0x23, 0x24, 0x25, 0x26],
        light_3: [0x27, 0x28, 0x29, 0x2a, 0x2b, 0x2c],
        light_4: [0x2d, 0x2e, 0x2f, 0x30, 0x31, 0x32],
        light_5: [0x33, 0x34, 0x35, 0x36, 0x37, 0x38]
      }
      var commandsAmount = 0

      let panels = Object.keys(aqaraS1Panels)
      for (const panel of panels) {
        let panelData = aqaraS1Panels[panel]
        let panelUniqueId = this.fullState.lights[panel.split('/')[2]].uniqueid
        if (panelUniqueId.split('-')[1] === '01') {
          let panelSerial = panelUniqueId.split('-')[0].replace(/:/g, '')
          for (var i = devicesSerial.length - 1; i >= 0; i--) {
            let deviceSerial = devicesSerial[i]
            console.log(deviceSerial)
            let deviceName = devicesControl[i]

            if (panelData[deviceName]) {
              console.log(deviceName)
              let deviceConfig = panelData[deviceName]
              console.log(deviceConfig)
              if (slotsRanges[deviceName]) {
                // TODO: Later compose the command in a more flexible way so all the sizes and integrity will be calculated here and not hardcoded.
                // TODO: Check that the config haven't changed in a new config (Need to check how this is possible to be done... Maybe try to set CT/Color and see what is the response...)
                if (i <= 4) { // Lights
                  // On/Off, general type...
                  let cmd1 = '40aa7138468c0201d8024140604f7448' + slotsRanges[deviceName][0].toString(16).padStart(2, '0') + panelSerial + deviceSerial + '040100550a0' + (deviceConfig.type === 'dim' ? '4' : '5') + '08bfaab9d8d7b4ccac08bfaab9d8d7b4ccac08bfaab9d8d7b4'
                  let cmd2 = '13aa710b468c020204ccac0000000000015' + (parseInt(deviceSerial.charAt(deviceSerial.length-1)) - 1) + '3' + (deviceConfig.type === 'color' ? '2' : '3') + '00'
                  // Brightness
                  let cmd3 = '3aaa7134448de0024131604f7448' + slotsRanges[deviceName][1].toString(16).padStart(2, '0') + panelSerial + deviceSerial + '0e010055170a0' + (deviceConfig.type === 'dim' ? '4' : '5') + '0ac1c1b6c8b0d9b7d6b1c8000000000000015' + (parseInt(deviceSerial.charAt(deviceSerial.length-1)) - 1) + '0' + (deviceConfig.type === 'color' ? '2' : '4') + '00'
                  // Name
                  let cmd4 = '37aa7131448ee202412e604f7448' + slotsRanges[deviceName][4].toString(16).padStart(2, '0') + panelSerial + deviceSerial + '08001fa5140a0' + (deviceConfig.type === 'dim' ? '4' : '5') + '08c9e8b1b8c3fbb3c60000000000015' + (parseInt(deviceSerial.charAt(deviceSerial.length-1)) - 1) + '0' + (deviceConfig.type === 'color' ? 'a' : 'b') + '00'
                  // Online/Offline
                  let cmd5 = '39aa7133448fdf024130604f7448' + slotsRanges[deviceName][5].toString(16).padStart(2, '0') + panelSerial + deviceSerial + '080007fd160a0' + (deviceConfig.type === 'dim' ? '4' : '5') + '0ac9e8b1b8d4dacfdfc0eb0000000000015' + (parseInt(deviceSerial.charAt(deviceSerial.length-1)) - 1) + '3' + (deviceConfig.type === 'color' ? 'c' : 'd') + '00'
                  let commandsToExecute = [cmd1, cmd2, cmd3, cmd4, cmd5]
                  if (deviceConfig.type === 'ct') {
                    // Color Temperature
                    let cmd6 = '36aa713044670a02412d604f7448' + slotsRanges[deviceName][2].toString(16).padStart(2, '0') + panelSerial + deviceSerial + '0e020055130a0506c9abcec2d6b5000000000000015' + (parseInt(deviceSerial.charAt(deviceSerial.length-1)) - 1) + '0300'
                    commandsToExecute.push(cmd6)
                  } else if (deviceConfig.type === 'color') {
                    // Color
                    let cmd6 = '36aa713044234a02412d604f7448' + slotsRanges[deviceName][3].toString(16).padStart(2, '0') + panelSerial + deviceSerial + '0e080055130a0506d1d5c9ab7879000000000000015' + (parseInt(deviceSerial.charAt(deviceSerial.length-1)) - 1) + '0100'
                    commandsToExecute.push(cmd6)
                  }
                  for (var ii = commandsToExecute.length - 1; ii >= 0; ii--) {
                    // separate commands with 500ms delay...
                    let that = this
                    let cmdToSend = commandsToExecute[ii]
                    setTimeout(function() {
                      console.log('going to send: ' + cmdToSend)
                      that.put(panel + '/state', {aqara_s1_panel_communication: cmdToSend}).then((obj) => {
      
                      }).catch((error) => {
                        
                      })
                    }, 500 * (commandsAmount++))
                  }
                } else if (i <= 7) { // curtains

                } else if (i == 8) { // AC
                  // On/Off, general type...
                  let cmd1 = '3aaa713444ef7e0241316044f76a' + slotsRanges[deviceName][0].toString(16).padStart(2, '0') + panelSerial + deviceSerial + (deviceConfig.internal_thermostat ? '0e020055' : '0e200055') + (deviceConfig.internal_thermostat ? '150a0608bfd8d6c6d7b4ccac000000000000012e0000' : '1708060abfd5b5f7d1b9cbf5d7b4000000000000012e0000')
                  // Online/Offline
                  let cmd2 = '39aa713344f07e0241306044f76a' + slotsRanges[deviceName][1].toString(16).padStart(2, '0') + panelSerial + deviceSerial + '080007fd' + '1608060ac9e8b1b8d4dacfdfc0eb0000000000012e6400'
                  // Name
                  let cmd3 = '37aa713144f17f02412e6044f76a' + slotsRanges[deviceName][2].toString(16).padStart(2, '0') + panelSerial + deviceSerial + '08001fa5' + '14080608c9e8b1b8c3fbb3c60000000000012e1300'
                  // Modes
                  let cmd4 = '39aa713344f27c0241306044f76a' + slotsRanges[deviceName][3].toString(16).padStart(2, '0') + panelSerial + deviceSerial + '08001fa7' + '1608060ab5b1c7b0c6a5c5e4b5c40000000000012e1000'
                  // Fan Modes
                  let cmd5 = '39aa713344f37b0241306044f76a' + slotsRanges[deviceName][4].toString(16).padStart(2, '0') + panelSerial + deviceSerial + '08001fa8' + '1608060ab5b1c7b0c6a5c5e4b5c40000000000012e1100'
                  // Temperatures Ranges
                  let cmd6 = '39aa713344f47a0241306044f76a' + slotsRanges[deviceName][5].toString(16).padStart(2, '0') + panelSerial + deviceSerial + '08001fa9' + '1608060ab5b1c7b0c6a5c5e4b5c40000000000012e0100'
                  let commandsToExecute = [cmd1, cmd2, cmd3, cmd4, cmd5, cmd6]
                  for (var ii = commandsToExecute.length - 1; ii >= 0; ii--) {
                    // separate commands with 500ms delay...
                    let that = this
                    let cmdToSend = commandsToExecute[ii]
                    setTimeout(function() {
                      console.log('going to send: ' + cmdToSend)
                      that.put(panel + '/state', {aqara_s1_panel_communication: cmdToSend}).then((obj) => {
      
                      }).catch((error) => {
                        
                      })
                    }, 500 * (commandsAmount++))
                  }
                }
              }
            }



            // // TODO: now set all as Online, but later make sure to mark offline devices if they're offline...
            // // separate commands with 500ms delay...
            // let that = this
            // commandsAmount ++
            // setTimeout(function() {
            //   let cmdToSend = '19aa7113446d21054110' + deviceSerial + '080007fd' + '0000000' + (panelData[devicesControl[i]] ? '1' : '0')
            //   console.log(cmdToSend)
            //   that.put(panel + '/state', {aqara_s1_panel_communication: cmdToSend}).then((obj) => {
                
            //   }).catch((error) => {
                
            //   })
            // }, 500 * commandsAmount)
          }
        }
      }
    }
  }
}
// End of Added by me: Arye Levin

HueBridge.prototype.createUser = async function () {
  if (this.username) {
    return
  }
  try {
    this.username = await this.hueClient.createuser('homebridge-hue')
    let s = '\n'
    s += '  "platforms": [\n'
    s += '    {\n'
    s += '      "platform": "Hue",\n'
    s += '      "users": {\n'
    s += '        "' + this.serialNumber + '": "' + this.username + '"\n'
    s += '      }\n'
    s += '    }\n'
    s += '  ]'
    this.log.info(
      '%s: created user - please edit config.json and restart homebridge%s',
      this.name, s
    )
    return
  } catch (error) {
    if (error.request != null) {
      if (error.type === 101) {
        const s = this.isDeconz
          ? 'unlock gateway'
          : 'press link button on the bridge'
        this.log.info('%s: %s to create a user - retrying in 15s', this.name, s)
      }
    } else {
      this.log.error('%s: %s', this.name, formatError(error))
    }
    await homebridgeLib.timeout(15000)
    return this.createUser()
  }
}

HueBridge.prototype.getFullState = async function () {
  const state = await this.get('/')
  if (state == null || state.groups == null) {
    throw new Error('cannot get full state')
  }
  try {
    const group0 = await this.get('/groups/0')
    state.groups[0] = group0
  } catch (error) {
    this.log.warn('%s: warning: /groups/0 blacklisted', this.name)
    this.blacklist.groups[0] = true
  }
  if (state.resourcelinks == null) {
    const resourcelinks = await this.get('/resourcelinks')
    state.resourcelinks = resourcelinks
  }
  this.fullState = state
  return state
}

HueBridge.prototype.exposeResources = async function (obj) {
  this.obj = obj.config
  for (const key in obj.resourcelinks) {
    const link = obj.resourcelinks[key]
    if (link.name === 'homebridge-hue' && link.links && link.description) {
      const list = link.description.toLowerCase()
      switch (list) {
        case 'blacklist':
        case 'lightlist':
        case 'multiclip':
        case 'multilight':
        case 'outlet':
        case 'splitlight':
        case 'switch':
        case 'valve':
        case 'wallswitch':
        case 'whitelist':
          break
        default:
          this.log.warn(
            '%s: /resourcelinks/%d: ignoring unknown description %s',
            this.name, key, link.description
          )
          continue
      }
      this.log.debug(
        '%s: /resourcelinks/%d: %d %s entries', this.name, key,
        link.links.length, list
      )
      let accessory
      for (const resource of link.links) {
        const type = resource.split('/')[1]
        const id = resource.split('/')[2]
        if (!this.whitelist[type]) {
          this.log.warn(
            '%s: /resourcelinks/%d: %s: ignoring unsupported resource',
            this.name, key, resource
          )
          continue
        }
        if (list === 'blacklist') {
          this.blacklist[type][id] = true
          continue
        }
        if (obj[type][id] === undefined) {
          this.log(
            '%s: /resourcelinks/%d: %s: not available', this.name, key,
            resource
          )
          this.log.info(
            '%s: gateway not yet initialised - wait 1 minute', this.name
          )
          await homebridgeLib.timeout(60000)
          try {
            const state = await this.getFullState()
            return this.exposeResources(state)
          } catch (error) {
            return this.exposeResources(obj)
          }
        }
        if (list === 'multiclip') {
          if (
            type !== 'sensors' || (
              obj[type][id].type.substring(0, 4) !== 'CLIP' &&
              obj[type][id].type !== 'Daylight'
            )
          ) {
            this.log.warn(
              '%s: /resourcelinks/%d: %s: ignoring unsupported multiclip resource',
              this.name, key, resource
            )
            continue
          }
          if (this.multiclip[id] != null) {
            this.log.warn(
              '%s: /resourcelinks/%d: %s: ignoring duplicate multiclip resource',
              this.name, key, resource
            )
            continue
          }
          this.multiclip[id] = key
          if (accessory == null) {
            // First resource
            const serialNumber = this.serialNumber + '-' + id
            accessory = new HueAccessory(this, serialNumber, true)
            this.accessoryMap[serialNumber] = accessory
          }
          accessory.addSensorResource(id, obj[type][id], false)
        } else if (list === 'multilight') {
          if (type !== 'lights') {
            this.log.warn(
              '%s: /resourcelinks/%d: %s: ignoring unsupported multilight resource',
              this.name, key, resource
            )
            continue
          }
          if (this.multilight[id] != null) {
            this.log.warn(
              '%s: /resourcelinks/%d: %s: ignoring duplicate multilight resource',
              this.name, key, resource
            )
            continue
          }
          this.multilight[id] = key
          if (accessory == null) {
            // First resource
            const a = obj[type][id].uniqueid
              .match(/(..:..:..:..:..:..:..:..)-..(:?-....)?/)
            const serialNumber = a[1].replace(/:/g, '').toUpperCase()
            accessory = new HueAccessory(this, serialNumber, true)
            this.accessoryMap[serialNumber] = accessory
          }
          accessory.addLightResource(id, obj[type][id])
        } else if (list === 'outlet') {
          if (type !== 'groups' && type !== 'lights') {
            this.log.warn(
              '%s: /resourcelinks/%d: %s: ignoring unsupported outlet resource',
              this.name, key, resource
            )
            continue
          }
          this.outlet[type][id] = true
        } else if (list === 'splitlight') {
          if (type !== 'lights') {
            this.log.warn(
              '%s: /resourcelinks/%d: %s: ignoring unsupported splitlight resource',
              this.name, key, resource
            )
            continue
          }
          this.splitlight[id] = true
        } else if (list === 'switch') {
          if (type !== 'groups' && type !== 'lights') {
            this.log.warn(
              '%s: /resourcelinks/%d: %s: ignoring unsupported switch resource',
              this.name, key, resource
            )
            continue
          }
          this.switch[type][id] = true
        } else if (list === 'valve') {
          if (type !== 'lights') {
            this.log.warn(
              '%s: /resourcelinks/%d: %s: ignoring unsupported valve resource',
              this.name, key, resource
            )
            continue
          }
          this.valve[id] = true
        } else if (list === 'wallswitch') {
          if (type !== 'lights') {
            this.log.warn(
              '%s: /resourcelinks/%d: %s: ignoring unsupported wallswitch resource',
              this.name, key, resource
            )
            continue
          }
          this.wallswitch[id] = true
        } else if (list === 'whitelist') {
          this.whitelist[type][id] = true
        }
      }
    }
  }
  this.log.debug(
    '%s: %s: %s %s %s "%s"', this.name, this.serialNumber,
    this.manufacturer, this.model, this.type, this.name
  )
  if (this.isHue && this.platform.config.scenes) {
    for (const id in obj.groups) {
      obj.groups[id].scenes = []
    }
    for (const key in obj.scenes) {
      const scene = obj.scenes[key]
      const id = scene.group == null ? 0 : scene.group
      this.log.debug('%s: /scenes/%s: group: %d', this.name, key, id)
      obj.groups[id].scenes.push({ id: key, name: scene.name })
    }
  }
  this.exposeGroups(obj.groups)
  this.exposeLights(obj.lights)
  this.exposeSensors(obj.sensors)
  this.exposeSchedules(obj.schedules)
  this.exposeRules(obj.rules)
  for (const id in this.accessoryMap) {
    const accessoryList = this.accessoryMap[id].expose()
    for (const accessory of accessoryList) {
      this.accessoryList.push(accessory)
    }
  }
  this.state.sensors = Object.keys(this.sensors).length
  this.log.debug('%s: %d sensors', this.name, this.state.sensors)
  this.state.lights = Object.keys(this.lights).length
  this.log.debug('%s: %d lights', this.name, this.state.lights)
  this.state.groups = Object.keys(this.groups).length
  this.state.group0 = this.groups[0] !== undefined ? 1 : 0
  this.state.schedules = Object.keys(this.schedules).length
  this.log.debug('%s: %d schedules', this.name, this.state.schedules)
  this.state.rules = Object.keys(this.rules).length
  this.log.debug('%s: %d rules', this.name, this.state.rules)
  this.log.debug('%s: %d groups', this.name, this.state.groups)
  if (this.obj.websocketport) {
    this.listen()
  }

  // Added by me: Arye Levin
  this.setAqaraS1PanelsConfiguration()
  // End of Added by me: Arye Levin
}

HueBridge.prototype.exposeSensors = function (sensors) {
  for (const id in sensors) {
    const sensor = sensors[id]
    if (this.whitelist.sensors[id]) {
      this.exposeSensor(id, sensor)
    } else if (this.platform.config.sensors) {
      if (this.blacklist.sensors[id]) {
        this.log.debug('%s: /sensors/%d: blacklisted', this.name, id)
      } else if (this.multiclip[id] != null) {
        // already exposed
      } else if (
        this.config.nativeHomeKitSensors && sensor.type[0] === 'Z' && (
          sensor.manufacturername === this.philips ||
          sensor.manufacturername === 'PhilipsFoH'
        )
      ) {
        this.log.debug('%s: /sensors/%d: exposed by bridge', this.name, id)
      } else if (
        this.platform.config.excludeSensorTypes[sensor.type] || (
          sensor.type.substring(0, 4) === 'CLIP' &&
          this.platform.config.excludeSensorTypes.CLIP
        )
      ) {
        this.log.debug(
          '%s: /sensors/%d: %s excluded', this.name, id, sensor.type
        )
      } else if (
        sensor.name === '_dummy' || sensor.uniqueid === '_dummy'
      ) {
        this.log.debug(
          '%s: /sensors/%d: ignoring dummy sensor', this.name, id
        )
      } else {
        this.exposeSensor(id, sensor)
      }
    }
  }
}

HueBridge.prototype.exposeSensor = function (id, obj) {
  obj.manufacturername = obj.manufacturername.replace(/\//g, '')
  let serialNumber = this.serialNumber + '-' + id
  if (obj.type[0] === 'Z') {
    const uniqueid = obj.uniqueid == null ? '' : obj.uniqueid
    const a = uniqueid.match(/(..:..:..:..:..:..:..:..)-..(:?-....)?/)
    if (a != null) {
      // ZigBee sensor
      serialNumber = a[1].replace(/:/g, '').toUpperCase()
      if (this.platform.config.hueMotionTemperatureHistory) {
        // Separate accessory for Hue motion sensor's temperature.
        if (
          obj.manufacturername === this.philips &&
          (obj.modelid === 'SML001' || obj.modelid === 'SML002')
        ) {
          // Hue motion sensor.
          if (obj.type === 'ZHATemperature' || obj.type === 'ZLLTemperature') {
            serialNumber += '-T'
          }
        } else if (
          obj.manufacturername === 'Samjin' && obj.modelid === 'multi'
        ) {
          // Samsung SmartThings multupurpose sensor.
          if (obj.type === 'ZHATemperature') {
            serialNumber += '-T'
          } else if (obj.type === 'ZHAVibration') {
            serialNumber += '-V'
          }
        }
      }
      if (
        obj.manufacturername === 'Develco Products AS' &&
        (obj.modelid === 'SMSZB-120' || obj.modelid === 'HESZB-120')
      ) {
        // Develco smoke sensor.
        if (obj.type === 'ZHATemperature') {
          serialNumber += '-T'
        }
      } else if (
        obj.manufacturername === 'Samjin' && obj.modelid === 'button'
      ) {
        // Re-expose button tile in Home on iOS 14.
        if (obj.type === 'ZHATemperature') {
          serialNumber += '-T'
        }
      }
    }
  }
  if (
    obj.manufacturername === 'homebridge-hue' &&
    obj.modelid === obj.type &&
    obj.uniqueid.split('-')[1] === id
  ) {
    // Combine multiple CLIP sensors into one accessory.
    this.log.warn(
      '%s: /sensors/%d: error: old multiCLIP setup has been deprecated',
      this.name, id
    )
  }
  let accessory = this.accessoryMap[serialNumber]
  if (accessory == null) {
    accessory = new HueAccessory(this, serialNumber)
    this.accessoryMap[serialNumber] = accessory
  }
  accessory.addSensorResource(id, obj)
}

HueBridge.prototype.exposeLights = function (lights) {
  for (const id in lights) {
    const light = lights[id]
    if (this.whitelist.lights[id]) {
      this.exposeLight(id, light)
    } else if (this.platform.config.lights) {
      if (this.blacklist.lights[id]) {
        this.log.debug('%s: /lights/%d: blacklisted', this.name, id)
      } else if (this.multilight[id]) {
        // Already exposed.
      } else if (
        this.config.nativeHomeKitLights && (
          (light.capabilities != null && light.capabilities.certified) ||
          (light.capabilities == null && light.manufacturername === this.philips)
        )
      ) {
        this.log.debug('%s: /lights/%d: exposed by bridge %j', this.name, id, light)
      } else if (
        repeaterTypes.includes(light.type) ||
        (light.type === 'Unknown' && light.manufacturername === 'dresden elektronik')
      ) {
        this.log.debug('%s: /lights/%d: ignore repeater %j', this.name, id, light)
      } else {
        this.exposeLight(id, light)
      }
    }
  }
}

HueBridge.prototype.exposeLight = function (id, obj) {
  if (obj.manufacturername != null) {
    obj.manufacturername = obj.manufacturername.replace(/\//g, '')
  }
  let serialNumber = this.serialNumber + '-L' + id
  const uniqueid = obj.uniqueid == null ? '' : obj.uniqueid
  const a = uniqueid.match(/(..:..:..:..:..:..:..:..)-(..)(:?-....)?/)
  if (a != null && this.model !== 'HA-Bridge') {
    serialNumber = a[1].replace(/:/g, '').toUpperCase()
    if (this.splitlight[id]) {
      serialNumber += '-' + a[2].toUpperCase()
    }
  }
  let accessory = this.accessoryMap[serialNumber]
  if (accessory == null) {
    accessory = new HueAccessory(this, serialNumber)
    this.accessoryMap[serialNumber] = accessory
  }
  accessory.addLightResource(id, obj)
}

HueBridge.prototype.exposeGroups = function (groups) {
  for (const id in groups) {
    const group = groups[id]
    if (this.whitelist.groups[id]) {
      this.exposeGroup(id, group)
    } else if (this.platform.config.groups) {
      if (this.blacklist.groups[id]) {
        this.log.debug('%s: /groups/%d: blacklisted', this.name, id)
      } else if (group.type === 'Room' && !this.platform.config.rooms) {
        this.log.debug(
          '%s: /groups/%d: %s excluded', this.name, id, group.type
        )
      } else if (id === '0' && !this.platform.config.group0) {
        this.log.debug('%s: /groups/%d: group 0 excluded', this.name, id)
      } else {
        this.exposeGroup(id, group)
      }
    }
  }
}

HueBridge.prototype.exposeGroup = function (id, obj) {
  const serialNumber = this.serialNumber + '-G' + id
  let accessory = this.accessoryMap[serialNumber]
  if (accessory == null) {
    accessory = new HueAccessory(this, serialNumber)
    this.accessoryMap[serialNumber] = accessory
  }
  accessory.addGroupResource(id, obj)
}

HueBridge.prototype.exposeSchedules = function (schedules) {
  for (const id in schedules) {
    if (this.whitelist.schedules[id]) {
      this.exposeSchedule(id, schedules[id])
    } else if (this.platform.config.schedules) {
      if (this.blacklist.schedules[id]) {
        this.log.debug('%s: /schedules/%d: blacklisted', this.name, id)
      } else {
        this.exposeSchedule(id, schedules[id])
      }
    }
  }
}

HueBridge.prototype.exposeSchedule = function (id, obj) {
  this.log.debug(
    '%s: /schedules/%d: "%s"', this.name, id, obj.name
  )
  try {
    this.schedules[id] = new HueSchedule(this, id, obj)
    // this.accessoryList.push(this.schedules[id]);
    if (this.serviceList.length < 99) {
      this.serviceList.push(this.schedules[id].service)
    }
  } catch (e) {
    this.log.error(
      '%s: error: /schedules/%d: %j\n%s', this.name, id, obj, formatError(e)
    )
  }
}

HueBridge.prototype.exposeRules = function (rules) {
  for (const id in rules) {
    if (this.whitelist.rules[id]) {
      this.log.debug('%s: /rules/%d: whitelisted', this.name, id)
    } else if (this.platform.config.rules) {
      if (this.blacklist.rules[id]) {
        this.log.debug('%s: /rules/%d: blacklisted', this.name, id)
      } else {
        this.exposeRule(id, rules[id])
      }
    }
  }
}

HueBridge.prototype.exposeRule = function (id, obj) {
  this.log.debug('%s: /rules/%d: "%s"', this.name, id, obj.name)
  try {
    this.rules[id] = new HueSchedule(this, id, obj, 'rule')
    // this.accessoryList.push(this.rules[id]);
    if (this.serviceList.length < 99) {
      this.serviceList.push(this.rules[id].service)
    }
  } catch (e) {
    this.log.error(
      '%s: error: /rules/%d: %j\n%s', this.name, id, obj, formatError(e)
    )
  }
}

HueBridge.prototype.resetTransitionTime = function () {
  if (this.state.resetTimer) {
    return
  }
  this.state.resetTimer = setTimeout(() => {
    this.log.info(
      '%s: reset homekit transition time from %ss to %ss', this.name,
      this.state.transitiontime, this.defaultTransitiontime
    )
    this.state.transitiontime = this.defaultTransitiontime
    this.service.getCharacteristic(my.Characteristics.TransitionTime)
      .updateValue(this.state.transitiontime)
    delete this.state.resetTimer
  }, this.platform.config.waitTimeUpdate)
}

// ===== WebSocket =============================================================

HueBridge.prototype.listen = function () {
  const host = this.hostname + ':' + this.obj.websocketport
  const ws = new WsMonitor({ host: host, retryTime: 15 })
  ws
    .on('error', (error) => {
      this.log.warn(
        '%s: websocket communication error: %s', this.name, formatError(error)
      )
    })
    .on('listening', (url) => {
      this.log.debug('%s: websocket connected to %s', this.name, url)
    })
    .on('changed', (resource, obj) => {
      try {
        const r = resource.split('/')
        const a = this[r[1]][r[2]]

        // Added by me: Arye Levin
        // if (r[1] === 'lights' && (r[2] === '14' || r[2] === '34')) {
          // console.log(JSON.stringify(obj))
        // }
        if (r[1] === 'sensors' && obj !== undefined && obj.buttonevent !== undefined && this.actionsConfigData && this.actionsConfigData[r[2]] && this.actionsConfigData[r[2]].length && this.state.remotesOn) {
          var actionsConfig = this.actionsConfigData[r[2]];
          var sensorTypeInt = actionsConfig[0];
          this.log.info('sensor: %s, event data: %s, config: %s', r[2], JSON.stringify(obj), JSON.stringify(actionsConfig));
          // Set the defaults...
          // if (!a.lastActions) {
          //   a.lastActions = {
          //     1002: 0,
          //     2002: 0,
          //     3002: 0,
          //     4002: 0,
          //     5002: 0,
          //     2001: 0,
          //     3001: 0
          //   };
          //   a.lastTimeoutID = undefined;
          // }

          for (var i = actionsConfig.length - 1; i >= 1; i--) {
            // First cancel any timeouts we've created for the long press handling...
            var keyForTimeoutAction = r[2] + i;
            clearTimeout(longPressTimeoutIDs[keyForTimeoutAction]);
            
            var actionConfig = actionsConfig[i];

            if (obj.buttonevent === 2001 || obj.buttonevent === 3001 || obj.buttonevent === 4001 || obj.buttonevent === 5001) {
              if (actionConfig.resourcePath && actionConfig.resourcePath.startsWith("/")) {
                var pathComponents = actionConfig.resourcePath.split( '/' );
                let accessoryToControl = this[pathComponents[1]][pathComponents[2]]
                if (accessoryToControl) {
                  var repeatZBFunction = function(delay, timeoutKey) {
                    longPressTimeoutIDs[timeoutKey] = setTimeout(function() {
                      console.log('Long press being on ZigBee service!!!');
                      var continueRepeat = true;
                      if (sensorTypeInt == 1) {
                        continueRepeat = false;
                      }
                      var service = accessoryToControl.service;
                      if (obj.buttonevent === 2001 && service.testCharacteristic(Characteristic.Brightness)) {
                        if (!service.getCharacteristic(Characteristic.On).value) {
                          service.getCharacteristic(Characteristic.Brightness).setValue(1);
                          service.getCharacteristic(Characteristic.On).setValue(true);
                        } else {
                          var characteristic = service.getCharacteristic(Characteristic.Brightness);
                          var newBrightnessState = Math.min(100, characteristic.value + 5);
                          characteristic.setValue(newBrightnessState);
                          if (newBrightnessState === 100) {
                            continueRepeat = false;
                          }
                        }
                      } else if (obj.buttonevent === 3001 && service.testCharacteristic(Characteristic.Brightness)) {
                        var characteristic = service.getCharacteristic(Characteristic.Brightness);
                        var newBrightnessState = Math.max(1, characteristic.value - 5);
                        characteristic.setValue(newBrightnessState);
                        if (newBrightnessState === 1) {
                          continueRepeat = false;
                        }
                      } else if (sensorTypeInt == 0 && obj.buttonevent === 4001 && service.testCharacteristic(accessoryToControl.colorTemperatureCharacteristic)) {
                        var characteristic = service.getCharacteristic(accessoryToControl.colorTemperatureCharacteristic);
                        var newColorTemperatureState = Math.max(153, characteristic.value - 32);
                        characteristic.setValue(newColorTemperatureState);
                        if (newColorTemperatureState === 153) { // TODO: take the min/max from the object itself...
                          continueRepeat = false;
                        }
                      } else if (sensorTypeInt == 0 && obj.buttonevent === 5001 && service.testCharacteristic(accessoryToControl.colorTemperatureCharacteristic)) {
                        var characteristic = service.getCharacteristic(accessoryToControl.colorTemperatureCharacteristic);
                        var newColorTemperatureState = Math.min(500, characteristic.value + 32);
                        characteristic.setValue(newColorTemperatureState);
                        if (newColorTemperatureState === 500) {
                          continueRepeat = false;
                        }
                      } else {
                        continueRepeat = false;
                      }
                      if (continueRepeat) {
                        repeatZBFunction(300, timeoutKey);
                      }
                    }, delay);
                  }
                  repeatZBFunction(0, keyForTimeoutAction);
                }
              } else {
                var actionToDo = actionConfig[obj.buttonevent];//[a.lastActions[obj.buttonevent]];
                if (/*this.state.remotesOn && */actionToDo) {
                  var jsonObject = JSON.parse(JSON.stringify(actionConfig.json));
                  jsonObject.action = actionToDo;

                  const data = JSON.stringify(jsonObject)
                  
                  const options = {
                    hostname: actionConfig.host,
                    port: actionConfig.port,
                    path: actionConfig.path,
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      'Content-Length': data.length
                    }
                  }

                  var repeatFunction = function(delay, timeoutKey) {
                    longPressTimeoutIDs[timeoutKey] = setTimeout(function() {
                      console.log('Long press being on URL!!!');

                      const req = http.request(options, res => {
                        console.log(`statusCode: ${res.statusCode}`)
                      
                        if (res.statusCode == 200) {
                          console.log('Command sent and received successfully')
                        }

                        res.on('data', d => {
                          // process.stdout.write(d)
                          console.log(d)
                        })
                      })
                      
                      req.on('error', error => {
                        console.error(error)
                      })
                      
                      req.write(data)
                      req.end()
                      
                      repeatFunction(300, timeoutKey);
                    }, delay);
                  }
                  repeatFunction(0, keyForTimeoutAction);
                }
              }
            } else if (obj.buttonevent === 1000 || obj.buttonevent === 1001 || obj.buttonevent === 1002 || obj.buttonevent === 2000 || obj.buttonevent === 2002 || obj.buttonevent === 3000 || obj.buttonevent === 3002 || obj.buttonevent === 4000 || obj.buttonevent === 4002 || obj.buttonevent === 5002) {
              if (actionConfig.resourcePath && actionConfig.resourcePath.startsWith("/")) {
                var pathComponents = actionConfig.resourcePath.split( '/' )
                let accessoryToControl = this[pathComponents[1]][pathComponents[2]]
                if (accessoryToControl) {
                  var service = accessoryToControl.service;
                  if (obj.buttonevent === 1001) {
                    service.getCharacteristic(Characteristic.On).setValue(true);
                    service.getCharacteristic(Characteristic.Brightness).setValue(100);
                    service.getCharacteristic(accessoryToControl.colorTemperatureCharacteristic).setValue(363); // TODO: use a config file to know the right default...
                  } else if (sensorTypeInt == 0 && obj.buttonevent === 1002) {
                    var characteristic = service.getCharacteristic(Characteristic.On);
                    var newPowerState = !characteristic.value;
                    characteristic.setValue(newPowerState > 0);
                    if (newPowerState && service.testCharacteristic(Characteristic.Brightness)) {
                        characteristic = service.getCharacteristic(Characteristic.Brightness);
                        if (characteristic.value !== 100) {
                            characteristic.setValue(100);
                        }
                    }
                  } else if (sensorTypeInt == 1 && obj.buttonevent === 1000) {
                    var characteristic = service.getCharacteristic(Characteristic.On);
                    var originalValue = characteristic.value;
                    characteristic.setValue(1);
                    if (originalValue && service.testCharacteristic(Characteristic.Brightness)) {
                      characteristic = service.getCharacteristic(Characteristic.Brightness);
                      if (characteristic.value !== 100) {
                        characteristic.setValue(100);
                      }
                    }
                  } else if (((sensorTypeInt == 0 && obj.buttonevent === 2002) || (sensorTypeInt == 1 && obj.buttonevent === 2000)) && service.testCharacteristic(Characteristic.Brightness)) {
                    if (!service.getCharacteristic(Characteristic.On).value) {
                      service.getCharacteristic(Characteristic.Brightness).setValue(1);
                      service.getCharacteristic(Characteristic.On).setValue(true);
                    } else {
                      var characteristic = service.getCharacteristic(Characteristic.Brightness);
                      var newBrightnessState = Math.min(100, characteristic.value + 5);
                      characteristic.setValue(newBrightnessState);
                    }
                  } else if (((sensorTypeInt == 0 && obj.buttonevent === 3002) || (sensorTypeInt == 1 && obj.buttonevent === 3000)) && service.testCharacteristic(Characteristic.Brightness)) {
                    var characteristic = service.getCharacteristic(Characteristic.Brightness);
                    var newBrightnessState = Math.max(1, characteristic.value - 5);
                    characteristic.setValue(newBrightnessState);
                  } else if (sensorTypeInt == 0 && obj.buttonevent === 4002 && service.testCharacteristic(accessoryToControl.colorTemperatureCharacteristic)) {
                    var characteristic = service.getCharacteristic(accessoryToControl.colorTemperatureCharacteristic);
                    var newColorTemperatureState = Math.max(153, characteristic.value - 32);
                    characteristic.setValue(newColorTemperatureState);
                  } else if (sensorTypeInt == 0 && obj.buttonevent === 5002 && service.testCharacteristic(accessoryToControl.colorTemperatureCharacteristic)) {
                    var characteristic = service.getCharacteristic(accessoryToControl.colorTemperatureCharacteristic);
                    var newColorTemperatureState = Math.min(500, characteristic.value + 32);
                    characteristic.setValue(newColorTemperatureState);
                  } else if (sensorTypeInt == 1 && obj.buttonevent === 4000) {
                    var characteristic = service.getCharacteristic(Characteristic.On);
                    characteristic.setValue(false);
                  }
                }
              } else {
                var actionToDo = actionConfig[obj.buttonevent];//[a.lastActions[obj.buttonevent]];
                if (/*this.state.remotesOn && */actionToDo) {
                  var jsonObject = JSON.parse(JSON.stringify(actionConfig.json)); // Object.assign({}, actionConfig.json);
                  // if (a.lastActions[obj.buttonevent] === actionConfig[obj.buttonevent].length - 1) {
                  //     a.lastActions[obj.buttonevent] = 0;
                  // } else {
                  //     a.lastActions[obj.buttonevent] ++;
                  // }
                  jsonObject.action = actionToDo;
                  
                  const data = JSON.stringify(jsonObject)
            
                  const options = {
                    hostname: actionConfig.host,
                    port: actionConfig.port,
                    path: actionConfig.path,
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      'Content-Length': data.length
                    }
                  }

                  const req = http.request(options, res => {
                    console.log(`statusCode: ${res.statusCode}`)
                  
                    if (res.statusCode == 200) {
                      console.log('Command sent and received successfully')
                    }

                    res.on('data', d => {
                      // process.stdout.write(d)
                      console.log(d)
                    })
                  })
                  
                  req.on('error', error => {
                    console.error(error)
                  })
                  
                  req.write(data)
                  req.end()
                }
              }
            } else if (obj.buttonevent === 2003 || obj.buttonevent === 3003 || obj.buttonevent === 4003 || obj.buttonevent === 5003) {
              // if (a.lastActions[obj.buttonevent - 2] === actionConfig[obj.buttonevent - 2].length - 1) {
              //     a.lastActions[obj.buttonevent - 2] = 0;
              // } else {
              //     a.lastActions[obj.buttonevent - 2] ++;
              // }
            }
          }
        } else if (r[1] === 'lights' && this.fullState.lights[r[2]].modelid === "lumi.switch.n4acn4") {
          if (obj !== undefined && obj['aqara_s1_panel_communication'] !== undefined && obj['aqara_s1_panel_communication'] !== this.fullState.lights[r[2]].state.aqara_s1_panel_communication) {
            let updateData = obj['aqara_s1_panel_communication']
            this.fullState.lights[r[2]].state.aqara_s1_panel_communication = updateData
            this.log.info(updateData)

            const fromHexString = hexString =>
              new Uint8Array(hexString.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));

            const toHexString = bytes =>
              bytes.reduce((str, byte) => str + byte.toString(16).padStart(2, '0'), '');
            
            let dataArray = fromHexString(updateData)
            if (dataArray[0] === 0xf2 && dataArray[1] === 0xff && dataArray[2] === 0x41) { // Only commands which the device sent will be proccessed, commands without this begining is just what we sent from here, thus not relevant. (the API push it to our socket automatically since it set to the device state object)
              this.log.info(dataArray)
              this.log.info('the value of integrity is: ' + dataArray[9])
  
              const getInt8 = uint8Data => 
                uint8Data << 24 >> 24;
  
              const getUInt8 = int8Data => 
                int8Data << 24 >>> 24;
              
              this.log.info('the signed value of integrity is: ' + getInt8(dataArray[9]))
  
              let sum = dataArray[4] + dataArray[5] + dataArray[6] + dataArray[7] + dataArray[8] + getInt8(dataArray[9])
  
              this.log.info('The sum is: ' + sum)
  
              if (sum === 512) {
                let commandCategory = dataArray[5] // (71 to device, 72 from device and 73 is for all scenes transactions [config and usage])
                let commandType = dataArray[7] // 84=Attribute report of states, 24=ACK for state commands, 44 commands for device (shouldn't happen here), 46=multi-part commands for device (also shouldn't happen here)
                let commandAction = dataArray[10] // 1=state report/scenes config, 2=configs, 3=scenes activation, 4=removals, 5=set state/states ACKs, 6=state request
                let paramsSize = dataArray[12]
                let deviceSerial = commandType === 0x24 ? [dataArray[14], dataArray[15], dataArray[16], dataArray[17], dataArray[18], dataArray[19], dataArray[20], dataArray[21]] : [dataArray[13], dataArray[14], dataArray[15], dataArray[16], dataArray[17], dataArray[18], dataArray[19], dataArray[20]]
                let stateParam = commandType === 0x24 ? [] : [dataArray[21], dataArray[22], dataArray[23], dataArray[24]]
    
                this.log.info('commandCategory: 0x' + commandCategory.toString(16) + ', commandType: 0x' + commandType.toString(16) + ', commandAction: 0x' + commandAction.toString(16) + ', paramsSize: 0x' + paramsSize.toString(16) + ', deviceSerial: ' + deviceSerial + ', stateParam: ' + stateParam)
  
                var deviceResourceType = undefined
                if (deviceSerial[0] === 0x6c && deviceSerial[1] === 0x69 && deviceSerial[2] === 0x67 && deviceSerial[3] === 0x68 && deviceSerial[4] === 0x74 && deviceSerial[5] === 0x73 && deviceSerial[6] === 0x2f) {
                  deviceResourceType = 'lights/'
                } else if (deviceSerial[0] === 0x63 && deviceSerial[1] === 0x75 && deviceSerial[2] === 0x72 && deviceSerial[3] === 0x74 && deviceSerial[4] === 0x61 && deviceSerial[5] === 0x69 && deviceSerial[6] === 0x6e) {
                  deviceResourceType = 'curtain'
                } else if (deviceSerial[0] === 0x61 && deviceSerial[1] === 0x69 && deviceSerial[2] === 0x72 && deviceSerial[3] === 0x5f && deviceSerial[4] === 0x63 && deviceSerial[5] === 0x6f && deviceSerial[6] === 0x6e && deviceSerial[7] === 0x64) {
                  deviceResourceType = 'air_cond'
                }

                if (deviceResourceType) {
                  if (commandCategory === 0x72 && commandType === 0x84 && commandAction === 0x01) { // State of device is reported.
                    if (deviceResourceType === 'air_cond' && stateParam[0] === 0x0e && stateParam[2] === 0x00 && stateParam[3] === 0x55 && (stateParam[1] === 0x20 || stateParam[1] === 0x02)) { // Updated Air conditioner/Heater-Cooler device state
                      this.log.info('This is a AC Control state')
                      let onOff = dataArray[25] >= 0x10
                      let mode = dataArray[25] - (onOff ? 0x10 : 0x0)
                      let fan = parseInt(dataArray[26].toString(16).padStart(2, '0').slice(0 , 1), 16)
                      let setTemperature = dataArray[27]
      
                      this.log.info('On/Off: ' + onOff + ', Mode: ' + mode + ', Fan: ' + fan + ', Set Temperature: ' + setTemperature)
                    } else if (deviceResourceType === 'lights/' && stateParam[0] === 0x04 && stateParam[1] === 0x01 && stateParam[2] === 0x00 && stateParam[3] === 0x55) { // Light On/Off
                      let onOff = dataArray[28] === 0x01
                      this.log.info('On/Off: ' + onOff)
                      
                      let resources = this.panelsToResources['/' + r[1] + '/' + r[2] + '/light_' + deviceSerial[7]]
                      for (var i = resources.length - 1; i >= 0; i--) {
                        let resourceItem = resources[i];
                        let pathComponents = resourceItem.split( '/' )
                        let accessoryToControl = this[pathComponents[1]][pathComponents[2]]
  
                        accessoryToControl.service.getCharacteristic(Characteristic.On).setValue(onOff);
                      }
                    } else if (deviceResourceType === 'lights/' && stateParam[0] === 0x0e && stateParam[1] === 0x01 && stateParam[2] === 0x00 && stateParam[3] === 0x55) { // Light Brightness
                      let brightness = dataArray[28]
                      this.log.info('Brightness: ' + brightness)
                      
                      let resources = this.panelsToResources['/' + r[1] + '/' + r[2] + '/light_' + deviceSerial[7]]
                      for (var i = resources.length - 1; i >= 0; i--) {
                        let resourceItem = resources[i];
                        let pathComponents = resourceItem.split( '/' )
                        let accessoryToControl = this[pathComponents[1]][pathComponents[2]]
  
                        accessoryToControl.service.getCharacteristic(Characteristic.Brightness).setValue(brightness);
                      }
                    } else if (deviceResourceType === 'lights/' && stateParam[0] === 0x0e && stateParam[1] === 0x02 && stateParam[2] === 0x00 && stateParam[3] === 0x55) { // Light CT
                      let colorTemperature = parseInt(dataArray[27].toString(16).padStart(2, '0') + dataArray[28].toString(16).padStart(2, '0'), 16)
                      this.log.info('Color Temperature: ' + colorTemperature)
                      
                      let resources = this.panelsToResources['/' + r[1] + '/' + r[2] + '/light_' + deviceSerial[7]]
                      for (var i = resources.length - 1; i >= 0; i--) {
                        let resourceItem = resources[i];
                        let pathComponents = resourceItem.split( '/' )
                        let accessoryToControl = this[pathComponents[1]][pathComponents[2]]
  
                        accessoryToControl.service.getCharacteristic(Characteristic.ColorTemperature).setValue(colorTemperature);
                      }
                    } else if (deviceResourceType === 'lights/' && stateParam[0] === 0x0e && stateParam[1] === 0x08 && stateParam[2] === 0x00 && stateParam[3] === 0x55) { // Light Color
                      let colorX = parseInt(dataArray[25].toString(16).padStart(2, '0') + dataArray[26].toString(16).padStart(2, '0'), 16)
                      let colorY = parseInt(dataArray[27].toString(16).padStart(2, '0') + dataArray[28].toString(16).padStart(2, '0'), 16)
                      this.log.info('Color X: ' + colorX + ', Color Y: ' + colorY)
  
                      const { h, s } = homebridgeLib.Colour.xyToHsv([colorX / 65535.0, colorY / 65535.0], accessoryToControl.config.gamut)
                      
                      let resources = this.panelsToResources['/' + r[1] + '/' + r[2] + '/light_' + deviceSerial[7]]
                      for (var i = resources.length - 1; i >= 0; i--) {
                        let resourceItem = resources[i];
                        let pathComponents = resourceItem.split( '/' )
                        let accessoryToControl = this[pathComponents[1]][pathComponents[2]]
  
                        accessoryToControl.service.getCharacteristic(Characteristic.Hue).setValue(h)
                        accessoryToControl.service.getCharacteristic(Characteristic.Saturation).setValue(s)
                      }
                    }
                  } else if (commandCategory === 0x71 && commandType === 0x84 && commandAction === 0x06) {
                    this.log.info('Asked data for param: ' + stateParam)
                    if (deviceResourceType === 'air_cond' && stateParam[0] === 0x0e && stateParam[2] === 0x00 && stateParam[3] === 0x55 && (stateParam[1] === 0x20 || stateParam[1] === 0x02)) { // Updated Air conditioner/Heater-Cooler device state
                      
                    } else if (deviceResourceType === 'lights/' && stateParam[0] === 0x04 && stateParam[1] === 0x01 && stateParam[2] === 0x00 && stateParam[3] === 0x55) { // Light On/Off
                      let pathComponents = this.panelsToResources['/' + r[1] + '/' + r[2] + '/light_' + deviceSerial[7]][0].split( '/' )
                      let accessoryToControl = this[pathComponents[1]][pathComponents[2]]
    
                      let onOff = accessoryToControl.service.getCharacteristic(Characteristic.On).value
                      this.log.info('On/Off: ' + onOff)
                      
                      this.put(resource, {aqara_s1_panel_communication: '19aa7113446d210541106c69676874732f' + deviceSerial[7].toString(16).padStart(2, '0') + '04010055' + '0000000' + (onOff ? '1' : '0')}).then((obj) => {
            
                      }).catch((error) => {
                        
                      })
                    } else if (deviceResourceType === 'lights/' && stateParam[0] === 0x0e && stateParam[1] === 0x01 && stateParam[2] === 0x00 && stateParam[3] === 0x55) { // Light Brightness
                      let pathComponents = this.panelsToResources['/' + r[1] + '/' + r[2] + '/light_' + deviceSerial[7]][0].split( '/' )
                      let accessoryToControl = this[pathComponents[1]][pathComponents[2]]
    
                      let brightness = accessoryToControl.service.getCharacteristic(Characteristic.Brightness).value
                      this.log.info('Brightness: ' + brightness)
                      
                      this.put(resource, {aqara_s1_panel_communication: '19aa7113446d210541106c69676874732f' + deviceSerial[7].toString(16).padStart(2, '0') + '0e010055' + '000000' + brightness.toString(16).padStart(2, '0')}).then((obj) => {
            
                      }).catch((error) => {
                        
                      })
                    } else if (deviceResourceType === 'lights/' && stateParam[0] === 0x0e && stateParam[1] === 0x02 && stateParam[2] === 0x00 && stateParam[3] === 0x55) { // Light CT
                      let pathComponents = this.panelsToResources['/' + r[1] + '/' + r[2] + '/light_' + deviceSerial[7]][0].split( '/' )
                      let accessoryToControl = this[pathComponents[1]][pathComponents[2]]
    
                      let colorTemperature = accessoryToControl.service.getCharacteristic(Characteristic.ColorTemperature).value
                      this.log.info('Color Temperature: ' + colorTemperature)
                      
                      this.put(resource, {aqara_s1_panel_communication: '19aa7113446d210541106c69676874732f' + deviceSerial[7].toString(16).padStart(2, '0') + '0e020055' + '0000' + colorTemperature.toString(16).padStart(4, '0')}).then((obj) => {
            
                      }).catch((error) => {
                        
                      })
                    } else if (deviceResourceType === 'lights/' && stateParam[0] === 0x0e && stateParam[1] === 0x08 && stateParam[2] === 0x00 && stateParam[3] === 0x55) { // Light Color
                      let pathComponents = this.panelsToResources['/' + r[1] + '/' + r[2] + '/light_' + deviceSerial[7]][0].split( '/' )
                      let accessoryToControl = this[pathComponents[1]][pathComponents[2]]
    
                      let hue = accessoryToControl.service.getCharacteristic(Characteristic.Hue).value
                      let sat = accessoryToControl.service.getCharacteristic(Characteristic.Saturation).value
                      this.log.info('Color Hue: ' + hue + ', Color Saturation: ' + sat)
    
                      const xy = homebridgeLib.Colour.hsvToXy(hue, sat, accessoryToControl.config.gamut)
                      this.log.info('Color X: ' + xy[0] + ', Color Y: ' + xy[1])
                      
                      this.put(resource, {aqara_s1_panel_communication: '19aa7113446d210541106c69676874732f' + deviceSerial[7].toString(16).padStart(2, '0') + '0e080055' + Math.round(xy[0] * 65535).toString(16).padStart(4, '0') + Math.round(xy[1] * 65535).toString(16).padStart(4, '0')}).then((obj) => {
            
                      }).catch((error) => {
                        
                      })
                    } else if (stateParam[0] === 0x08 && stateParam[1] === 0x00 && stateParam[2] === 0x1f && stateParam[3] === 0xa5 && this.actionsConfigData.aqara_S1_panels['/' + r[1] + '/' + r[2]]) { // Names
                      // console.log(this.actionsConfigData.aqara_S1_panels['/' + r[1] + '/' + r[2]])
                      // console.log(deviceResourceType === 'lights/' ? 'light_' + deviceSerial[7] : deviceResourceType === 'curtain' ? 'curtain_' + deviceSerial[7] : 'ac')
                      let name = this.actionsConfigData.aqara_S1_panels['/' + r[1] + '/' + r[2]][deviceResourceType === 'lights/' ? 'light_' + deviceSerial[7] : deviceResourceType === 'curtain' ? 'curtain_' + deviceSerial[7] : 'ac'].name
    
                      let nameSize = name.length
                      let nameHex = toHexString(name.split ('').map (function (c) { return c.charCodeAt (0); }))
    
                      let totalSize = 21 + 1 + nameSize
                      let commandSize = totalSize - 6
                      let paramsSize = commandSize - 3
                      let counter = '6d'
                      let integrity = 512 - (parseInt('aa', 16) + parseInt('71', 16) + commandSize + parseInt('44', 16) + parseInt(counter, 16))
    
                      let dataToSend = totalSize.toString(16).padStart(2, '0') + 'aa71' + commandSize.toString(16).padStart(2, '0') + '44' + counter + getUInt8(integrity).toString(16).padStart(2, '0') + '0541' + paramsSize.toString(16).padStart(2, '0') + (deviceResourceType === 'lights/' ? ('6c69676874732f' + deviceSerial[7].toString(16).padStart(2, '0')) : deviceResourceType === 'curtain' ? ('6375727461696e' + deviceSerial[7].toString(16).padStart(2, '0')) : '6169725f636f6e64') + '08001fa5' + nameSize.toString(16).padStart(2, '0') + nameHex
                      this.log.info('Name data: ' + dataToSend)
                      this.put(resource, {aqara_s1_panel_communication: dataToSend}).then((obj) => {
            
                      }).catch((error) => {
                        
                      })
                    } else if (stateParam[0] === 0x08 && stateParam[1] === 0x00 && stateParam[2] === 0x07 && stateParam[3] === 0xfd) { // Online/Offline
                      // TODO: set the state, on groups always online, on others, use the device.reachable state.
                      this.put(resource, {aqara_s1_panel_communication: '19aa7113446d21054110' + (deviceResourceType === 'lights/' ? ('6c69676874732f' + deviceSerial[7].toString(16).padStart(2, '0')) : deviceResourceType === 'curtain' ? ('6375727461696e' + deviceSerial[7].toString(16).padStart(2, '0')) : '6169725f636f6e64') + '080007fd' + '00000001'}).then((obj) => {
            
                      }).catch((error) => {
                        
                      })
                    }
                  } else if (commandCategory === 0x71 && commandType === 0x24 && commandAction === 0x05) { // ACKs for state commmands
                    
                    if (dataArray[13] === 0x01) { // A device is missing...
                      
                    } else if (dataArray[13] === 0x00 && (!this.actionsConfigData.aqara_S1_panels['/' + r[1] + '/' + r[2]] || (deviceResourceType === 'lights/' && !this.actionsConfigData.aqara_S1_panels['/' + r[1] + '/' + r[2]]['light_' + deviceSerial[7]]) || (deviceResourceType === 'curtain' && !this.actionsConfigData.aqara_S1_panels['/' + r[1] + '/' + r[2]]['curtain_' + deviceSerial[7]]) || (deviceResourceType === 'air_cond' && !this.actionsConfigData.aqara_S1_panels['/' + r[1] + '/' + r[2]]['ac']))) { // A device is set on the device, but shouldn't be there (removed from config...)

                    }
                  }
                }
              }
            }
          } else if (obj !== undefined && obj['on'] !== undefined && obj['on'] !== this.fullState.lights[r[2]].state.on) {
            if (this.panelsToResources['/' + r[1] + '/' + r[2] + '/switch'] !== undefined) {
              let resources = this.panelsToResources['/' + r[1] + '/' + r[2] + '/switch']
              for (var i = resources.length - 1; i >= 0; i--) {
                let resourceItem = resources[i];
                let pathComponents = resourceItem.split( '/' )
                let accessoryToControl = this[pathComponents[1]][pathComponents[2]]
    
                accessoryToControl.service.getCharacteristic(Characteristic.On).setValue(obj['on'])
              }
            }
          }
        }
        // End of Added by me: Arye Levin
        if (a) {
          if (r.length === 3) {
            this.log.debug('%s: attr changed event: %j', a.name, obj)
            a.checkAttr(obj, true)
          } else if (r[3] === 'state') {
            this.log.debug('%s: state changed event: %j', a.name, obj)
            a.checkState(obj, true)
          } else if (r[3] === 'config') {
            this.log.debug('%s: config changed event: %j', a.name, obj)
            a.checkConfig(obj, true)
          }
        }
      } catch (error) {
        this.log.warn('%s: websocket error: %s', this.name, formatError(error))
      }
    })
    .on('closed', (url) => {
      this.log.warn(
        '%s: websocket connection to %s closed - retrying in 15s', this.name,
        url
      )
    })
    .listen()
}

// ===== Heartbeat =============================================================

HueBridge.prototype.heartbeat = async function (beat) {
  if (beat % this.state.heartrate === 0) {
    this.service.getCharacteristic(my.Characteristics.LastUpdated)
      .updateValue(String(new Date()).substring(0, 24))
    try {
      await this.heartbeatConfig(beat)
      await this.heartbeatSensors(beat)
      await this.heartbeatLights(beat)
      await this.heartbeatGroup0(beat)
      await this.heartbeatGroups(beat)
      await this.heartbeatSchedules(beat)
      await this.heartbeatRules(beat)
      // Added by me: Arye Levin
      // this.log.info('Heartbeat!' + beat);
      let groupsKeysArray = Object.keys(this.groups);
      let lightsKeysArray = Object.keys(this.lights);
      if (groupsKeysArray.length + lightsKeysArray.length) {
        var index = (beat / this.state.heartrate) % (groupsKeysArray.length + lightsKeysArray.length);
        // this.log.info('putState: ' + index + ', id: ' + keysArray[index]);
        if (index < groupsKeysArray.length) {
          const a = this.groups[groupsKeysArray[index]];
          if (a) {
            // this.log.info('found group object');
            a.putState();
          }
        } else if (index - groupsKeysArray.length < lightsKeysArray.length) {
          const a = this.lights[lightsKeysArray[index - groupsKeysArray.length]];
          if (a) {
            // this.log.info('found light object');
            a.putState();
          }
        }
      }
      // End of Added by me: Arye Levin
    } catch (error) {
      if (error.request == null) {
        this.log.warn('%s: heartbeat error: %s', this.name, formatError(error))
      }
    }
  }
  if (beat % 600 === 0) {
    try {
      for (const id in this.sensors) {
        this.sensors[id].addEntry()
      }
    } catch (error) {
      this.log.warn('%s: heartbeat error: %s', this.name, formatError(error))
    }
  }
}

HueBridge.prototype.heartbeatSensors = async function (beat) {
  if (this.state.sensors === 0) {
    return
  }
  const sensors = await this.get('/sensors')
  for (const id in sensors) {
    const a = this.sensors[id]
    if (a) {
      a.heartbeat(beat, sensors[id])
    }
  }
}

HueBridge.prototype.heartbeatConfig = async function (beat) {
  if (!this.config.link) {
    return
  }
  const config = await this.get('/config')
  if (config.linkbutton !== this.state.linkbutton) {
    this.log.debug(
      '%s: %s linkbutton changed from %s to %s', this.name, this.type,
      this.state.linkbutton, config.linkbutton
    )
    this.state.linkbutton = config.linkbutton
    if (this.state.linkbutton) {
      this.log(
        '%s: homekit linkbutton single press', this.switchService.displayName
      )
      this.switchService.updateCharacteristic(
        Characteristic.ProgrammableSwitchEvent,
        Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS
      )
      await this.put('/config', { linkbutton: false })
      this.state.linkbutton = false
    } else {
      const hkLink = false
      if (hkLink !== this.state.hkLink) {
        this.log(
          '%s: set homekit link from %s to %s', this.name,
          this.state.hkLink, hkLink
        )
        this.state.hkLink = hkLink
        this.service
          .updateCharacteristic(my.Characteristics.Link, this.state.hkLink)
      }
    }
  }
}

HueBridge.prototype.heartbeatLights = async function (beat) {
  if (this.state.lights === 0) {
    return
  }
  const lights = await this.get('/lights')
  for (const id in lights) {
    const a = this.lights[id]
    if (a) {
      a.heartbeat(beat, lights[id])
    }
  }
}

HueBridge.prototype.heartbeatGroups = async function (beat) {
  if (this.state.groups - this.state.group0 === 0) {
    return
  }
  const groups = await this.get('/groups')
  for (const id in groups) {
    if (id === '0') {
      // Workaround for deCONZ bug
      continue
    }
    const a = this.groups[id]
    if (a) {
      a.heartbeat(beat, groups[id])
    }
  }
}

HueBridge.prototype.heartbeatGroup0 = async function (beat) {
  if (this.state.group0 === 0) {
    return
  }
  const group0 = await this.get('/groups/0')
  const a = this.groups[0]
  if (a) {
    a.heartbeat(beat, group0)
  }
}

HueBridge.prototype.heartbeatSchedules = async function (beat) {
  if (this.state.schedules === 0) {
    return
  }
  const schedules = await this.get('/schedules')
  for (const id in schedules) {
    const a = this.schedules[id]
    if (a) {
      a.heartbeat(beat, schedules[id])
    }
  }
}

HueBridge.prototype.heartbeatRules = async function (beat) {
  if (this.state.rules === 0) {
    return
  }
  const rules = await this.get('/rules')
  for (const id in rules) {
    const a = this.rules[id]
    if (a) {
      a.heartbeat(beat, rules[id])
    }
  }
}

// ===== Homekit Events ========================================================

HueBridge.prototype.setHeartrate = function (rate, callback) {
  if (rate === this.state.heartrate) {
    return callback()
  }
  this.log.info(
    '%s: homekit heartrate changed from %ss to %ss', this.name,
    this.state.heartrate, rate
  )
  this.state.heartrate = rate
  return callback()
}

HueBridge.prototype.setLink = function (link, callback) {
  if (link === this.state.hkLink) {
    return callback()
  }
  this.log.info(
    '%s: homekit link changed from %s to %s', this.name,
    this.state.hkLink, link
  )
  this.state.hkLink = link
  const newValue = link
  this.put('/config', { linkbutton: newValue }).then(() => {
    this.state.linkbutton = newValue
    return callback()
  }).catch((error) => {
    return callback(error)
  })
}

HueBridge.prototype.setTransitionTime = function (transitiontime, callback) {
  transitiontime = Math.round(transitiontime * 10) / 10
  if (transitiontime === this.state.transitiontime) {
    return callback()
  }
  this.log.info(
    '%s: homekit transition time changed from %ss to %ss', this.name,
    this.state.transitiontime, transitiontime
  )
  this.state.transitiontime = transitiontime
  return callback()
}

// Added by me: Arye Levin
HueBridge.prototype.setBrightness = function (bri, callback) {
  const oldBri = Math.round(this.state.bri * 100)
  if (bri === oldBri) {
    return callback()
  }
  this.log.info(
    '%s: homekit adaptive lighting brightness correction changed from %d%% to %d%%',
    this.name, oldBri, bri
  )
  this.state.bri = bri / 100
  this.platform.config.brightnessAdjustment = this.state.bri
  this.writeStateFile()
  return callback()
}
// End of Added by me: Arye Levin

HueBridge.prototype.setRestart = function (restart, callback) {
  if (!restart) {
    return callback()
  }
  this.log.info('%s: restart', this.name)
  this.hueClient.restart().then((obj) => {
    setTimeout(() => {
      this.service.setCharacteristic(my.Characteristics.Restart, false)
    }, this.platform.config.resetTimeout)
    return callback()
  }).catch((error) => {
    return callback(error)
  })
}

HueBridge.prototype.identify = function (callback) {
  this.log.info('%s: identify', this.name)
  this.platform.identify()
  this.log.info(this.idString)
  callback()
}

HueBridge.prototype.get = async function (resource) {
  try {
    return this.hueClient.get(resource)
  } catch (error) {
    if (error.request == null) {
      this.log.error('%s: %s', this.name, formatError(error))
    }
    throw error
  }
}

HueBridge.prototype.put = async function (resource, body) {
  try {
    return this.hueClient.put(resource, body)
  } catch (error) {
    if (error.request == null) {
      this.log.error('%s: %s', this.name, formatError(error))
    }
    throw error
  }
}
