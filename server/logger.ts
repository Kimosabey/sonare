/**
 * One structured logger, replacing bare console.* calls across server/.
 * Structured (JSON) output in production so log lines are actually
 * queryable by a log platform; pretty-printed in dev because nobody wants
 * to read raw JSON in a terminal while iterating.
 */

import pino from "pino";

const isProd = process.env.NODE_ENV === "production";

export const logger = pino(
  isProd
    ? { level: "info" }
    : {
        level: "debug",
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
        },
      },
);
