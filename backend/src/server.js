const app = require('./app');
const { PORT, NODE_ENV, isServerless } = require('./config/env');
const { startArrivalScheduler } = require('./services/arrivalSchedulerService');

if (!isServerless && require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`Pixx Bicycle CCTV Backend running in ${NODE_ENV} mode on port ${PORT}`);
    if (NODE_ENV !== 'test') {
      startArrivalScheduler();
    }
  });
  module.exports = server;
} else {
  module.exports = app;
}
