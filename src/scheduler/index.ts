import type { ScheduledTask } from 'node-cron';
import cron from 'node-cron';
import type { Config } from '../config/types.ts';
import type { RunJobDeps } from './runJob.ts';
import { runJob } from './runJob.ts';

export { runJob } from './runJob.ts';

/**
 * Register a cron job for every schedule in `config.schedules`.
 *
 * Each task runs in Asia/Jerusalem timezone and uses `runJob` to fetch
 * the route and push the train list to the owner via Signal.
 *
 * @param config  Validated application configuration.
 * @param deps    Injected runtime dependencies (same shape as RunJobDeps).
 * @returns       Array of `ScheduledTask` objects (one per schedule entry).
 *                The caller can call `.stop()` on each task for graceful shutdown.
 */
export function startScheduler(config: Config, deps: RunJobDeps): ScheduledTask[] {
  const tasks: ScheduledTask[] = [];

  for (const schedule of config.schedules) {
    const task = cron.schedule(
      schedule.cron,
      () => {
        // Fire-and-forget: runJob never throws out of its handler.
        void runJob(schedule, config, deps);
      },
      { timezone: 'Asia/Jerusalem' },
    );
    tasks.push(task);
  }

  return tasks;
}
