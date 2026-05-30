import type OpenAI from "openai";

export const TOOL_DEFINITIONS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to the working directory." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file, creating it and any parent directories if needed.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to the working directory." },
          content: { type: "string", description: "Full file content to write." },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files and directories inside a directory.",
      parameters: {
        type: "object",
        properties: {
          dir: { type: "string", description: "Directory path relative to working directory. Defaults to '.'." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "done",
      description: "Signal that the task is complete. Always call this when finished.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Brief description of what was accomplished." },
        },
        required: ["summary"],
      },
    },
  },
];
