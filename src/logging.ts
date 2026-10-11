/** Fastify/pino options: never log secrets, cookies, query strings (OAuth codes) or bodies. */
export function loggerOptions(nodeEnv: string) {
  return {
    level: process.env.LOG_LEVEL ?? (nodeEnv === 'production' ? 'info' : 'debug'),
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]', '*.token', '*.access_token', '*.client_secret'],
      remove: true,
    },
    serializers: {
      req(req: { method: string; url: string; id: string }) {
        return { id: req.id, method: req.method, url: req.url.split('?')[0] };
      },
    },
  };
}
