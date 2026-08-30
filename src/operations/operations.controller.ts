import {
  Controller,
  Get,
  Header,
  Inject,
  ServiceUnavailableException,
} from "@nestjs/common";
import { sql } from "kysely";

import { DATABASE, type Database } from "../database/database.js";
import { RuntimeMetrics } from "./runtime-metrics.js";

@Controller()
export class OperationsController {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(RuntimeMetrics) private readonly metrics: RuntimeMetrics,
  ) {}

  @Get("health")
  health(): { status: "ok" } {
    return { status: "ok" };
  }

  @Get("ready")
  async ready(): Promise<{ status: "ready" }> {
    try {
      await sql`select 1`.execute(this.database);
      return { status: "ready" };
    } catch {
      throw new ServiceUnavailableException("Database is unavailable");
    }
  }

  @Get("metrics")
  @Header("content-type", "text/plain; version=0.0.4; charset=utf-8")
  metricsText(): string {
    return this.metrics.render();
  }
}
