const config = require('./config');
const { createStatistics } = require('./statistics-store');
module.exports = createStatistics({
  directory: config.statistics.directory,
  timezone: config.statistics.timezone,
  metaDir: config.storage.metaDir,
  dirForType: config.dirForType,
});
