/* 靜態快照：把前端的 api() 接到預先輸出的 JSON，不打伺服器。 */
(function () {
  var cache = {};
  function load(name) {
    if (!cache[name]) {
      cache[name] = fetch('d/' + name + '.json').then(function (r) {
        if (!r.ok) throw new Error(name + ' → ' + r.status);
        return r.json();
      });
    }
    return cache[name];
  }
  window.staticApi = function (p) {
    var m;
    if (p === '/api/status') return load('status');
    if (p === '/api/predict/weekly') return load('weekly');
    if (p === '/api/predict/legend') return load('legend');
    if ((m = p.match(/^\/api\/predict\/period\?kind=(\w+)/))) return load('period_' + m[1]);
    if (p === '/api/accuracy') return load('accuracy');
    if (p === '/api/backtest') return load('backtest');
    if (p.indexOf('/api/milestones') === 0) return load('milestones');
    if ((m = p.match(/^\/api\/issues\?board=(\d+)/))) return load('issues_' + m[1]);
    if ((m = p.match(/^\/api\/issue\/(\d+)\/(\d+)/))) {
      return load('board_' + m[1]).then(function (all) {
        var v = all[m[2]];
        if (!v) throw new Error('這一期不在快照裡');
        return v;
      });
    }
    if ((m = p.match(/^\/api\/song\/(\S+)/))) {
      return load('songs').then(function (all) {
        var v = all[m[1]];
        if (!v) throw new Error('這首歌的在榜紀錄不在快照裡');
        return v;
      });
    }
    return Promise.reject(new Error('快照版沒有這項資料：' + p));
  };
})();
