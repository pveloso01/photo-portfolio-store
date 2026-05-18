import * as Sentry from '@sentry/node';

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  const release = process.env.SENTRY_RELEASE;
  const environment = process.env.NODE_ENV ?? 'development';
  const tracesSampleRate = environment === 'production' ? 0.1 : 1.0;

  const initOptions: Sentry.NodeOptions = {
    dsn,
    environment,
    tracesSampleRate,
    sendDefaultPii: false,
    beforeSend(event) {
      if (event.user) {
        delete event.user.email;
        delete event.user.ip_address;
      }
      return event;
    },
  };

  if (release) {
    initOptions.release = release;
  }

  Sentry.init(initOptions);
}

export { Sentry };
