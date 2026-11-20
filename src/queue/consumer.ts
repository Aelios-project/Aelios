import { runDreamJob } from "../memory/dream/jobs";
import { runMemoryRetention } from "../memory/retention";
import type { Env, QueueMessage } from "../types";
import { persistExchange } from "../gateway/record";
import { enqueueRollingWindow, scheduleRollingWindow } from "../memory/rolling/inbox";
import { runRollingWindow } from "../memory/rolling/runner";

export async function handleQueueMessage(message: QueueMessage, env: Env, redelivered = false): Promise<void> {
  switch (message.type) {
    case "gateway_exchange":
      await persistExchange(env, message);
      await scheduleRollingWindow(env, message.namespace);
      return;
    case "rolling_window": {
      const result = await runRollingWindow(env, message.namespace);
      if (result.retryAfter && (result.ran || redelivered)) {
        await enqueueRollingWindow(env, message.namespace, Math.min(result.retryAfter, 43_200));
      } else if (result.ran) {
        await scheduleRollingWindow(env, message.namespace);
      }
      return;
    }
    case "dream_run":
      await runDreamJob(env, message);
      return;
    case "retention":
      await runMemoryRetention(env, message.namespace);
      return;
    default:
      console.warn("queue: unknown message type", (message as { type?: string }).type);
  }
}
