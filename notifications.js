var appId = '2b535ce7-1ca1-4950-813f-2d89c9f281c2';
var https = require('https');
var http = require('http');
var request = require('request');
var parse = require('csv-parse');
var zlib = require('zlib');
const moment = require('moment-timezone');

const badiCalc = require('./Badi/badiCalc');
const sunCalc = require('./Badi/sunCalc');

var _rawUserList = [];
var _users = {}; //keyed by id
var _triggers = {}; //keyed by HH:mm

var _lastKeepAliveCall = new Date();
var _keepAliveMinutes = 25;
var _keepAliveUrl = process.env.BASEURL || "https://wondrous-badi.herokuapp.com/keepAlive";

var serverZone = moment.tz.guess();
console.log('server zone: ' + serverZone);
var manuallyStopped = false;
var reminderInterval = null;

function sendTest(id, msg) {
    if (_users[id] && _users[id].tags && _users[id].tags.latitude) {
        sendReminder(id);
    } else {
        var message = {
            app_id: appId,
            contents: {
                "en": msg || 'Test message!'
            },
            url: 'https://wondrous-badi.herokuapp.com/notify',
            include_player_ids: [id]
        };
        sendNotification(message);
    }

}

function getTime(body) {
    var lat = +body.lat;
    var lng = +body.lng;
    var zone = body.zoneName;

    var id = body.userId;
    if (id && !_users[id]) {
        _users[id] = {
            id: id
        };
    }
    if (_users[id]) {
        var user = _users[id];
        user.tags.latitude = lat;
        user.tags.longitude = lng;
    }


    var profile = {
        coord: {
            lat: lat,
            lng: lng
        },
        tzInfo: {
            zoneName: zone
        }
    }
    var answers = [];

    badiCalc.addSunTimes(profile, answers);

    return answers;
}
function setWhen(body) {
    // console.log(body);
    if (!body.user) {
        return { saved: false };
    }

    var user = _users[body.user];
    if (!user) {
        _users[body.user] = user = {
            id: body.user,
            tags: {
                when: body.when
            }
        }
    } else {
        user.tags.when = body.when;
    }

    addAllReminderTriggersForUser(user.id);

    console.log('Triggers active:')
    console.log(_triggers);

    return {
        saved: true,
        when: body.when
    }
    // user:c3d2d533-1dab-4e68-ad7a-57e7a41a8403
    // what:whenSunset
    // on:false
    // when:
    // var message = {
    //     app_id: appId,
    //     url: 'https://wondrous-badi.herokuapp.com/',
    //     include_player_ids: [body.user],
    //     headings: {},
    //     contents: {}
    // };


    // switch (body.what) {
    //     case 'whenSunset':
    //         break;
    //     case 'whenSunrise':
    //         break;
    //     case 'whenCustom':
    //         if (body.checked === 'true') {
    //             if (body.when) {
    //                 message.send_after = new Date();
    //                 message.delayed_option = 'timezone';
    //                 message.delivery_time_of_day = body.when;
    //                 message.contents.en = 'Test at ' + body.when;
    //                 sendNotification(message);
    //                 return true;
    //             }
    //         }
    //         break;
    //     default:
    // }
    // return false;
}


function sendNotification(data) {
    var headers = {
        "Content-Type": "application/json; charset=utf-8",
        "Authorization": "Basic NjBiYWE4ZWMtMjIzMi00ODk0LTk4YzItMWNmOGMzYWU3NTM0"
    };

    var options = {
        host: "onesignal.com",
        port: 443,
        path: "/api/v1/notifications",
        method: "POST",
        headers: headers
    };

    var req = https.request(options, function (res) {
        res.on('data', function (data) {
            console.log("Response:");
            var result = JSON.parse(data.toString());
            console.log(result);
        });
    });

    req.on('error', function (e) {
        console.log("ERROR:");
        console.log(e);
    });

    // console.log('sending:');
    // console.log(data);

    req.write(JSON.stringify(data));
    req.end();
};






// For this user, add any reminders in the next 24 hours
function addAllReminderTriggersForUser(id) {
    var profile = _users[id];

    if (!profile.tags.zoneName) {
        console.log(`add all triggers for user ${id} - abort, no timezone`);
        return;
    }

    console.log(`add all triggers for user ${id} in ${profile.tags.zoneName}`);
    //console.log(profile);

    removeAllRemindersForUser(id);

    var zoneName = profile.tags.zoneName;

    // OLD needs to be at least one minute in the future!
    var nowTz = moment.tz(zoneName).add(1, 'minutes');
    var serverNow = moment().add(1, 'minutes');
    // console.log(`user now: ${nowTz.format()}`);    
    var noonTz = moment(nowTz).hour(12).minute(0).second(0);
    var tomorrowNoonTz = moment(noonTz).add(24, 'hours');

    var minutesFromUserToServer = serverNow.diff(nowTz, 'minutes');
    // save for later
    profile.minutesOffset = minutesFromUserToServer;

    var numAdded = 0;
    var triggers = (profile.tags.when || '').split(',');
    for (var i = 0; i < triggers.length; i++) {
        var trigger = triggers[i];
        if (!trigger) {
            continue;
        }
        var when;
        var parts = trigger.split('@');
        var triggerType = parts[0];
        var triggerOffset = 0;
        if (parts.length === 2) {
            triggerOffset = +parts[1] - 30;
        }
        switch (triggerType) {
            case 'sunrise':
            case 'sunset':
                when = determineSunTriggerTime(triggerType, triggerOffset, nowTz, noonTz, tomorrowNoonTz, profile);
                if (!when) {
                    console.log(`invalid trigger: ${triggerType} for ${id}`);
                    continue;
                }
                break;
            default:
                // should be hh:mm
                var targetTime = moment.tz(trigger, 'H:mm', zoneName);
                if (targetTime.isValid()) {
                    if (targetTime.isBefore(nowTz, 'minute')) {
                        targetTime.add(24, 'hours');
                    }
                    when = targetTime.tz(serverZone).format('HH:mm');
                } else {
                    console.log(`invalid time: ${trigger} for ${id}`);
                    continue;
                }
                break;
        }
        addTrigger(when, { id: id, trigger: trigger });
    }
}

function addTrigger(when, info) {
    console.log(`add trigger at ${when} for ${info.trigger}`);
    var triggersAtThisTime = _triggers[when];
    if (!triggersAtThisTime) {
        _triggers[when] = triggersAtThisTime = [];
    }
    triggersAtThisTime.push(info);
}

function removeAllRemindersForUser(id) {
    for (var time in _triggers) {
        if (_triggers.hasOwnProperty(time)) {
            var triggersAtThisTime = _triggers[time];
            for (var i = 0; i < triggersAtThisTime.length; i++) {
                if (triggersAtThisTime[i].id === id) {
                    triggersAtThisTime.splice(i, 1);
                    i--;
                    console.log('removed at ' + time);
                }
            }
            if (!triggersAtThisTime.length) {
                delete _triggers[time];
            }
        }
    }
}

function addNextSunTriggerFor(info) {
    // used after a sun event to reset for the next one
    var profile = _users[info.id];
    var zoneName = profile.tags.zoneName;

    console.log(`Adding trigger for ${info.id} at ${info.trigger}`);

    // needs to be at least one minute in the future!
    var nowTz = moment.tz(zoneName).add(1, 'minutes');
    var noonTz = moment(nowTz).hour(12).minute(0).second(0);
    var tomorrowNoonTz = moment(noonTz).add(24, 'hours');

    var trigger = info.trigger;
    var parts = trigger.split('@');
    var triggerType = parts[0];
    var triggerOffset = 0;
    if (parts.length === 2) {
        triggerOffset = +parts[1] - 30;
    }

    var when = determineSunTriggerTime(triggerType, triggerOffset, nowTz, noonTz, tomorrowNoonTz, profile);

    addTrigger(when, info);

    console.log('Triggers active:')
    console.log(_triggers);
}

function dumpInfo() {
    console.log('------------------- DUMP 1 ------------------------------');
    console.log('Server time: ')
    console.log(moment().format());
    console.log(new Date());

    console.log('Users:');
    console.log(_users);

    console.log('Triggers active:')
    console.log(_triggers);
    console.log('------------------- END DUMP 1 --------------------------');

}

function determineSunTriggerTime(triggerName, triggerOffset, nowTz, noonTz, tomorrowNoonTz, profile) {
    var zoneName = profile.tags.zoneName;
    var lat = +profile.tags.latitude;
    var lng = +profile.tags.longitude;

    var sunTimes = sunCalc.getTimes(noonTz, lat, lng);
    var whenTz = moment.tz(sunTimes[triggerName], zoneName)

    if (nowTz.isAfter(whenTz, 'minute')) {
        sunTimes = sunCalc.getTimes(tomorrowNoonTz, lat, lng)
        whenTz = moment.tz(sunTimes[triggerName], zoneName);
    }

    whenTz.add(triggerOffset, 'minutes');

    var serverWhen = moment(whenTz).subtract(profile.minutesOffset, 'minutes');
    var serverWhenHHMM = serverWhen.format('HH:mm');

    profile[triggerName] = serverWhenHHMM;

    return serverWhenHHMM;
}

function OLD_determineSunTriggerTime(which, nowTz, noonTz, tomorrowNoonTz, idToProcess, profile) {
    var remindersForThisEvent = _triggers[which];
    var numChanged = 0;

    for (var id in remindersForThisEvent) {
        if (idToProcess === id) {
            var profileStub = remindersForThisEvent[id];
            //        console.log(profileStub);
            //TODO update to use moment.tz!

            var lastSetFor = profileStub.lastSetFor;
            if (lastSetFor) {
                // remove old version
                var reminderGroup = _triggers[lastSetFor];
                //          console.log(reminderGroup[id]);
                if (reminderGroup[id] && reminderGroup[id].sunTrigger === which) {
                    delete reminderGroup[id];
                    console.log(`removed previous ${which} reminder.`)
                    numChanged++;
                }
            }

            var zoneName = profile.tags.zoneName;
            var lat = +profile.tags.latitude;
            var lng = +profile.tags.longitude;

            var sunTimes = sunCalc.getTimes(noonTz, lat, lng);
            var whenTz = moment.tz(sunTimes[which], zoneName)

            if (nowTz.isAfter(whenTz, 'minute')) {
                sunTimes = sunCalc.getTimes(tomorrowNoonTz, lat, lng)
                whenTz = moment.tz(sunTimes[which], zoneName);
            }

            var details = {
                diff: profileStub.diff,
                userTime: whenTz.format('HH:mm'),
                sunTrigger: which
            };

            var serverWhen = moment(whenTz).subtract(profileStub.diff, 'hour');
            var serverWhenHHMM = serverWhen.format('HH:mm');
            console.log(`added ${which} for ${serverWhenHHMM}`);

            profileStub.lastSetFor = serverWhenHHMM;
            profileStub.lastSetAt = moment().format(); // just for interest sake

            //      console.log(profileStub);
            //      console.log(details);

            var reminderGroup = _triggers[serverWhenHHMM] || {};
            reminderGroup[id] = details;
            _triggers[serverWhenHHMM] = reminderGroup;
            numChanged++;
        }
    }
    return numChanged;
}

function doReminders() {

    var serverWhen = moment().format('HH:mm');

    var now = new Date();
    var age = now - _lastKeepAliveCall;
    var minutes = Math.floor(age / 1000 / 60);

    console.log(`Checking reminders for ${serverWhen} (${minutes} minutes since keep alive))`)

    var remindersAtWhen = _triggers[serverWhen];
    if (remindersAtWhen) {
        for (var i = 0; i < remindersAtWhen.length; i++) {
            var info = remindersAtWhen[i];
            var id = info.id;
            console.log('sending to ' + id);

            sendReminder(info.id);

            if (info.trigger === 'sunset' || info.trigger === 'sunrise') {
                remindersAtWhen.splice(i, 1);

                setTimeout(function (info2) {
                    addNextSunTriggerFor(info2);
                }, 5 * 60 * 1000, info); // wait five minutes... sunset may move by a few minutes between days...
            }
        }
    }

    keepServerAlive(minutes);
}

function keepServerAlive(minutes) {
    if (minutes >= _keepAliveMinutes) {
        console.log('calling keepAlive url at ' + _keepAliveUrl);
        if (_keepAliveUrl.substring(0, 5) === 'https') {
            https.get(_keepAliveUrl);
        } else {
            http.get(_keepAliveUrl);

        }
        _lastKeepAliveCall = new Date();
    }
}

function sendReminder(id) {
    //DONE
    console.log(`Sending notification to ${id}`);

    if (process.env.TESTONLY) {
        if (process.env.TESTONLY !== id) {
            console.log('--abort: in test environment');
            return;
        }
    }

    var profile = _users[id];

    var dateInfo = badiCalc.getDateMessage(profile);

    var message = {
        app_id: appId,
        headings: {
            "en": dateInfo.title
        },
        contents: {
            "en": dateInfo.text
        },
        url: 'https://wondrous-badi.herokuapp.com/verse',
        include_player_ids: [id]
    };
    sendNotification(message);

    // var log = [];
    // log.push({
    //     when: new Date(),
    //     trigger: trigger,
    //     answers: originalAnswers
    // });

    // profile.visitCount = log.length;
    // storage.setItem(keys.profile, profile);
    // storage.setItem(keys.log, log);

    // console.log('stored profile and log');
}



























function retrieveKnownUsers() {
    var headers = {
        "Content-Type": "application/json; charset=utf-8",
        "Authorization": "Basic NjBiYWE4ZWMtMjIzMi00ODk0LTk4YzItMWNmOGMzYWU3NTM0"
    };

    var options = {
        host: "onesignal.com",
        port: 443,
        path: "/api/v1/players/csv_export",
        method: "POST",
        headers: headers
    };

    var message = {
        app_id: appId
        //extra_fields: ['location']
    };

    var req = https.request(options, function (res) {
        res.on('data', function (data) {
            var result = JSON.parse(data);
            var fileUrl = result.csv_file_url;
            // console.log('CSV prepared at ' + fileUrl);
            if (fileUrl) {
                // file is never ready instantly... give some time for the file to be prepared
                setTimeout(function () {
                    loadRemoteCsvFile(fileUrl);
                }, 1000);
            } else {
                console.log('Error getting info re CSV file:');
                console.log(data);
            }
        });
    }).on('error', function (e) {
        console.log("ERROR:");
        console.log(e);
    });

    console.log('Getting CSV of current users');
    req.write(JSON.stringify(message));
    req.end();
}

var _remoteCsvLoadAttempts = 0;

function loadRemoteCsvFile(url) {
    const maxAttempts = 5;

    _remoteCsvLoadAttempts++;
    console.log(`Loading remote CSV, attempt ${_remoteCsvLoadAttempts}`);

    request({
        method: 'GET',
        uri: url,
        encoding: null,
        gzip: true
    }, function (error, response, body) {
        // console.log(response.statusCode);
        if (response.statusCode == 403) {
            if (_remoteCsvLoadAttempts < maxAttempts) {
                setTimeout(function () {
                    loadRemoteCsvFile(url);
                }, (_remoteCsvLoadAttempts) * 1000);
            } else {
                console.log(`Gave up getting CSV after ${_remoteCsvLoadAttempts} attempts.`);
                directlyRetrieveUserList();
            }
            return;
        }
        if (!error && response.statusCode == 200) {
            zlib.gunzip(body, function (error2, body2) {
                if (error2) {
                    console.log(error2);
                } else {
                    _remoteCsvLoadAttempts = 0;
                    processCsv(body2);
                }
            });
        } else {
            console.log(response.statusCode);
            console.log(error);
        }
    })
}

function processCsv(csvFile) {
    console.log('Processing CSV...')
    parse(csvFile, { columns: true }, function (err, users) {
        if (err) {
            console.log(err);
            return;
        }
        console.log(users.length + ' users defined');
        _rawUserList = users;
        setupTriggersForAllUsers();
    });
}

function directlyRetrieveUserList() {
    var headers = {
        "Content-Type": "application/json; charset=utf-8",
        "Authorization": "Basic NjBiYWE4ZWMtMjIzMi00ODk0LTk4YzItMWNmOGMzYWU3NTM0"
    };

    var options = {
        host: "onesignal.com",
        port: 443,
        path: "/api/v1/players?app_id=" + appId,
        method: "GET",
        headers: headers,
    };

    var req = https.request(options, function (res) {
        var data = [];

        res.on('data', function (chunk) {
            data.push(chunk);
        });
        res.on('end', function () {
            var binary = Buffer.concat(data);
            // binary is your data
            var result = JSON.parse(binary.toString());
            console.log('receiving ' + result.total_count);
            _rawUserList = result.players;
            setupTriggersForAllUsers();
        });


    }).on('error', function (e) {
        console.log("ERROR:");
        console.log(e);
    });

    console.log('Getting list of current users');
    req.end();
}

function setupTriggersForAllUsers() {
    var withTags = 0;
    // extract only those with tags
    for (var i = 0, m = _rawUserList.length; i < m; i++) {
        var user = _rawUserList[i];
        // console.log(user);
        if (user.tags) {
            _users[user.id] = {
                id: user.id,
                tags: typeof user.tags === 'string' ? convertTags(user.tags) : user.tags,
                language: user.language,
                minutesOffset: 0  // will be updated later
            };
            withTags++;
        }
    }
    console.log(withTags + ' users with tags');
    for (var id in _users) {
        if (_users.hasOwnProperty(id)) {
            var user = _users[id];
            addAllReminderTriggersForUser(id);
        }
    }
    console.log('Triggers active:')
    console.log(_triggers);

    startReminderTimer();
}

function convertTags(rawTagString) {
    return JSON.parse(`{${rawTagString.replace(/=>/g, ':')}}`);
}

function getWhenFor(id) {
    var user = _users[id];
    if (user) {
        var when = user.tags.when;
        return when;
    }
    return null;
}

function startReminderTimer() {

    if (manuallyStopped) {
        return;
    }

    clearInterval(reminderInterval);
    reminderInterval = setInterval(doReminders, 1000 * 60);

    console.log(`Reminder interval started for every minute.`);

    doReminders();
}

module.exports = {
    sendTest: sendTest,
    setWhen: setWhen,
    getTime: getTime,
    getWhenFor: getWhenFor,
    dumpInfo: dumpInfo
};

retrieveKnownUsers();
// directlyRetrieveUserList();
