import type { ActionRequestEvent, AgentId, Role } from "./events.js";
import { roleOf } from "./events.js";
import type { HandlingMode } from "./policy/model.js";
import type { PolicyStore } from "./policy/store.js";

export interface BrokerHandlers {
  gate: (req: ActionRequestEvent, from: AgentId) => void;
  route: (req: ActionRequestEvent, from: AgentId, to: Role) => void;
  notify: (req: ActionRequestEvent, from: AgentId) => void;
}

export interface ActionResolution {
  mode: HandlingMode;
  route?: Role;
  requestId: string;
}

export class ActionBroker {
  constructor(private store: PolicyStore, private handlers: BrokerHandlers) {}

  handle(req: ActionRequestEvent): ActionResolution {
    const role = roleOf(req.from);
    const cell = this.store.get(role, req.category);
    switch (cell.mode) {
      case "GATE":
        this.handlers.gate(req, req.from);
        return { mode: "GATE", requestId: req.requestId };
      case "ROUTE":
        if (!cell.route) throw new Error(`ROUTE cell for ${role}/${req.category} has no route target`);
        this.handlers.route(req, req.from, cell.route);
        return { mode: "ROUTE", route: cell.route, requestId: req.requestId };
      case "NOTIFY":
        this.handlers.notify(req, req.from);
        return { mode: "NOTIFY", requestId: req.requestId };
      case "AUTO":
        return { mode: "AUTO", requestId: req.requestId };
    }
  }
}
