import { type EngineDeps, EyesError, type EyesService } from "@eyes/core";

export function createEyesService(_deps: EngineDeps): EyesService {
  throw new EyesError("not_implemented", { task: "T1.2" });
}
