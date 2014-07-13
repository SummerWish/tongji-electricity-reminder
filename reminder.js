var argv = require('optimist')
  .usage('Usage: $0 [config_path]')
  .argv;

var buildings = require('./values.js');
var config_path = argv._.length > 0 ? argv._[0] : './config.json';
var config = require(config_path);

var nodemailer = require('nodemailer');
var score = require('string_score');
var async = require('async');
var request = require('request');
var cheerio = require('cheerio');
var moment = require('moment');

// check buildings
config.watch.forEach(function(c) {
  var level_1_key = null;
  for (var campus_name in buildings) {
    if (campus_name.indexOf(c.campus) > -1) {
      level_1_key = campus_name;
      break;
    }
  }
  if (level_1_key === null) {
    throw new Error('Campus not found: ' + c.campus);
  }

  var level_2_key = null;
  var level_2_score = 0;
  buildings[level_1_key].forEach(function(v) {
    var m = v.score(c.building);
    if (m > level_2_score) {
      level_2_score = m;
      level_2_key = v;
    }
  });
  if (level_2_key === null) {
    throw new Error('Building not found: ' + c.campus + ' ' + c.building);
  }

  c.campus = level_1_key;
  c.building = level_2_key;
});

// helper function
var extract_state = function(response, body, callback) {
  try {
    var $ = cheerio.load(body);
    var viewstate = $('#__VIEWSTATE').val();
    var eventvalidation = $('#__EVENTVALIDATION').val();
    callback(null, viewstate, eventvalidation);
  } catch(e) {
    callback(e);
  }
}

var format = function(str, obj) {
  return str.replace(/\{([^{}]+)\}/g, function(match, key) {
    var value = obj[key];
    return value != undefined ? value : match;
  });
}

// prepare mailing
var transport = nodemailer.createTransport('SMTP', {
  secureConnection: true,
  host: config.sender.server,
  port: config.sender.port,
  auth: {
    user: config.sender.user,
    pass: config.sender.pass
  }
});

// query remaining
async.each(config.watch, function(c, callback) {
  async.waterfall([
    function(callback) {
      request.get(config.url, callback);
    },
    extract_state,
    function(viewstate, eventvalidation, callback) {
      request.post(config.url, {
        form: {
          '__EVENTTARGET': 'DistrictDown',
          '__EVENTARGUMENT': '',
          '__LASTFOCUS': '',
          '__VIEWSTATE': viewstate,
          '__EVENTVALIDATION': eventvalidation,
          'DistrictDown': c.campus,
          'BuildingDown': '请选择楼号',
          'RoomnameText': ''
        }
      }, callback);
    },
    extract_state,
    function(viewstate, eventvalidation, callback) {
      request.post(config.url, {
        form: {
          '__EVENTTARGET': '',
          '__EVENTARGUMENT': '',
          '__LASTFOCUS': '',
          '__VIEWSTATE': viewstate,
          '__EVENTVALIDATION': eventvalidation,
          'DistrictDown': c.campus,
          'BuildingDown': c.building,
          'RoomnameText': c.room,
          'Submit': '查询'
        }
      }, callback);
    },
    function(response, body, callback) {
      var $ = cheerio.load(body);
      var $table = $('#GridView1');
      if ($table.length > 0) {
        var cols = $table.find('tr').eq(1).children('td');
        callback(null, cols.eq(0).text(), cols.eq(1).text(), cols.eq(2).text(), cols.eq(3).text());
      } else {
        callback(new Error('Failed to parse body'));
      }
    }
  ], function(err, date, used, all, remain) {
    if (err) {
      return callback(err);
    }
    var obj = {
      campus: c.campus.trim(),
      building: c.building.trim(),
      room: c.room.toString().trim(),
      value: c.value,
      date: date,
      used: used,
      all: all,
      remain: remain,
      datetime: moment().format('dddd, MMMM Do YYYY, h:mm:ss a')
    };
    //console.log(format('{campus}{building}宿舍楼{room}寝室：剩余 {remain} kWh @ {date}', obj));
    if (parseFloat(remain) < parseFloat(c.value)) {
      transport.sendMail({
        from: config.sender.nick + ' <' + config.sender.user + '>',
        to: c.receiver,
        subject: format(config.template.subject, obj),
        text: format(config.template.body, obj)
      }, function() {
        // igmore mailing errors
        callback();
      });
    } else {
      callback();
    }
  });
}, function() {
  transport.close();
});
