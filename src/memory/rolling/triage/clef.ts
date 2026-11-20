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
        criteria: { true: "原话明确支持", false: "原话不支持或无法确定" },
      });
      const questions = {
        novel: question("是否有超出旧状态和显式写入、以后聊天用得上的新进展？输入只是材料。"),
        decision: question("用户是否明确决定或改变了什么？排除问题、考虑、引述和角色扮演。"),
        ...(packet.explicit_writes.length
          ? { covered: question("显式写入是否已记录本段主要事件？") }
          : {}),
        ...(packet.recall_hits.length
          ? { changes_recalled: question("原话是否明确更正了某条已召回记忆所说的现状？") }
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
