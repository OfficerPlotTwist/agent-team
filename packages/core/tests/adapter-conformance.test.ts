import { runAdapterConformance } from "./adapter-conformance.js";
import { FakeAdapter } from "../src/fake-adapter.js";

runAdapterConformance("FakeAdapter", () =>
  new FakeAdapter([
    { kind: "message", to: "all", text: "working" },
    { kind: "done", summary: "finished" },
  ]),
);
