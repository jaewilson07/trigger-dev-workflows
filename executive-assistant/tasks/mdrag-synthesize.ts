import { task } from "@trigger.dev/sdk";
import { postMdragPrimitive } from "../lib/mdrag-primitives.js";

/** Mirrors mdrag's `SynthesisFinding` request model — one pre-vetted claim. */
export type SynthesisFinding = {
  claim: string;
  source_url?: string;
};

export type MdragSynthesizePayload = {
  topic: string;
  findings: SynthesisFinding[];
  comparison_axes?: string[];
};

/** Mirrors mdrag's `SynthesizeResponse`. */
export type SynthesizeResult = {
  synthesis: string;
};

export const mdragSynthesize = task({
  id: "mdrag-synthesize",
  retry: { maxAttempts: 2 },
  run: async (payload: MdragSynthesizePayload): Promise<SynthesizeResult> => {
    return postMdragPrimitive<SynthesizeResult>("synthesize", {
      topic: payload.topic,
      findings: payload.findings,
      comparison_axes: payload.comparison_axes ?? [],
    });
  },
});
