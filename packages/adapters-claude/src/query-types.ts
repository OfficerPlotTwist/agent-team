import type { SDKMessage, Options } from "@anthropic-ai/claude-agent-sdk";

/** The injectable shape of the SDK `query` function. Real SDK `query` is assignable to this. */
export type QueryFn = (args: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;
