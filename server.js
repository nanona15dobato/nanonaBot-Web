'use strict';

const config = require('./src/config');
const createApp = require('./src/app');

config.assertWebEnv();

const app = createApp();

app.listen(config.server.port, () => {
  console.log(`NanonaBot Tool listening on port ${config.server.port}`);
});
