const app = require('./app');
const { PORT, NODE_ENV } = require('./config/env');
const { startArrivalScheduler } = require('./services/arrivalSchedulerService');

const server = app.listen(PORT, () => {
  console.log(`Pixx Bicycle CCTV Backend running in ${NODE_ENV} mode on port ${PORT}`);
  if (NODE_ENV !== 'test') {
    startArrivalScheduler();
  }
});

module.exports = server;
