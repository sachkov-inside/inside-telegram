import "dotenv/config";
import "reflect-metadata";

import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";

import { AppModule } from "./app.module.js";
import { loadApplicationConfig } from "./config/application-config.js";

const config = loadApplicationConfig(process.env);
const application = await NestFactory.create<NestFastifyApplication>(
  AppModule.register(config),
  new FastifyAdapter({
    bodyLimit: 1024 * 1024,
  }),
  {
    logger: ["error", "warn", "log"],
  },
);
application.enableShutdownHooks();
await application.listen(config.port, config.host);

new Logger("Bootstrap").log(
  `Inside Telegram listening on ${config.host}:${config.port}`,
);
