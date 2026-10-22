import { IntegrationPropertyMap } from "./property";
import { WebhookRenewConfiguration } from "./trigger/trigger";
import { ErrorHandlingOptionsParam } from "./action/action";
import { IntegrationAuthProperty } from "./property/authentication";
import * as z from "zod/mini";
import { LocalesEnum } from "@inboxfm-connect/core-utils";
import { PackageType, PieceCategory, PieceType, TriggerStrategy, TriggerTestStrategy, WebhookHandshakeConfiguration } from "@inboxfm-connect/core-piece-types";
import { ContextVersion } from "./context/versioning";
import type { OutputSchema } from "./output-schema";

const I18nForIntegration = z.optional(z.record(z.string(), z.record(z.string(), z.string())));
export type I18nForIntegration = Partial<Record<LocalesEnum, Record<string, string>>> | undefined
export const IntegrationBase = z.object({
  id: z.optional(z.string()),
  name: z.string(),
  displayName: z.string(),
  logoUrl: z.string(),
  description: z.string(),
  authors: z.array(z.string()),
  platformId: z.optional(z.string()),
  directoryPath: z.optional(z.string()),
  auth: z.optional(z.union([IntegrationAuthProperty, z.array(IntegrationAuthProperty)])),
  version: z.string(),
  categories: z.optional(z.array(z.enum(PieceCategory))),
  minimumSupportedRelease: z.optional(z.string()),
  maximumSupportedRelease: z.optional(z.string()),
  i18n: I18nForIntegration,
})

export type IntegrationBase = {
  id?: string;
  name: string;
  displayName: string;
  logoUrl: string;
  description: string;
  platformId?: string;
  authors: string[],
  directoryPath?: string;
  auth?: IntegrationAuthProperty | IntegrationAuthProperty[];
  version: string;
  categories?: PieceCategory[];
  minimumSupportedRelease?: string;
  maximumSupportedRelease?: string;
  i18n?: Partial<Record<LocalesEnum, Record<string, string>>>
  getContextInfo: (() => { version: ContextVersion }) | undefined;
}


export const Audience = z.enum(['human', 'ai', 'both'])
export type Audience = z.infer<typeof Audience>

export const AiMetadata = z.object({
  description: z.optional(z.string()),
  idempotent: z.optional(z.boolean()),
})
export type AiMetadata = z.infer<typeof AiMetadata>

export const ToolBase = z.object({
  name: z.string(),
  displayName: z.string(),
  description: z.string(),
  props: IntegrationPropertyMap,
  requireAuth: z.boolean(),
  errorHandlingOptions: z.optional(ErrorHandlingOptionsParam),
  outputSchema: z.optional(z.custom<OutputSchema>()),
  audience: z.optional(Audience),
  aiMetadata: z.optional(AiMetadata),
})

export type ToolBase = {
  name: string,
  displayName: string,
  description: string,
  props: IntegrationPropertyMap,
  requireAuth: boolean;
  errorHandlingOptions?: ErrorHandlingOptionsParam;
  outputSchema?: OutputSchema;
  audience?: Audience;
  aiMetadata?: AiMetadata;
}

export const TriggerBase = z.object({
  name: z.string(),
  displayName: z.string(),
  description: z.string(),
  props: IntegrationPropertyMap,
  errorHandlingOptions: z.optional(ErrorHandlingOptionsParam),
  type: z.enum(TriggerStrategy),
  sampleData: z.unknown(),
  handshakeConfiguration: z.optional(z.custom<WebhookHandshakeConfiguration>()),
  renewConfiguration: z.optional(WebhookRenewConfiguration),
  testStrategy: z.enum(TriggerTestStrategy),
  outputSchema: z.optional(z.custom<OutputSchema>()),
  aiMetadata: z.optional(AiMetadata),
})
export type TriggerBase = Omit<ToolBase, 'audience'> & {
  type: TriggerStrategy;
  sampleData: unknown,
  handshakeConfiguration?: WebhookHandshakeConfiguration;
  renewConfiguration?: WebhookRenewConfiguration;
  testStrategy: TriggerTestStrategy;
};

export const IntegrationMetadata = z.object({
  ...IntegrationBase.shape,
  actions: z.record(z.string(), ToolBase),
  triggers: z.record(z.string(), TriggerBase),
})

export type IntegrationMetadata = Omit<IntegrationBase, 'getContextInfo'> & {
  actions: Record<string, ToolBase>;
  triggers: Record<string, TriggerBase>;
  contextInfo: { version: ContextVersion } | undefined;
};

export const IntegrationMetadataSummary = z.object({
  ...IntegrationBase.shape,
  actions: z.number(),
  triggers: z.number(),
  suggestedActions: z.optional(z.array(ToolBase)),
  suggestedTriggers: z.optional(z.array(TriggerBase)),
})
export type IntegrationMetadataSummary = Omit<IntegrationMetadata, "actions" | "triggers"> & {
  actions: number;
  triggers: number;
  suggestedActions?: ToolBase[];
  suggestedTriggers?: TriggerBase[];
}


const IntegrationPackageMetadata = z.object({
  projectUsage: z.number(),
  tags: z.optional(z.array(z.string())),
  pieceType: z.enum(PieceType),
  packageType: z.enum(PackageType),
  platformId: z.optional(z.string()),
  archiveId: z.optional(z.string()),
})
type IntegrationPackageMetadata = z.infer<typeof IntegrationPackageMetadata>

export const IntegrationMetadataModel = z.object({
  ...IntegrationMetadata.shape,
  ...IntegrationPackageMetadata.shape,
})
export type IntegrationMetadataModel = IntegrationMetadata & IntegrationPackageMetadata

export const IntegrationMetadataModelSummary = z.object({
  ...IntegrationMetadataSummary.shape,
  ...IntegrationPackageMetadata.shape,
})
export type IntegrationMetadataModelSummary = IntegrationMetadataSummary & IntegrationPackageMetadata;

export const IntegrationPackageInformation = z.object({
  name: z.string(),
  version: z.string(),
})
export type IntegrationPackageInformation = z.infer<typeof IntegrationPackageInformation>
