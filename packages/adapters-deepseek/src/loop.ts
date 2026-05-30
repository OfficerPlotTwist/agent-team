import type OpenAI from "openai";
import type { TaskContext, Emit } from "@agent-team/core";
import { TOOL_DEFINITIONS } from "./tool-defs.js";
import { ToolExecutor } from "./tool-executor.js";

export async function runLoop(
  ctx: TaskContext,
  emit: Emit,
  client: OpenAI,
  model: string,
  maxTurns: number,
  isInterrupted: () => boolean,
): Promise<void> {
  const executor = new ToolExecutor();
  const cwd = ctx.cwd ?? process.cwd();

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: `You are a ${ctx.role} agent. Goal: ${ctx.goal}. Working directory: ${cwd}. Use tools to accomplish the goal, then call done() when finished.`,
    },
    { role: "user", content: "Begin." },
  ];

  for (let turn = 0; turn < maxTurns; turn++) {
    if (isInterrupted()) {
      emit({ kind: "error", from: ctx.agentId, message: "interrupted" });
      return;
    }

    let response: OpenAI.Chat.ChatCompletion;
    try {
      response = await client.chat.completions.create({
        model,
        messages,
        tools: TOOL_DEFINITIONS,
        tool_choice: "auto",
      });
    } catch (err) {
      emit({ kind: "error", from: ctx.agentId, message: `api error: ${String(err)}` });
      return;
    }

    const choice = response.choices[0];
    if (!choice) {
      emit({ kind: "error", from: ctx.agentId, message: "no choices in response" });
      return;
    }

    const msg = choice.message;
    messages.push(msg);

    if (!msg.tool_calls?.length) {
      // Model stopped without calling a tool — treat as successful completion
      emit({ kind: "done", from: ctx.agentId, summary: msg.content ?? "" });
      return;
    }

    for (const toolCall of msg.tool_calls) {
      if (isInterrupted()) {
        emit({ kind: "error", from: ctx.agentId, message: "interrupted" });
        return;
      }

      const name = toolCall.function.name;
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
      } catch {
        args = {};
      }

      if (name === "done") {
        emit({ kind: "done", from: ctx.agentId, summary: String(args["summary"] ?? "") });
        return;
      }

      const { result, events } = executor.execute(name, args, cwd, ctx.agentId);
      for (const event of events) emit(event);

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result,
      });
    }
  }

  emit({ kind: "error", from: ctx.agentId, message: `budget: exceeded ${maxTurns} turns` });
}
