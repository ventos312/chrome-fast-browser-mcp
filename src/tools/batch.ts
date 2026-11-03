import { z } from "zod";
import {
  getPageUpdate,
  getSnapshotBaseline,
  restoreSnapshotBaseline,
  suppressSnapshots,
} from "../utils/accessibility.js";

export interface BatchableTool {
  name: string;
  schema: Record<string, any>;
  handler: (args: any) => Promise<string>;
}

const MAX_STEPS = 50;
const MAX_STEP_OUTPUT = 300;

const summarizeArgs = (args: unknown): string => {
  if (!args || Object.keys(args as object).length === 0) return "";
  const text = JSON.stringify(args);
  return text.length > 100 ? text.slice(0, 100) + "…" : text;
};

/**
 * Build the batch tool from the tools it may run. Each step's own page output
 * is skipped (it would only be discarded), the page is read once at the end,
 * and notes from every step are kept for that final report.
 */
export function createBatchTool(tools: BatchableTool[]) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const names = tools.map((t) => t.name) as [string, ...string[]];

  const def = {
    name: "batch",
    description:
      "Run several tool calls in one round trip, in order, and return the page once at the end. " +
      "Stops at the first failing step. Element refs stay valid across steps on the same page; " +
      "after a navigate step use CSS selectors. Tools allowed: " +
      names.join(", ") +
      ".",
    schema: {
      steps: z
        .array(
          z.object({
            tool: z.enum(names).describe("Tool to call"),
            args: z.record(z.string(), z.any()).optional().describe("Arguments for that tool"),
          })
        )
        .min(1)
        .max(MAX_STEPS)
        .describe("Steps to run in order"),
    },
  };

  async function handler(args: { steps: Array<{ tool: string; args?: Record<string, unknown> }> }): Promise<string> {
    const report: string[] = [];
    let failure: string | null = null;
    const baseline = getSnapshotBaseline();

    await suppressSnapshots(async () => {
      for (const [index, step] of args.steps.entries()) {
        const tool = byName.get(step.tool)!;
        const parsed = z.object(tool.schema).safeParse(step.args ?? {});
        if (!parsed.success) {
          const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; ");
          failure = `step ${index + 1} (${step.tool}) has invalid arguments: ${issues}`;
          break;
        }
        try {
          const output = await tool.handler(parsed.data);
          const detail = output ? `: ${output.length > MAX_STEP_OUTPUT ? output.slice(0, MAX_STEP_OUTPUT) + "…" : output}` : "";
          report.push(`${index + 1}. ${step.tool} ${summarizeArgs(step.args)} ok${detail}`);
        } catch (err: any) {
          failure = `step ${index + 1} (${step.tool}) failed: ${err.message}`;
          break;
        }
      }
    });

    // Report the page relative to what the agent saw before the batch, not to
    // the intermediate steps.
    restoreSnapshotBaseline(baseline);
    const page = await getPageUpdate();
    const lines = [...report, "", page];
    if (failure) {
      throw new Error(
        `Batch stopped: ${failure}. ${report.length} of ${args.steps.length} steps completed.\n` + lines.join("\n")
      );
    }
    return [`Batch: all ${args.steps.length} steps completed.`, ...lines].join("\n");
  }

  return { def, handler };
}
