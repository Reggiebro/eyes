import { EyesError, type VerifySubmission, type Vision } from "@eyes/core";

type Env = Record<string, string | undefined>;

export const verifySubmission: VerifySubmission = async () => {
  throw new EyesError("not_implemented", { task: "T2.2" });
};

export function createClaudeVision(_env: Env): Vision {
  throw new EyesError("not_implemented", { task: "T2.2" });
}
