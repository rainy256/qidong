import { buildServer } from './app';

const { app, db, config } = buildServer({ logger: true });

const runPurge = () => {
  try {
    const res = db.purgeExpired();
    if (res.deletedRooms > 0 || res.deletedMutations > 0) {
      app.log.info(res, 'Purged expired rooms/mutations');
    }
  } catch (err) {
    app.log.error(err, 'Failed to purge expired rooms/mutations');
  }
};

runPurge();
const purgeTimer = setInterval(runPurge, 6 * 60 * 60 * 1000);
purgeTimer.unref?.();

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(purgeTimer);
  app.log.info({ signal }, 'Shutting down server');
  try {
    await app.close();
    process.exit(0);
  } catch (err) {
    app.log.error(err, 'Error during server shutdown');
    process.exit(1);
  }
};

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

await app.listen({ host: config.host, port: config.port });
