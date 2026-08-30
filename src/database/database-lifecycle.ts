import {
  Inject,
  Injectable,
  type OnApplicationShutdown,
  type OnModuleInit,
} from "@nestjs/common";

import { DATABASE, type Database } from "./database.js";
import { migrateToLatest } from "./migrator.js";

@Injectable()
export class DatabaseLifecycle implements OnModuleInit, OnApplicationShutdown {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async onModuleInit(): Promise<void> {
    await migrateToLatest(this.database);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.database.destroy();
  }
}
