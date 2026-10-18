const path = require('path');
const config = require('./config');
const statistics = require('./statistics');
const { createVisits } = require('./visits');
// 与上传统计日志放在同一目录：发布时保留、备份时包含；resources.sqlite 会在启动时重建，不能放在那里。
module.exports = createVisits({
  file: path.join(config.statistics.directory, 'visits.sqlite'),
  dateOf: statistics.dateOf,
});
