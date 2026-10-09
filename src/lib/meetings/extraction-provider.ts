/** The reviewed provider union. Exactly one adapter per approved configuration; no environment default or fallback. */
import {vertexConfigurationHash,type VertexConfig}from'./vertex-extractor.ts';
import {anthropicConfigurationHash,type AnthropicConfig}from'./anthropic-extractor.ts';
export type ExtractionProviderConfig=VertexConfig|AnthropicConfig;
export const providerConfigurationHash=(c:ExtractionProviderConfig)=>c.provider==='anthropic-direct'?anthropicConfigurationHash(c):vertexConfigurationHash(c);
/** Byte floor for an approved configuration: the request body can never exceed this many UTF-8 bytes, so neither can its input tokens. */
export const providerInputTokenCeiling=(c:ExtractionProviderConfig)=>c.maxPromptCharacters;
