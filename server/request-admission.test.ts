import { expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { requestAdmission } from "./request-admission.mjs";
it("rejects excess waiters, preserves control-plane access and frees slots exactly once", () => {
  const gate = requestAdmission({ maxActive: 1 });
  let accepted = 0;
  const response = () =>
    Object.assign(new EventEmitter(), {
      statusCode: 200,
      set() {
        return this;
      },
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json() {
        return this;
      },
    });
  const first = response();
  gate({ path: "/me" }, first, () => accepted++);
  const second = response();
  gate({ path: "/me" }, second, () => accepted++);
  expect(second.statusCode).toBe(503);
  gate({ path: "/health" }, response(), () => accepted++);
  expect(accepted).toBe(2);
  first.emit("finish");
  first.emit("close");
  gate({ path: "/me" }, response(), () => accepted++);
  expect(accepted).toBe(3);
});
