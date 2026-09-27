import "../config/load-environment.js";
import { createDatabase } from "../database/create-database.js";
import { ActivationReviews } from "../modules/subscription-activation/activation-reviews.js";
import { systemClock } from "../shared/clock.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const [mode, reviewId, ...rest] = process.argv.slice(2);
if (
  !process.env.DATABASE_URL ||
  rest.length > 0 ||
  !(
    (mode === "--list" && reviewId === undefined) ||
    (mode === "--resolve" && reviewId !== undefined && UUID.test(reviewId))
  )
) {
  process.stderr.write(
    "Use --list, or --resolve <reviewId> after the owner decided, with DATABASE_URL.\n",
  );
  process.exitCode = 1;
} else {
  const db = createDatabase(process.env.DATABASE_URL);
  try {
    const reviews = new ActivationReviews(db, systemClock);
    if (mode === "--list")
      for (const review of await reviews.open())
        process.stdout.write(JSON.stringify(review) + "\n");
    else {
      const status = await reviews.resolve(reviewId ?? "");
      process.stdout.write(JSON.stringify({ status }) + "\n");
      if (status === "not_found") process.exitCode = 2;
    }
  } catch {
    process.stderr.write("Activation review command failed.\n");
    process.exitCode = 1;
  } finally {
    await db.destroy();
  }
}
