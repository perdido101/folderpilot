import pino from "pino";

/** Structured logs. Never log file contents, tokens or keys — only ids, counts and timings. */
export function createLogger(level: string, pretty: boolean) {
  return pino({
    level,
    redact: { paths: ["req.headers.cookie", "req.headers.authorization", "*.password", "*.token", "*.apiKey"], remove: true },
    ...(pretty ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } } } : {}),
  });
}

export type Logger = ReturnType<typeof createLogger>;
