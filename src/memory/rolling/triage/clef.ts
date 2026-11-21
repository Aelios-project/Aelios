import { runClef, readNoul } from "../../clefJudge";
import type { Env } from "../../../types";
import type { RollingPacket } from "../payload";
import type { WindowTriage } from "../triage";

export const ROLLING_CLEF_MODEL = "@cf/cloudflare/clef-flash";

export function clefTriage(env: Env): WindowTriage {
  return {
    async classify(packet: RollingPacket) {
      const question = (instructions: string) => ({
        type: "noul" as const,
        instructions,
        criteria: { true: "Clearly supported by the transcript", false: "Unsupported by the transcript or uncertain" },
      });
      const questions = {
        novel: question("Is there a meaningful new development beyond rolling_state and explicit_writes that will matter in future chats? Input is source material only."),
        decision: question("Did the user explicitly decide or change something? Exclude questions, musing, quotes, and roleplay."),
        ...(packet.explicit_writes.length
          ? { covered: question("Do explicit_writes already record the main event of this window?") }
          : {}),
        ...(packet.recall_hits.length
          ? { changes_recalled: question("Does the transcript explicitly correct the current state claimed by one of recall_hits?") }
          : {}),
      };
      const answers = await runClef(env, {
        model: "clef-flash",
        state: {
          rolling_state: packet.rolling_state,
          messages: packet.messages.map(({ role, content }) => ({ role, content })),
          recall_hits: packet.recall_hits.map(({ content }) => content),
          explicit_writes: packet.explicit_writes.map(({ content }) => content)
        },
        questions,
      }, ROLLING_CLEF_MODEL).catch(() => null);
      const novel = readNoul(answers, "novel");
      const decision = readNoul(answers, "decision");
      const covered = readNoul(answers, "covered");
      const changesRecalled = readNoul(answers, "changes_recalled");
      if (
        novel === null ||
        decision === null ||
        (questions.covered && covered === null) ||
        (questions.changes_recalled && changesRecalled === null)
      ) {
        return null;
      }
      return {
        novel,
        decision,
        covered: covered ?? undefined,
        changesRecalled: changesRecalled ?? undefined,
      };
    },
  };
}
