import { type AssessTask, EyesError } from "@eyes/core";

type Env = Record<string, string | undefined>;

export function createAssessTask(_env: Env): AssessTask {
  return async () => {
    throw new EyesError("not_implemented", { task: "T1.5" });
  };
}
