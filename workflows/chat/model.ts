import type {
  LanguageModelV3,
  LanguageModelV4,
  LanguageModelV4CallOptions,
} from "@ai-sdk/provider";
import type { LanguageModel } from "ai";
import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from "@workflow/serde";
import { scriptedChatModel } from "./mock-model";
import { zaiModel } from "../../lib/model";

/**
 * 0010 spike model factory. The model instance crosses a step boundary
 * (doStreamStep records its arguments), so it must be workflow-
 * serializable — raw provider instances are not. SerializableChatModel
 * carries only the recipe (which model, or "mock") and rebuilds the live
 * instance on deserialization (@workflow/serde's class protocol).
 *
 * Tests swap in the scripted mock via env — SWEATSHOP_CHAT_MOCK holds
 * the script name (plain|approve|steer|hang), double-gated on
 * NODE_ENV=test so dev/prod can never pick it up. mock-model is
 * imported statically: the deserializer and the workflow body share one
 * module instance, which a global-based handoff could not guarantee
 * across the workflow VM boundary. (The mock code rides along in the
 * workflow bundle but is unreachable in dev/prod — split in Phase 4 if
 * it ever matters.)
 */

type ChatModelData = { kind: "zai"; modelId: string } | { kind: "mock" };

/** Structural shape shared by every spec version we wrap (v3: zhipu, v4: mock). */
interface AnyLanguageModel {
  readonly specificationVersion: string;
  readonly provider: string;
  readonly modelId: string;
  readonly supportedUrls?: unknown;
  doGenerate?: (options: never) => unknown;
  doStream: (options: never) => unknown;
}

function buildInner(data: ChatModelData): AnyLanguageModel {
  if (data.kind === "mock") {
    return scriptedChatModel() as unknown as AnyLanguageModel;
  }
  return zaiModel(data.modelId) as unknown as AnyLanguageModel;
}

export class SerializableChatModel {
  readonly data: ChatModelData;
  private readonly inner: AnyLanguageModel;

  constructor(data: ChatModelData, inner?: AnyLanguageModel) {
    this.data = data;
    this.inner = inner ?? buildInner(data);
  }

  get specificationVersion(): "v3" | "v4" {
    return this.inner.specificationVersion as "v3" | "v4";
  }
  get provider() {
    return this.inner.provider;
  }
  get modelId() {
    return this.inner.modelId;
  }
  get supportedUrls() {
    return this.inner.supportedUrls;
  }
  doGenerate(options: LanguageModelV4CallOptions) {
    return this.inner.doGenerate?.(options as never);
  }
  doStream(options: LanguageModelV4CallOptions) {
    return this.inner.doStream(options as never);
  }

  static [WORKFLOW_SERIALIZE](instance: SerializableChatModel) {
    return instance.data;
  }
  static [WORKFLOW_DESERIALIZE](data: ChatModelData) {
    return new SerializableChatModel(data);
  }
}

export async function buildTurnModel(modelId: string): Promise<LanguageModel> {
  if (process.env.SWEATSHOP_CHAT_MOCK && process.env.NODE_ENV === "test") {
    return new SerializableChatModel({ kind: "mock" }) as unknown as LanguageModel;
  }
  return new SerializableChatModel(
    { kind: "zai", modelId },
    zaiModel(modelId) as unknown as AnyLanguageModel,
  ) as unknown as LanguageModel;
}

export type { LanguageModelV3, LanguageModelV4 };
